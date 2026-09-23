import type { Pool, PoolClient } from "pg";
import { withTenant, recordAuditEvent } from "@alltix/db";
import {
  DomainEvent,
  InProcessEventBus,
  type DomainEventName,
  type EventBus,
  type OrderSplitForBackorderPayload,
  type PicklistLineStatus,
  type PicklistStatus,
} from "@alltix/shared";
import {
  createAmazonConnectorFromChannelConnection,
  createShopifyConnectorFromChannelConnection,
  createWalmartConnectorFromChannelConnection,
  createEbayConnectorFromChannelConnection,
  createTemuConnectorFromChannelConnection,
  createTikTokConnectorFromChannelConnection,
  type TrackingInfo,
} from "@alltix/channel-connectors";
import type { OrderService } from "@alltix/order-service";
import { InventoryService } from "@alltix/inventory-service";

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

/** One short-picked order_line, as packOrder() found it -- enough for
 *  spinOffBackorder() to either insert a brand-new line on the backorder
 *  order (a partial pick, quantityPicked > 0: the original order_line stays
 *  put, already reduced to quantityPicked by the time spinOffBackorder() is
 *  called) or re-parent this order_line onto it wholesale (nothing picked
 *  at all, quantityPicked === 0). See packOrder()'s own SHORT-PICK SPLIT
 *  doc comment, and spinOffBackorder()'s, for why those are different
 *  operations rather than always insert-a-new-line. */
interface ShortLine {
  orderLineId: string;
  productId: string;
  unitPrice: string;
  fulfillmentType: string;
  shortfall: number;
  quantityPicked: number;
}

interface BackorderResult {
  orderId: string;
  lines: Array<{ productId: string; quantity: number }>;
}

/**
 * Inserts the brand-new backordered order that packOrder()'s SHORT-PICK
 * SPLIT spins off for `orderId`'s shortfall, then gives it each short
 * line's missing quantity -- either as a fresh order_lines row (a partial
 * pick) or by re-parenting the original order_line onto it wholesale
 * (nothing picked at all) -- see the per-line comment below for why those
 * are different operations. See packOrder()'s own doc comment for the
 * broader reasoning (why this is a real order, why its external_order_id is
 * derived rather than channel-supplied, why it skips
 * OrderService.persistPulledOrders()'s usual ingestion pipeline). A free
 * function taking the already-open transaction's `client` directly (not a
 * WarehouseService method) since it has no need of `this` and every caller
 * already holds the same client packOrder() itself is using -- keeping it
 * out of the class body makes that "runs inside the caller's transaction,
 * never opens its own" contract impossible to get wrong by accident.
 */
async function spinOffBackorder(
  client: PoolClient,
  tenantId: string,
  orderId: string,
  shortLines: ShortLine[],
): Promise<BackorderResult> {
  const orderRow = await client.query<{
    channel: string;
    external_order_id: string;
    customer: Record<string, unknown> | null;
    shipping_address: Record<string, unknown> | null;
    placed_at: string | null;
    preferred_location_id: string | null;
  }>(
    `SELECT channel, external_order_id, customer, shipping_address, placed_at, preferred_location_id
       FROM orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [orderId, tenantId],
  );
  const original = orderRow.rows[0];
  if (!original) {
    throw new Error(`Order ${orderId} not found for tenant ${tenantId}`);
  }

  const backorderInsert = await client.query<{ id: string }>(
    `INSERT INTO orders
       (tenant_id, channel, external_order_id, status, customer, shipping_address, placed_at,
        preferred_location_id, split_from_order_id)
     VALUES ($1, $2, $3, 'backordered', $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      tenantId,
      original.channel,
      `${original.external_order_id}:backorder`,
      JSON.stringify(original.customer),
      JSON.stringify(original.shipping_address),
      original.placed_at,
      original.preferred_location_id,
      orderId,
    ],
  );
  const backorderOrderId = backorderInsert.rows[0]!.id;

  for (const shortLine of shortLines) {
    if (shortLine.quantityPicked > 0) {
      // Partial pick: packOrder() already reduced the original order_line's
      // own quantity down to quantityPicked, so the shortfall needs a
      // brand-new line here.
      await client.query(
        `INSERT INTO order_lines (tenant_id, order_id, product_id, quantity, unit_price, fulfillment_type)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenantId, backorderOrderId, shortLine.productId, shortLine.shortfall, shortLine.unitPrice, shortLine.fulfillmentType],
      );
    } else {
      // Nothing was picked at all -- re-parent the EXISTING order_line onto
      // the backorder rather than delete-and-reinsert. order_lines.quantity
      // has a CHECK (quantity > 0), so the original row can't be reduced to
      // zero in place; and picklist_lines.order_line_id is a NOT NULL FK
      // with no ON DELETE behavior (deliberately -- a picklist's own audit
      // record, migration 0013, must never be able to vanish just because
      // the order_line it graded got tidied up later), so the row can't be
      // deleted either once it's been picked against. Re-parenting keeps
      // that FK intact, preserves the order_line's own id/history (still
      // reachable from the *backorder* order's detail page, telling that
      // order's own real history: "spun off after a picking attempt found
      // nothing here"), and needs no separate INSERT -- its existing
      // quantity is already exactly the shortfall, since nothing was picked
      // means shortfall === the original requested quantity.
      await client.query(`UPDATE order_lines SET order_id = $1 WHERE id = $2 AND tenant_id = $3`, [
        backorderOrderId,
        shortLine.orderLineId,
        tenantId,
      ]);
    }
  }

  return {
    orderId: backorderOrderId,
    lines: shortLines.map((l) => ({ productId: l.productId, quantity: l.shortfall })),
  };
}

/**
 * THE MISSING SALE CONSUMPTION FIX: until this existed, a normal,
 * fully-picked, successfully-shipped order never actually consumed
 * inventory -- packOrder()'s own ledger correction only ever runs for a
 * SHORT line (see its own doc comment and the "a full pick makes no ledger
 * correction" test in test/generate-and-pick.test.ts, which is correct and
 * unaffected by this change: packOrder() still shouldn't touch the ledger
 * for a fully-picked line, because the unit hasn't actually left the
 * building yet at that point -- packed, not shipped). InventoryService's
 * own eventType table has always defined 'sale' for exactly this
 * (on_hand += delta AND reserved += delta together), but nothing in the
 * real order lifecycle ever called it -- on_hand silently never dropped for
 * a shipped order, and `reserved` stayed permanently stuck at the allocated
 * amount forever, both drifting further from reality with every order that
 * shipped normally.
 *
 * Called from confirmShipment() once the channel has actually confirmed
 * shipment and before the local 'packed' -> 'shipped' transition -- the
 * unit is being recorded as consumed at the moment this codebase considers
 * it truly gone (confirmed shipped), not merely packed and still sitting in
 * a box on a shelf.
 *
 * One order_line at a time, mirroring generatePicklist()'s own per-line
 * reservation lookup: each line's location comes from the SAME
 * 'reservation' inventory_events row allocateOrder() wrote for it
 * (idempotency_key `order-allocation:<order_id>:<order_line_id>`) -- not a
 * fresh lookup -- so a sale is recorded at the exact location that unit was
 * actually reserved from and picked from, never a different location the
 * order happens to touch. `order_lines.quantity` is read fresh (not the
 * original allocation quantity) specifically because packOrder()'s
 * short-pick handling may already have reduced it -- a partially-short line
 * only ever sells what was actually picked and packed, the same "this order
 * really is going to ship that many, no more" quantity packOrder() itself
 * settled on.
 *
 * Idempotent via InventoryService.recordInventoryEvent's own
 * idempotency_key uniqueness (`order-sale:<order_id>:<order_line_id>`) --
 * safe to call twice for the same order without double-consuming stock.
 *
 * A zero-line order (never allocated against anything, see
 * allocateOrder()'s own "vacuously allocatable" comment) has nothing to
 * iterate here and is a correct no-op. Exported (not a private
 * WarehouseService method) so it can be tested directly against a seeded
 * order/reservation/inventory_levels state without needing a real,
 * successful confirmShipment() call -- which needs a live, successfully-
 * confirming marketplace connection this repo doesn't have for any channel
 * yet (see confirmShipment()'s own doc comment) -- same "exported for
 * testability, real callers use the wrapping method" precedent
 * packages/scheduler/src/index.ts's recordSyncFailure/recordSyncSuccess
 * already set.
 */
export async function recordShipmentSaleEvents(
  pool: Pool,
  inventoryService: InventoryService,
  tenantId: string,
  orderId: string,
): Promise<void> {
  const lines = await withTenant(pool, tenantId, (client) =>
    client.query<{ id: string; product_id: string; quantity: number }>(
      `SELECT id, product_id, quantity FROM order_lines WHERE order_id = $1 AND tenant_id = $2`,
      [orderId, tenantId],
    ),
  );

  for (const line of lines.rows) {
    const reservation = await withTenant(pool, tenantId, (client) =>
      client.query<{ location_id: string }>(
        `SELECT location_id FROM inventory_events
          WHERE tenant_id = $1 AND event_type = 'reservation' AND idempotency_key = $2`,
        [tenantId, `order-allocation:${orderId}:${line.id}`],
      ),
    );
    const locationId = reservation.rows[0]?.location_id;
    if (!locationId) {
      throw new Error(
        `No reservation event found for order ${orderId} line ${line.id} -- cannot record a sale without knowing which location it shipped from`,
      );
    }

    await inventoryService.recordInventoryEvent({
      tenantId,
      productId: line.product_id,
      locationId,
      eventType: "sale",
      quantityDelta: -line.quantity,
      referenceType: "order",
      referenceId: orderId,
      idempotencyKey: `order-sale:${orderId}:${line.id}`,
    });
  }
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
  // Not injected via the constructor the way OrderService/eventBus are --
  // InventoryService holds no state beyond the pool reference and its own
  // eventBus (same as this class's own relationship to `pool`/`eventBus`),
  // so there's nothing a caller would ever need to substitute for it the
  // way a test substitutes a shared eventBus; see
  // recordShipmentSaleEvents()'s own doc comment for why the function it's
  // threaded into is exported standalone instead, for testing without a
  // live confirmShipment() call.
  private readonly inventoryService: InventoryService;

  constructor(
    private readonly pool: Pool,
    private readonly orderService: OrderService,
    // Same default-to-a-private-in-process-bus shape as OrderService's own
    // constructor (packages/order-service/src/index.ts) -- fine for the
    // same reason services.ts's getWarehouseService() doc comment already
    // gives for not sharing OrderService's bus here: none of this class's
    // own publishes (OrderBackordered/OrderCancelled/OrderSplitForBackorder
    // from packOrder()'s short-pick split, see its doc comment) need a
    // subscriber today. A real caller that wants RulesEngine or reporting
    // to see these can inject a shared bus later without any other change.
    private readonly eventBus: EventBus = new InProcessEventBus(),
  ) {
    // Shares this same bus, not a second private one -- InventoryService's
    // own `inventory.changed` publish (from recordInventoryEvent(), which
    // recordShipmentSaleEvents() calls during packOrder()'s sale
    // consumption -- CLAUDE.md §2.2) lands on whatever bus this
    // WarehouseService was given, exactly like a real caller sharing one
    // bus across OrderService/RulesEngine already does elsewhere.
    this.inventoryService = new InventoryService(pool, eventBus);
  }

  private async publish<T>(tenantId: string, name: DomainEventName, payload: T): Promise<void> {
    await this.eventBus.publish({ name, tenantId, occurredAt: new Date().toISOString(), payload });
  }

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
   *
   * `actorUserId` (optional, defaults to null for an internal/automatic
   * caller -- same null-means-no-human-actor semantics
   * OrderService.transition()'s own option carries) records one
   * `picklist.created` audit event per picklist inserted, in the same
   * transaction that inserts it -- and is passed straight through to each
   * covered order's own `allocated -> picking` transition() call below, so
   * that transition's own `order.transitioned` audit event (recorded inside
   * OrderService.simpleTransition()) attributes to the same actor rather
   * than defaulting to null.
   */
  async generatePicklist(tenantId: string, orderIds: string[], actorUserId: string | null = null): Promise<Picklist[]> {
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

        // Same transaction as the INSERT above -- see recordAuditEvent's own
        // doc comment for why that matters.
        await recordAuditEvent(client, {
          tenantId,
          userId: actorUserId,
          action: "picklist.created",
          entityType: "picklist",
          entityId: picklistId,
          details: { locationId, orderIds: [...new Set(lines.map((l) => l.orderId))], lineCount: lines.length },
        });

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
      await this.orderService.transition(tenantId, orderId, "allocated", "picking", { actorUserId });
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
   *
   * `actorUserId` (optional, defaults to null) records a `picklist.assigned`
   * audit event in the same transaction as the UPDATE -- see
   * recordAuditEvent's own doc comment for why that ordering matters.
   */
  async assignPicklist(
    tenantId: string,
    picklistId: string,
    pickerId: string,
    actorUserId: string | null = null,
  ): Promise<void> {
    await withTenant(this.pool, tenantId, async (client) => {
      const result = await client.query(
        `UPDATE picklists SET status = 'assigned', assigned_to = $1, updated_at = now()
          WHERE id = $2 AND tenant_id = $3 AND status = 'open'`,
        [pickerId, picklistId, tenantId],
      );
      if (result.rowCount === 0) {
        throw new Error(`Picklist ${picklistId} is not 'open' -- refusing assignment (already assigned?)`);
      }
      await recordAuditEvent(client, {
        tenantId,
        userId: actorUserId,
        action: "picklist.assigned",
        entityType: "picklist",
        entityId: picklistId,
        details: { pickerId },
      });
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
   *
   * `actorUserId` (optional, defaults to null) records a
   * `picklist.line_recorded` audit event in the same transaction as the
   * UPDATE below -- see recordAuditEvent's own doc comment for why that
   * ordering matters.
   */
  async recordPick(
    tenantId: string,
    picklistLineId: string,
    quantityPicked: number,
    damaged: boolean = false,
    actorUserId: string | null = null,
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

      await recordAuditEvent(client, {
        tenantId,
        userId: actorUserId,
        action: "picklist.line_recorded",
        entityType: "picklist_line",
        entityId: picklistLineId,
        details: { quantityPicked, quantityRequested: line.quantity_requested, damaged, status },
      });
    });
  }

  /**
   * Resolves one order's picking outcome into 'packed' -- or, when every
   * line came up short with nothing at all picked, into 'cancelled' (see
   * SHORT-PICK SPLIT below). Every picklist_line belonging to this order's
   * order_lines must already be recorded (not 'pending' -- packing can't
   * happen mid-pick). For any line that came up short (quantity_picked <
   * quantity_requested), inserts a real inventory_events entry -- 'damage'
   * if the line was marked damaged, 'adjustment' otherwise -- instead of
   * silently treating the requested and picked quantities as if they
   * matched (CLAUDE.md §2.2). That event both corrects on_hand (the
   * phantom unit(s) were never physically there) and releases the matching
   * amount of `reserved` (this order isn't going to ship what was never
   * really available), so `available` is unaffected -- the shortfall was
   * never really available stock to begin with, this just makes the ledger
   * admit it.
   *
   * SHORT-PICK SPLIT (CLAUDE.md §3's now-resolved OPEN PRODUCT DECISION --
   * Arif's call: split into a partial shipment + backorder, not silently
   * ship-what-was-picked or hold the whole order): a shortfall no longer
   * disappears into just a ledger correction. For every short line:
   *  - if *something* was picked (quantity_picked > 0), the ORIGINAL
   *    order_line's own quantity is reduced to what was actually picked --
   *    this order really is going to ship that many, no more.
   *  - if *nothing* was picked (quantity_picked === 0), the original
   *    order_line is re-parented onto the new backorder order wholesale
   *    (its order_id is repointed, everything else about the row is
   *    untouched) rather than deleted -- order_lines.quantity has a
   *    CHECK (quantity > 0) so it can never be reduced to zero in place,
   *    and picklist_lines.order_line_id is a NOT NULL FK with no ON DELETE
   *    behavior, so the row can't be deleted either once it's been picked
   *    against (see spinOffBackorder()'s own doc comment for the full
   *    reasoning).
   * Every short line's missing quantity (requested - picked) ends up on a
   * brand-new order, inserted directly at status 'backordered' (see
   * migration 0023's `split_from_order_id`, which points it back at this
   * order) -- from a person's perspective it's a completely ordinary
   * backordered order from here on: the existing 'backordered' -> 'allocated'
   * manual retry (packages/web/src/lib/order-status.ts) picks it up once
   * stock is back, same as any order that came up short at allocation time
   * instead of at picking time.
   *
   * If the split leaves the ORIGINAL order with no lines at all (every line
   * short-picked to zero -- nothing physically exists to box up), the
   * original is cancelled outright instead of proceeding to 'packed': a
   * 'packed' order with zero lines would be an empty shipment, and this
   * order's entire content now lives on the new backorder order instead.
   * That cancellation is a raw, guarded status flip here rather than a call
   * to OrderService.cancelOrder() -- that method independently re-reads and
   * re-releases every still-standing 'reservation' event for this order,
   * which would double-release: the per-line shortfall correction above
   * already reduced `reserved` by the *entire* originally-reserved quantity
   * for every line in this all-short case (shortfall === quantity_requested
   * when quantity_picked is 0), so there is nothing left for a second
   * release pass to safely subtract.
   *
   * Everything -- the ledger corrections, the original order's order_lines
   * split, the new order/order_lines insert, and (when it applies) the
   * original order's cancellation -- happens in one transaction: an order
   * must never be observable half-split (e.g. its lines already reduced but
   * no backorder order yet holding the difference). Written directly
   * against orders/order_lines here rather than composed through
   * OrderService, for the same reason the ledger correction above is
   * written directly against inventory_events rather than composed through
   * InventoryService: both those classes always open their own separate
   * transaction, and this operation cannot be split across two round-trips
   * without a window where the split is only half-committed (see
   * OrderService.cancelOrder's own doc comment for this codebase's existing
   * precedent on the same tradeoff). Events (OrderBackordered for the new
   * order, OrderCancelled for the original when it's cancelled, and
   * OrderSplitForBackorder either way) are published only after this
   * transaction commits -- same "never publish from inside an open
   * transaction" discipline every other method in this file and
   * OrderService follow.
   *
   * A backorder order's external_order_id is derived
   * (`<original>:backorder`), not a fresh channel-supplied id -- this is an
   * internal fulfillment artifact, not a second real marketplace order, so
   * it never collides with a genuine external_order_id and is stable per
   * original order. It deliberately does NOT go through
   * OrderService.persistPulledOrders()'s usual 'order.received' pipeline --
   * no usage-metering increment, no RulesEngine routing/hold rule run
   * against it -- it's fulfillment overhead of the ONE real order that was
   * already counted/routed when it first came in, not a new customer order.
   *
   * If every line on the owning picklist(s) is now resolved, marks the
   * picklist 'completed' regardless of which of the two outcomes above the
   * order landed on.
   *
   * `actorUserId` (optional, defaults to null): passed straight through to
   * the `picking -> packed` transition() call at the end of this method (so
   * that transition's own `order.transitioned` audit event, recorded inside
   * OrderService.simpleTransition(), attributes to the real actor). The
   * ALL-SHORT raw cancellation flip above is NOT a transition() call (see
   * this doc comment's own reasoning on why it can't double-release via
   * OrderService.cancelOrder()), so it gets its own `order.transitioned`
   * audit event, recorded directly alongside that UPDATE -- otherwise this
   * one cancellation path would be invisible to the audit log entirely.
   */
  async packOrder(tenantId: string, orderId: string, actorUserId: string | null = null): Promise<void> {
    const result = await withTenant(this.pool, tenantId, async (client) => {
      const lines = await client.query<{
        id: string;
        picklist_id: string;
        order_line_id: string;
        product_id: string;
        quantity_requested: number;
        quantity_picked: number;
        status: PicklistLineStatus;
        unit_price: string;
        fulfillment_type: string;
      }>(
        `SELECT pl.id, pl.picklist_id, pl.order_line_id, pl.product_id, pl.quantity_requested, pl.quantity_picked, pl.status,
                ol.unit_price, ol.fulfillment_type
           FROM picklist_lines pl
           JOIN order_lines ol ON ol.id = pl.order_line_id
          WHERE ol.order_id = $1 AND pl.tenant_id = $2`,
        [orderId, tenantId],
      );

      if (lines.rows.length === 0) {
        // No picklist lines at all -- either a zero-line order (already
        // moved straight to 'picking' by generatePicklist()) or one that
        // was never put on a picklist. Nothing to reconcile, nothing to
        // split -- proceed straight to 'packed'.
        return { affectedPicklistIds: [] as string[], backorder: null as BackorderResult | null, originalCancelled: false };
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

      const shortLines: ShortLine[] = [];
      // Count of order_lines still standing on the ORIGINAL order once
      // every line above has been resolved -- both an unaffected
      // (non-short) line and a partially-short line (quantity reduced, not
      // deleted) count toward this; only a fully-zero-picked line does not.
      let remainingLineCount = 0;

      for (const line of lines.rows) {
        const shortfall = line.quantity_requested - line.quantity_picked;
        if (shortfall <= 0) {
          remainingLineCount++;
          continue;
        }

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

        shortLines.push({
          orderLineId: line.order_line_id,
          productId: line.product_id,
          unitPrice: line.unit_price,
          fulfillmentType: line.fulfillment_type,
          shortfall,
          quantityPicked: line.quantity_picked,
        });

        if (line.quantity_picked > 0) {
          await client.query(`UPDATE order_lines SET quantity = $1 WHERE id = $2 AND tenant_id = $3`, [
            line.quantity_picked,
            line.order_line_id,
            tenantId,
          ]);
          remainingLineCount++;
        }
        // else: leave this order_line untouched for now -- spinOffBackorder()
        // re-parents it onto the new backorder order below (once that order
        // exists to re-parent it onto), rather than deleting it here. See
        // spinOffBackorder()'s per-line comment for why a delete-and-reinsert
        // doesn't work: order_lines.quantity's CHECK (quantity > 0) rules
        // out reducing it to zero in place, and picklist_lines.order_line_id
        // is a NOT NULL FK with no ON DELETE behavior, so the row can't be
        // deleted either once it's been picked against.
      }

      let backorder: BackorderResult | null = null;
      let originalCancelled = false;

      if (shortLines.length > 0) {
        backorder = await spinOffBackorder(client, tenantId, orderId, shortLines);

        if (remainingLineCount === 0) {
          // Nothing survived on the original order -- see this method's
          // SHORT-PICK SPLIT doc comment for why this is a raw guarded flip,
          // not OrderService.cancelOrder().
          const cancelled = await client.query(
            `UPDATE orders SET status = 'cancelled', updated_at = now()
               WHERE id = $1 AND tenant_id = $2 AND status = 'picking'`,
            [orderId, tenantId],
          );
          if (cancelled.rowCount === 0) {
            throw new Error(`Order ${orderId} is not in status 'picking' -- refusing to cancel (concurrent update?)`);
          }
          originalCancelled = true;

          // Same transaction as the UPDATE above -- see recordAuditEvent's
          // own doc comment for why that matters. Not routed through
          // transition()/OrderService.cancelOrder() (see this method's own
          // doc comment), so this is the only place this specific
          // 'picking' -> 'cancelled' flip gets recorded.
          await recordAuditEvent(client, {
            tenantId,
            userId: actorUserId,
            action: "order.transitioned",
            entityType: "order",
            entityId: orderId,
            details: { from: "picking", to: "cancelled", reason: "short_pick_all_lines" },
          });
        }
      }

      return {
        affectedPicklistIds: [...new Set(lines.rows.map((l) => l.picklist_id))],
        backorder,
        originalCancelled,
      };
    });

    for (const picklistId of result.affectedPicklistIds) {
      await this.maybeCompletePicklist(tenantId, picklistId);
    }

    if (result.backorder) {
      await this.publish(tenantId, DomainEvent.OrderBackordered, { orderId: result.backorder.orderId });
      const splitPayload: OrderSplitForBackorderPayload = {
        originalOrderId: orderId,
        backorderOrderId: result.backorder.orderId,
        originalOrderCancelled: result.originalCancelled,
        lines: result.backorder.lines,
      };
      await this.publish(tenantId, DomainEvent.OrderSplitForBackorder, splitPayload);
    }

    if (result.originalCancelled) {
      await this.publish(tenantId, DomainEvent.OrderCancelled, { orderId });
      return;
    }

    await this.orderService.transition(tenantId, orderId, "picking", "packed", { actorUserId });
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
   * against a real dev store -- see CLAUDE.md §4.5), 'walmart'
   * (WalmartConnector.confirmShipment(), UNVERIFIED IN PRACTICE -- wired the
   * same way as the other two, but see CLAUDE.md §4.2 and
   * WalmartConnector's own class doc comment for why nothing has actually
   * round-tripped against Walmart's live API yet), and 'ebay'
   * (EbayConnector.confirmShipment(), UNVERIFIED IN PRACTICE more so even
   * than Walmart's -- see CLAUDE.md §4.6 and EbayConnector's own class doc
   * comment: this environment's network policy blocks eBay's API hosts
   * outright) are wired to real connectors today. Any other channel throws
   * a clear "not implemented" error rather than silently skipping the
   * channel call and transitioning anyway.
   *
   * Once the channel confirms, {@link recordShipmentSaleEvents} runs before
   * the local 'packed' -> 'shipped' transition -- this is where a shipped
   * order's stock is actually consumed (see that function's own doc
   * comment for the gap this closes). Deliberately in that order, not
   * after the transition: if recording the sale somehow throws, the order
   * stays 'packed' locally (consistent with the channel-call-failed case
   * above) rather than becoming 'shipped' with no matching consumption
   * ever recorded for it -- the one outcome this whole fix exists to rule
   * out.
   *
   * `actorUserId` (optional, defaults to null): passed straight through to
   * the `packed -> shipped` transition() call at the end of this method, so
   * that transition's own `order.transitioned` audit event attributes to
   * the real actor rather than defaulting to null.
   */
  async confirmShipment(
    tenantId: string,
    orderId: string,
    tracking: TrackingInfo,
    actorUserId: string | null = null,
  ): Promise<void> {
    const order = await withTenant(this.pool, tenantId, async (client) => {
      const result = await client.query<{
        channel: string;
        external_order_id: string;
        status: string;
        channel_connection_id: string | null;
      }>(
        `SELECT channel, external_order_id, status, channel_connection_id FROM orders WHERE id = $1 AND tenant_id = $2`,
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
    } else if (order.channel === "ebay") {
      const connector = await createEbayConnectorFromChannelConnection(this.pool, tenantId);
      await connector.confirmShipment(order.external_order_id, tracking);
    } else if (order.channel === "temu") {
      const connector = await createTemuConnectorFromChannelConnection(this.pool, tenantId);
      await connector.confirmShipment(order.external_order_id, tracking);
    } else if (order.channel === "tiktok") {
      // channel_connection_id (migration 0037) resolves the correct SHOP's
      // credentials -- CLAUDE.md §12's "no true multi-shop CONNECT" gap
      // used to mean this always guessed "whichever shop was connected
      // most recently," which is wrong the instant a tenant has more than
      // one. NULL here (an order persisted before this migration, or by
      // some future non-scheduler path that doesn't set it) falls back to
      // that same old "most recent active connection" behavior --
      // createTikTokConnectorFromChannelConnection's own doc comment.
      const connector = await createTikTokConnectorFromChannelConnection(this.pool, tenantId, order.channel_connection_id);
      await connector.confirmShipment(order.external_order_id, tracking);
    } else {
      throw new Error(
        `WarehouseService.confirmShipment: channel '${order.channel}' has no connector wired for shipment confirmation yet`,
      );
    }

    await recordShipmentSaleEvents(this.pool, this.inventoryService, tenantId, orderId);
    await this.orderService.transition(tenantId, orderId, "packed", "shipped", { actorUserId });
  }
}
