import type { Pool, PoolClient } from "pg";
import { withTenant } from "@alltix/db";
import {
  DomainEvent,
  InProcessEventBus,
  isValidOrderTransition,
  type DomainEventName,
  type EventBus,
  type Order,
  type OrderReceivedPayload,
  type OrderStatus,
} from "@alltix/shared";
import type { NormalizedOrder } from "@alltix/channel-connectors";

export interface PersistPulledOrdersResult {
  insertedOrderIds: string[];
  skippedExternalOrderIds: string[];
}

/** The event each simpleTransition() `to` status publishes once its UPDATE
 *  commits. 'allocated' isn't here -- allocateOrder() publishes its own
 *  (either OrderAllocated or OrderBackordered) since it has two possible
 *  outcomes and a richer payload than a plain status flip. */
const SIMPLE_TRANSITION_EVENT: Partial<Record<OrderStatus, DomainEventName>> = {
  validated: DomainEvent.OrderValidated,
  picking: DomainEvent.OrderPicking,
  packed: DomainEvent.OrderPacked,
  shipped: DomainEvent.OrderShipped,
};

/**
 * Normalizes orders from every channel into one shape and owns the order
 * state machine (CLAUDE.md §1, §3). Skeleton only — no channel connector
 * writes into this yet, and method bodies are unimplemented.
 *
 * Publishes a DomainEvent (packages/shared/src/events.ts) after every
 * successful status change, via the injected EventBus -- defaulted to a
 * fresh InProcessEventBus so every existing call site keeps compiling
 * unchanged, but a real caller (or a test asserting on rule execution)
 * passes a shared bus so RulesEngine can subscribe to it. OrderService
 * never imports or references RulesEngine -- publish-without-knowing-
 * subscribers is the whole point (CLAUDE.md §1).
 */
export class OrderService {
  constructor(
    private readonly pool: Pool,
    private readonly eventBus: EventBus = new InProcessEventBus(),
  ) {}

  private async publish<T>(tenantId: string, name: DomainEventName, payload: T): Promise<void> {
    await this.eventBus.publish({ name, tenantId, occurredAt: new Date().toISOString(), payload });
  }

  async receiveOrder(tenantId: string, order: Omit<Order, "id" | "tenantId" | "status">): Promise<Order> {
    return withTenant(this.pool, tenantId, async () => {
      void order;
      throw new Error("OrderService.receiveOrder: not implemented");
    });
  }

  /**
   * Moves an order to `to`, rejecting transitions the state machine
   * (packages/shared/src/order-state-machine.ts) doesn't allow. Returns the
   * order's actual resulting status, which for `to === 'allocated'` can
   * differ from what was requested: an allocation attempt that finds
   * insufficient stock lands the order in 'backordered' instead (CLAUDE.md
   * §3) rather than throwing, since that's an expected outcome of the
   * attempt, not a caller error.
   *
   * 'validated', 'picking', 'packed', and 'shipped' are plain guarded status
   * flips (see {@link simpleTransition}) -- 'validated' is a pass-through
   * today (only the state-machine edge is enforced, no real validation logic
   * exists yet); 'picking'/'packed'/'shipped' are called by
   * WarehouseService (CLAUDE.md §1) once it's done its own picklist/
   * inventory-adjustment/channel-confirmation work, so the order state
   * machine stays owned in exactly one place rather than WarehouseService
   * writing to `orders.status` itself. No other `to` value is implemented.
   */
  async transition(tenantId: string, orderId: string, from: OrderStatus, to: OrderStatus): Promise<OrderStatus> {
    if (!isValidOrderTransition(from, to)) {
      throw new Error(`Invalid order transition: ${from} -> ${to}`);
    }

    if (to === "allocated") {
      return this.allocateOrder(tenantId, orderId, from);
    }

    if (to === "validated" || to === "picking" || to === "packed" || to === "shipped") {
      return this.simpleTransition(tenantId, orderId, from, to);
    }

    throw new Error(`OrderService.transition: '${from}' -> '${to}' is not implemented yet`);
  }

  /** A status flip with no side effects beyond the guarded UPDATE itself --
   *  the `WHERE status = from` clause is the concurrency guard (a
   *  concurrent transition away from `from` makes this a no-op, caught via
   *  `rowCount === 0`), the same pattern {@link allocateOrder} uses via an
   *  explicit row lock instead, appropriate here since there's no
   *  multi-step read-then-decide logic to protect. */
  private async simpleTransition(
    tenantId: string,
    orderId: string,
    from: OrderStatus,
    to: OrderStatus,
  ): Promise<OrderStatus> {
    await withTenant(this.pool, tenantId, async (client) => {
      const result = await client.query(
        `UPDATE orders SET status = $1, updated_at = now() WHERE id = $2 AND tenant_id = $3 AND status = $4`,
        [to, orderId, tenantId, from],
      );
      if (result.rowCount === 0) {
        throw new Error(
          `Order ${orderId} is not in status '${from}' -- refusing transition to '${to}' (concurrent update?)`,
        );
      }
    });

    const eventName = SIMPLE_TRANSITION_EVENT[to];
    if (eventName) {
      await this.publish(tenantId, eventName, { orderId });
    }
    return to;
  }

  /**
   * Attempts to allocate `orderId`: for each order_line, locks its product's
   * inventory_levels row (SELECT ... FOR UPDATE) so two concurrent
   * allocation attempts against the same product serialize instead of both
   * reading stale `available` and both succeeding (CLAUDE.md §3, §7, §11.2)
   * -- Postgres re-reads the row's latest committed value once a blocked
   * FOR UPDATE lock is granted, even under the default READ COMMITTED
   * isolation level, which is exactly what makes this check-then-act safe
   * without a stronger isolation level.
   *
   * All locks are taken, and the sufficiency decision made, before any
   * mutation -- an order is never partially allocated. If every line has
   * enough stock: inserts one 'reservation' inventory_events row per line,
   * increments inventory_levels.reserved for each (inventory_levels is a
   * derived rollup per CLAUDE.md §2.2 with no trigger to refresh it yet, so
   * the app must update it explicitly, in the same transaction as the
   * event), and moves the order to 'allocated'. Otherwise the order moves
   * to 'backordered' and nothing is reserved.
   *
   * An order with zero order_lines is treated as vacuously allocatable
   * (nothing to reserve, nothing that can be insufficient) rather than an
   * error. AmazonConnector.pullOrders() now fetches real line items, but a
   * channel adapter with no items on an order (or a future channel that
   * genuinely has none) shouldn't be unable to ever leave 'validated'.
   *
   * Location selection: if the rules engine set orders.preferred_location_id
   * (a route_to_warehouse action, applied while the order was still
   * 'received' -- see RulesEngine and events.ts's OrderReceivedPayload),
   * that location is used instead of the default choice below, and must
   * resolve to a real, tenant-owned, type='warehouse' location or this
   * throws outright -- a routing decision that points at garbage should
   * fail loudly, not be silently ignored in favor of the default. With no
   * preferred_location_id, behavior is unchanged from before the rules
   * engine existed: the tenant's oldest warehouse location.
   */
  private async allocateOrder(tenantId: string, orderId: string, expectedFromStatus: OrderStatus): Promise<OrderStatus> {
    const result = await withTenant(this.pool, tenantId, async (client) => {
      const orderResult = await client.query<{ status: OrderStatus; preferred_location_id: string | null }>(
        `SELECT status, preferred_location_id FROM orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [orderId, tenantId],
      );
      const orderRow = orderResult.rows[0];
      if (!orderRow) {
        throw new Error(`Order ${orderId} not found for tenant ${tenantId}`);
      }
      if (orderRow.status !== expectedFromStatus) {
        throw new Error(
          `Order ${orderId} is in status '${orderRow.status}', not '${expectedFromStatus}' -- refusing allocation (concurrent update?)`,
        );
      }

      const lines = await client.query<{ id: string; product_id: string; quantity: number }>(
        `SELECT id, product_id, quantity FROM order_lines WHERE order_id = $1 AND tenant_id = $2`,
        [orderId, tenantId],
      );

      if (lines.rows.length === 0) {
        await client.query(
          `UPDATE orders SET status = 'allocated', updated_at = now() WHERE id = $1 AND tenant_id = $2`,
          [orderId, tenantId],
        );
        return { status: "allocated" as const, locationId: null };
      }

      const locationId = await this.resolveAllocationLocation(client, tenantId, orderRow.preferred_location_id);

      // Sum requested quantity per product first (an order can have more
      // than one line for the same product) so each product's row is only
      // locked once.
      const requestedByProduct = new Map<string, number>();
      for (const line of lines.rows) {
        requestedByProduct.set(line.product_id, (requestedByProduct.get(line.product_id) ?? 0) + line.quantity);
      }

      // Lock rows in a stable order (sorted product_id) across every
      // concurrent allocation attempt that might touch overlapping
      // products, to avoid a lock-order deadlock between two orders that
      // both span the same two SKUs in opposite order.
      const availableByProduct = new Map<string, number>();
      for (const productId of [...requestedByProduct.keys()].sort()) {
        const levelResult = await client.query<{ available: number }>(
          `SELECT available FROM inventory_levels WHERE product_id = $1 AND location_id = $2 FOR UPDATE`,
          [productId, locationId],
        );
        availableByProduct.set(productId, levelResult.rows[0]?.available ?? 0);
      }

      const sufficient = [...requestedByProduct.entries()].every(
        ([productId, quantity]) => (availableByProduct.get(productId) ?? 0) >= quantity,
      );

      if (!sufficient) {
        await client.query(
          `UPDATE orders SET status = 'backordered', updated_at = now() WHERE id = $1 AND tenant_id = $2`,
          [orderId, tenantId],
        );
        return { status: "backordered" as const, locationId };
      }

      for (const line of lines.rows) {
        await client.query(
          `INSERT INTO inventory_events
             (tenant_id, product_id, location_id, event_type, quantity_delta, reference_type, reference_id, idempotency_key)
           VALUES ($1, $2, $3, 'reservation', $4, 'order', $5, $6)`,
          [
            tenantId,
            line.product_id,
            locationId,
            -line.quantity,
            orderId,
            `order-allocation:${orderId}:${line.id}`,
          ],
        );
        await client.query(
          `UPDATE inventory_levels SET reserved = reserved + $1, updated_at = now()
             WHERE product_id = $2 AND location_id = $3`,
          [line.quantity, line.product_id, locationId],
        );
      }

      await client.query(
        `UPDATE orders SET status = 'allocated', updated_at = now() WHERE id = $1 AND tenant_id = $2`,
        [orderId, tenantId],
      );
      return { status: "allocated" as const, locationId };
    });

    if (result.status === "allocated") {
      await this.publish(tenantId, DomainEvent.OrderAllocated, { orderId, locationId: result.locationId });
    } else {
      await this.publish(tenantId, DomainEvent.OrderBackordered, { orderId });
    }
    return result.status;
  }

  /** Resolves which location allocateOrder() reserves against. `preferredLocationId`
   *  (from orders.preferred_location_id) wins when present and must be a
   *  real, tenant-owned, type='warehouse' location -- throws otherwise
   *  rather than silently falling back. With none set, falls back to the
   *  original default: the tenant's oldest warehouse location. */
  private async resolveAllocationLocation(
    client: PoolClient,
    tenantId: string,
    preferredLocationId: string | null,
  ): Promise<string> {
    if (preferredLocationId) {
      const preferred = await client.query<{ id: string }>(
        `SELECT id FROM locations WHERE id = $1 AND tenant_id = $2 AND type = 'warehouse'`,
        [preferredLocationId, tenantId],
      );
      const preferredRow = preferred.rows[0];
      if (!preferredRow) {
        throw new Error(
          `Order's preferred_location_id ${preferredLocationId} does not resolve to a real ` +
            `'warehouse' location for tenant ${tenantId} -- refusing to fall back silently`,
        );
      }
      return preferredRow.id;
    }

    const location = await client.query<{ id: string }>(
      `SELECT id FROM locations WHERE tenant_id = $1 AND type = 'warehouse' ORDER BY created_at ASC LIMIT 1`,
      [tenantId],
    );
    const locationRow = location.rows[0];
    if (!locationRow) {
      throw new Error(`Tenant ${tenantId} has no warehouse location to allocate against`);
    }
    return locationRow.id;
  }

  /**
   * Persists orders pulled from a ChannelConnector.pullOrders() call
   * (CLAUDE.md §4.3) into orders/order_lines. New orders land in 'received'
   * (CLAUDE.md §3) -- the state machine hasn't run yet, so a channel's own
   * status (`NormalizedOrder.channelStatus`) is intentionally not consulted
   * here. Dedupes on the (tenant_id, channel, external_order_id) UNIQUE
   * constraint (CLAUDE.md §2.3) via ON CONFLICT DO NOTHING, so re-pulling an
   * overlapping time window is idempotent rather than a duplicate-insert
   * error or a silent overwrite of whatever status the order has since
   * moved to. The insert batch is one transaction (via withTenant): if any
   * order's lines can't be persisted, none of the batch is.
   *
   * Once inserts are committed, every newly-inserted order (not skipped
   * ones -- they already went through this before) publishes 'order.received'
   * and is walked through received -> validated -> allocated so it doesn't
   * sit at 'received' forever. That has to happen *after* the insert
   * transaction commits, in its own transaction per order: allocateOrder()
   * runs on a different connection (via its own withTenant), and until this
   * transaction commits, that connection's MVCC snapshot can't see the row
   * this one just inserted.
   *
   * 'order.received' is published *before* the validated/allocated
   * transitions specifically so a routing rule (RulesEngine, subscribed to
   * OrderReceived) has a chance to set orders.preferred_location_id before
   * allocateOrder() reads it -- see resolveAllocationLocation().
   */
  async persistPulledOrders(tenantId: string, orders: NormalizedOrder[]): Promise<PersistPulledOrdersResult> {
    const { insertedOrders, skippedExternalOrderIds } = await withTenant(this.pool, tenantId, async (client) => {
      const insertedOrders: Array<{ id: string; order: NormalizedOrder }> = [];
      const skippedExternalOrderIds: string[] = [];

      for (const order of orders) {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO orders
             (tenant_id, channel, external_order_id, status, customer, shipping_address, placed_at, raw_payload)
           VALUES ($1, $2, $3, 'received', $4, $5, $6, $7)
           ON CONFLICT (tenant_id, channel, external_order_id) DO NOTHING
           RETURNING id`,
          [
            tenantId,
            order.channel,
            order.externalOrderId,
            JSON.stringify(order.customer),
            JSON.stringify(order.shippingAddress),
            order.placedAt,
            JSON.stringify(order.rawPayload),
          ],
        );

        const orderRow = inserted.rows[0];
        if (!orderRow) {
          skippedExternalOrderIds.push(order.externalOrderId);
          continue;
        }

        insertedOrders.push({ id: orderRow.id, order });
        await insertOrderLines(client, tenantId, orderRow.id, order);
      }

      return { insertedOrders, skippedExternalOrderIds };
    });

    for (const { id: orderId, order } of insertedOrders) {
      const payload: OrderReceivedPayload = {
        orderId,
        channel: order.channel,
        channelMarketplace: order.channelMarketplace,
        externalOrderId: order.externalOrderId,
        shippingAddress: order.shippingAddress,
      };
      await this.publish(tenantId, DomainEvent.OrderReceived, payload);

      await this.transition(tenantId, orderId, "received", "validated");
      await this.transition(tenantId, orderId, "validated", "allocated");
    }

    return { insertedOrderIds: insertedOrders.map((o) => o.id), skippedExternalOrderIds };
  }
}

/**
 * Resolves each line's product via channel_listings (channel + external_sku
 * -> product_id, CLAUDE.md §2.1) and inserts it. Fails loudly (aborting the
 * whole batch's transaction) rather than silently dropping a line on an
 * unresolved SKU -- a real seller catalog must be synced into
 * channel_listings before its orders can be persisted with lines intact.
 */
async function insertOrderLines(
  client: PoolClient,
  tenantId: string,
  orderId: string,
  order: NormalizedOrder,
): Promise<void> {
  for (const line of order.lines) {
    const listing = await client.query<{ product_id: string }>(
      `SELECT product_id FROM channel_listings WHERE channel = $1 AND external_sku = $2 LIMIT 1`,
      [order.channel, line.externalSku],
    );
    const productId = listing.rows[0]?.product_id;
    if (!productId) {
      throw new Error(
        `No channel_listings match for channel=${order.channel} external_sku=${line.externalSku} ` +
          `(order ${order.externalOrderId}) -- cannot resolve product_id for order_lines`,
      );
    }
    await client.query(
      `INSERT INTO order_lines (tenant_id, order_id, product_id, quantity, unit_price, fulfillment_type)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenantId, orderId, productId, line.quantity, line.unitPrice, line.fulfillmentType],
    );
  }
}
