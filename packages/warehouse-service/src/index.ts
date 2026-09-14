import type { Pool } from "pg";
import { withTenant } from "@alltix/db";
import type { PicklistLineStatus, PicklistStatus } from "@alltix/shared";
import {
  createAmazonConnectorFromChannelConnection,
  createShopifyConnectorFromChannelConnection,
  createWalmartConnectorFromChannelConnection,
  type TrackingInfo,
} from "@alltix/channel-connectors";
import type { OrderService } from "@alltix/order-service";

export interface PicklistLine {
  id: string;
  orderLineId: string;
  productId: string;
  locationId: string;
  quantityRequested: number;
  quantityPicked: number;
  status: PicklistLineStatus;
}

export interface Picklist {
  id: string;
  tenantId: string;
  locationId: string;
  status: PicklistStatus;
  assignedTo: string | null;
  orderIds: string[];
  lines: PicklistLine[];
}

/**
 * Owns picklists, packing, and shipment confirmation back to channels
 * (CLAUDE.md §1). Persists picklists as their own stateful entity
 * (picklists/picklist_lines, migration 0013) rather than deriving them from
 * orders/order_lines on the fly -- picking has real-world state (open ->
 * assigned -> completed) independent of the order's own state, and per
 * CLAUDE.md §2.2's event-sourced-ledger philosophy a workflow record like
 * this should be a first-class row, not reconstructed from other tables
 * each time.
 *
 * Every order-status change (allocated -> picking -> packed -> shipped)
 * goes through the injected {@link OrderService}'s own transition()/
 * state-machine, not a second copy of that logic here -- this service owns
 * picking-specific state (picklists/picklist_lines) and the physical-world
 * side effects (inventory adjustments, channel shipment confirmation), and
 * asks OrderService to make the resulting state change once that work is
 * done, the same "one module owns the order state machine" split CLAUDE.md
 * §1 already draws between Order Management and Warehouse/Fulfillment.
 *
 * KITTING/BUNDLING (CLAUDE.md §1's stated Warehouse/Fulfillment scope) is
 * NOT implemented here and is out of scope for this pass: products and
 * order_lines have no bundle/kit concept at all today (no BOM/component
 * table -- see packages/db/migrations/0003_products.sql,
 * 0008_order_lines.sql). A picklist line here always maps 1:1 to an
 * order_line's single product_id. Adding kits is a schema change (at
 * minimum a kit-components table linking one product to N component
 * products/quantities) that has to happen before this service can pick a
 * kit's components instead of a single nonexistent "kit SKU" in inventory.
 */
export class WarehouseService {
  constructor(
    private readonly pool: Pool,
    private readonly orderService: OrderService,
  ) {}

  /**
   * Generates one picklist per distinct location among `orderIds`' lines
   * (in practice one, today -- allocateOrder() only ever reserves against a
   * single tenant warehouse location -- but this doesn't assume that will
   * always be true). Every input order must be 'allocated'; each is locked
   * (FOR UPDATE) and checked before anything is written, so a bad orderId
   * in the batch fails the whole call rather than half-generating a
   * picklist.
   *
   * A line's location comes from the inventory_events 'reservation' row
   * allocateOrder() wrote for it (matched via its idempotency_key,
   * `order-allocation:<order_id>:<order_line_id>` -- the same key
   * allocateOrder() itself uses, so this is reading the real fact of where
   * that reservation happened, not re-deriving "the tenant's warehouse"
   * independently and risking drift from what was actually reserved).
   *
   * Picklist/picklist_lines rows are committed in one transaction; each
   * covered order's allocated -> picking transition happens afterward, in
   * its own transaction per order via OrderService.transition() -- same
   * reasoning as persistPulledOrders() in order-service: allocateOrder()
   * runs on a different connection, and until this transaction commits,
   * that connection's MVCC snapshot can't see the picklist rows this one
   * just inserted (not that allocateOrder() needs to see them, but the
   * general rule -- don't call into a second withTenant() from inside this
   * one's transaction -- still applies).
   *
   * An order with zero order_lines is transitioned to 'picking' directly
   * (vacuously nothing to pick), mirroring allocateOrder()'s "zero lines is
   * vacuously fine" precedent.
   */
  async generatePicklist(tenantId: string, orderIds: string[]): Promise<Picklist[]> {
    interface LineWithLocation {
      orderId: string;
      orderLineId: string;
      productId: string;
      quantity: number;
      locationId: string;
    }

    const picklists = await withTenant(this.pool, tenantId, async (client) => {
      for (const orderId of orderIds) {
        const result = await client.query<{ status: string }>(
          `SELECT status FROM orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
          [orderId, tenantId],
        );
        const row = result.rows[0];
        if (!row) {
          throw new Error(`Order ${orderId} not found for tenant ${tenantId}`);
        }
        if (row.status !== "allocated") {
          throw new Error(
            `Order ${orderId} is in status '${row.status}', not 'allocated' -- cannot generate a picklist for it`,
          );
        }
      }

      const linesWithLocation: LineWithLocation[] = [];

      for (const orderId of orderIds) {
        const lines = await client.query<{ id: string; product_id: string; quantity: number }>(
          `SELECT id, product_id, quantity FROM order_lines WHERE order_id = $1 AND tenant_id = $2`,
          [orderId, tenantId],
        );

        // Zero-line order: nothing to pick. Not added to any picklist here
        // -- it's still transitioned to 'picking' below along with every
        // other input order, mirroring allocateOrder()'s "zero lines is
        // vacuously fine" precedent.
        if (lines.rows.length === 0) {
          continue;
        }

        for (const line of lines.rows) {
          const reservation = await client.query<{ location_id: string }>(
            `SELECT location_id FROM inventory_events
              WHERE tenant_id = $1 AND event_type = 'reservation' AND idempotency_key = $2`,
            [tenantId, `order-allocation:${orderId}:${line.id}`],
          );
          const locationId = reservation.rows[0]?.location_id;
          if (!locationId) {
            throw new Error(
              `No reservation event found for order ${orderId} line ${line.id} -- cannot determine pick location`,
            );
          }
          linesWithLocation.push({
            orderId,
            orderLineId: line.id,
            productId: line.product_id,
            quantity: line.quantity,
            locationId,
          });
        }
      }

      const byLocation = new Map<string, LineWithLocation[]>();
      for (const line of linesWithLocation) {
        const existing = byLocation.get(line.locationId) ?? [];
        existing.push(line);
        byLocation.set(line.locationId, existing);
      }

      const picklists: Picklist[] = [];
      for (const [locationId, lines] of byLocation) {
        const picklistResult = await client.query<{ id: string }>(
          `INSERT INTO picklists (tenant_id, location_id, status) VALUES ($1, $2, 'open') RETURNING id`,
          [tenantId, locationId],
        );
        const picklistId = picklistResult.rows[0]!.id;

        const picklistLines: PicklistLine[] = [];
        for (const line of lines) {
          const lineResult = await client.query<{ id: string }>(
            `INSERT INTO picklist_lines (tenant_id, picklist_id, order_line_id, product_id, quantity_requested)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [tenantId, picklistId, line.orderLineId, line.productId, line.quantity],
          );
          picklistLines.push({
            id: lineResult.rows[0]!.id,
            orderLineId: line.orderLineId,
            productId: line.productId,
            locationId,
            quantityRequested: line.quantity,
            quantityPicked: 0,
            status: "pending",
          });
        }

        picklists.push({
          id: picklistId,
          tenantId,
          locationId,
          status: "open",
          assignedTo: null,
          orderIds: [...new Set(lines.map((l) => l.orderId))],
          lines: picklistLines,
        });
      }

      return picklists;
    });

    const distinctOrderIds = [...new Set(orderIds)];
    for (const orderId of distinctOrderIds) {
      await this.orderService.transition(tenantId, orderId, "allocated", "picking");
    }

    return picklists;
  }

  /**
   * Claims an open picklist for one picker. The concurrency case this
   * guards against: two pickers both open the same picklist and tap
   * "start" around the same time -- only one may win. Uses the same
   * guarded-UPDATE pattern as OrderService.simpleTransition() (a
   * `WHERE status = 'open'` clause is the concurrency guard: whichever
   * request's UPDATE commits first flips the row to 'assigned', so the
   * second request's UPDATE matches zero rows and fails loudly instead of
   * silently overwriting the first picker's assignment).
   */
  async assignPicklist(tenantId: string, picklistId: string, pickerId: string): Promise<void> {
    await withTenant(this.pool, tenantId, async (client) => {
      const result = await client.query(
        `UPDATE picklists SET status = 'assigned', assigned_to = $1, updated_at = now()
          WHERE id = $2 AND tenant_id = $3 AND status = 'open'`,
        [pickerId, picklistId, tenantId],
      );
      if (result.rowCount === 0) {
        throw new Error(`Picklist ${picklistId} is not 'open' -- refusing assignment (already assigned?)`);
      }
    });
  }

  /**
   * Records what a picker actually pulled for one picklist line -- the
   * real-world outcome, which packOrder() later reconciles against the
   * ledger. `damaged: true` distinguishes "found it, but it's broken" from
   * a plain shortfall (missing/miscounted stock); packOrder() logs a
   * `damage` vs `adjustment` inventory_events entry accordingly (CLAUDE.md
   * §2.2). Requires the picklist to be 'assigned' (someone must have
   * claimed it before recording picks against it).
   */
  async recordPick(
    tenantId: string,
    picklistLineId: string,
    quantityPicked: number,
    damaged: boolean = false,
  ): Promise<void> {
    await withTenant(this.pool, tenantId, async (client) => {
      const lineResult = await client.query<{ picklist_id: string; quantity_requested: number }>(
        `SELECT picklist_id, quantity_requested FROM picklist_lines WHERE id = $1 AND tenant_id = $2`,
        [picklistLineId, tenantId],
      );
      const line = lineResult.rows[0];
      if (!line) {
        throw new Error(`Picklist line ${picklistLineId} not found for tenant ${tenantId}`);
      }

      const picklistResult = await client.query<{ status: string }>(
        `SELECT status FROM picklists WHERE id = $1 AND tenant_id = $2`,
        [line.picklist_id, tenantId],
      );
      if (picklistResult.rows[0]?.status !== "assigned") {
        throw new Error(`Picklist ${line.picklist_id} is not 'assigned' -- cannot record picks against it`);
      }

      const status: PicklistLineStatus = damaged
        ? "damaged"
        : quantityPicked >= line.quantity_requested
          ? "picked"
          : "short";

      await client.query(
        `UPDATE picklist_lines SET quantity_picked = $1, status = $2, updated_at = now()
          WHERE id = $3 AND tenant_id = $4`,
        [quantityPicked, status, picklistLineId, tenantId],
      );
    });
  }

  /**
   * Resolves one order's picking outcome into 'packed': every picklist_line
   * belonging to this order's order_lines must already be recorded (not
   * 'pending' -- packing can't happen mid-pick). For any line that came up
   * short (quantity_picked < quantity_requested), inserts a real
   * inventory_events entry -- 'damage' if the line was marked damaged,
   * 'adjustment' otherwise -- instead of silently treating the requested
   * and picked quantities as if they matched (CLAUDE.md §2.2). That event
   * both corrects on_hand (the phantom unit(s) were never physically
   * there) and releases the matching amount of `reserved` (this order isn't
   * going to ship what was never really available), so `available` is
   * unaffected -- the shortfall was never really available stock to begin
   * with, this just makes the ledger admit it.
   *
   * If every line on the owning picklist(s) is now resolved, marks the
   * picklist 'completed'. Then transitions this order 'picking' -> 'packed'
   * via OrderService.
   *
   * OPEN PRODUCT DECISION (not implemented, flagged rather than silently
   * skipped -- same treatment as the kitting/bundling gap on this class's
   * own doc comment): a short-picked line only corrects the ledger here. It
   * does not trigger any backorder or split-shipment handling -- the order
   * proceeds straight to 'packed' and will ship only what was actually
   * picked, with no record anywhere that the customer is now owed the
   * missing quantity. Whether a shortfall should instead spin off a
   * backorder for the difference, hold the whole order, or something else
   * is a real product decision that needs making before this reaches a
   * seller who cares about it.
   */
  async packOrder(tenantId: string, orderId: string): Promise<void> {
    const affectedPicklistIds = await withTenant(this.pool, tenantId, async (client) => {
      const lines = await client.query<{
        id: string;
        picklist_id: string;
        product_id: string;
        quantity_requested: number;
        quantity_picked: number;
        status: PicklistLineStatus;
      }>(
        `SELECT pl.id, pl.picklist_id, pl.product_id, pl.quantity_requested, pl.quantity_picked, pl.status
           FROM picklist_lines pl
           JOIN order_lines ol ON ol.id = pl.order_line_id
          WHERE ol.order_id = $1 AND pl.tenant_id = $2`,
        [orderId, tenantId],
      );

      if (lines.rows.length === 0) {
        // No picklist lines at all -- either a zero-line order (already
        // moved straight to 'picking' by generatePicklist()) or one that
        // was never put on a picklist. Nothing to reconcile either way.
        return [];
      }

      const pending = lines.rows.filter((l) => l.status === "pending");
      if (pending.length > 0) {
        throw new Error(
          `Order ${orderId} has ${pending.length} picklist line(s) not yet picked -- cannot pack until every line is recorded`,
        );
      }

      const picklistId = lines.rows[0]!.picklist_id;
      const locationResult = await client.query<{ location_id: string }>(
        `SELECT location_id FROM picklists WHERE id = $1 AND tenant_id = $2`,
        [picklistId, tenantId],
      );
      const locationId = locationResult.rows[0]?.location_id;
      if (!locationId) {
        throw new Error(`Picklist ${picklistId} not found for tenant ${tenantId}`);
      }

      for (const line of lines.rows) {
        const shortfall = line.quantity_requested - line.quantity_picked;
        if (shortfall <= 0) continue;

        await client.query(
          `INSERT INTO inventory_events
             (tenant_id, product_id, location_id, event_type, quantity_delta, reference_type, reference_id, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, 'order', $6, $7)`,
          [
            tenantId,
            line.product_id,
            locationId,
            line.status === "damaged" ? "damage" : "adjustment",
            -shortfall,
            orderId,
            `pack-shortfall:${orderId}:${line.id}`,
          ],
        );
        await client.query(
          `UPDATE inventory_levels SET on_hand = on_hand - $1, reserved = reserved - $1, updated_at = now()
             WHERE product_id = $2 AND location_id = $3`,
          [shortfall, line.product_id, locationId],
        );
      }

      return [...new Set(lines.rows.map((l) => l.picklist_id))];
    });

    for (const picklistId of affectedPicklistIds) {
      await this.maybeCompletePicklist(tenantId, picklistId);
    }

    await this.orderService.transition(tenantId, orderId, "picking", "packed");
  }

  /** Marks a picklist 'completed' once every one of its lines is resolved
   *  (not 'pending'). Safe to call speculatively -- a picklist covering
   *  multiple orders only completes once every order's lines are done. */
  private async maybeCompletePicklist(tenantId: string, picklistId: string): Promise<void> {
    await withTenant(this.pool, tenantId, async (client) => {
      const pending = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM picklist_lines WHERE picklist_id = $1 AND tenant_id = $2 AND status = 'pending'`,
        [picklistId, tenantId],
      );
      if (Number(pending.rows[0]!.count) > 0) return;

      await client.query(
        `UPDATE picklists SET status = 'completed', updated_at = now() WHERE id = $1 AND tenant_id = $2 AND status = 'assigned'`,
        [picklistId, tenantId],
      );
    });
  }

  /**
   * packed -> shipped: confirms shipment with the order's channel first
   * (a network call, deliberately made before any local state change --
   * same "don't mark it done locally until the outside system actually
   * confirms it" reasoning as calling the channel before touching orders
   * elsewhere in this codebase), then transitions the order via
   * OrderService only once that call succeeds. If the channel call fails,
   * the order stays 'packed' and this throws -- there is no partial state
   * where an order is 'shipped' locally but the channel was never told.
   *
   * 'amazon' (AmazonConnector.confirmShipment(), verified live against the
   * sandbox -- see its doc comment for the sandbox-has-no-matching-scenario
   * caveat), 'shopify' (ShopifyConnector.confirmShipment(), verified live
   * against a real dev store -- see CLAUDE.md §4.5), and 'walmart'
   * (WalmartConnector.confirmShipment(), UNVERIFIED IN PRACTICE -- wired the
   * same way as the other two, but see CLAUDE.md §4.2 and
   * WalmartConnector's own class doc comment for why nothing has actually
   * round-tripped against Walmart's live API yet) are wired to real
   * connectors today. Any other channel throws a clear "not implemented"
   * error rather than silently skipping the channel call and transitioning
   * anyway.
   */
  async confirmShipment(tenantId: string, orderId: string, tracking: TrackingInfo): Promise<void> {
    const order = await withTenant(this.pool, tenantId, async (client) => {
      const result = await client.query<{ channel: string; external_order_id: string; status: string }>(
        `SELECT channel, external_order_id, status FROM orders WHERE id = $1 AND tenant_id = $2`,
        [orderId, tenantId],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error(`Order ${orderId} not found for tenant ${tenantId}`);
      }
      return row;
    });

    if (order.status !== "packed") {
      throw new Error(`Order ${orderId} is in status '${order.status}', not 'packed' -- cannot confirm shipment`);
    }

    if (order.channel === "amazon") {
      const connector = await createAmazonConnectorFromChannelConnection(this.pool, tenantId);
      await connector.confirmShipment(order.external_order_id, tracking);
    } else if (order.channel === "shopify") {
      const connector = await createShopifyConnectorFromChannelConnection(this.pool, tenantId);
      await connector.confirmShipment(order.external_order_id, tracking);
    } else if (order.channel === "walmart") {
      const connector = await createWalmartConnectorFromChannelConnection(this.pool, tenantId);
      await connector.confirmShipment(order.external_order_id, tracking);
    } else {
      throw new Error(
        `WarehouseService.confirmShipment: channel '${order.channel}' has no connector wired for shipment confirmation yet`,
      );
    }

    await this.orderService.transition(tenantId, orderId, "packed", "shipped");
  }
}
