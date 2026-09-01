import type { Pool, PoolClient } from "pg";
import { withTenant } from "@alltix/db";
import { isValidOrderTransition, type Order, type OrderStatus } from "@alltix/shared";
import type { NormalizedOrder } from "@alltix/channel-connectors";

export interface PersistPulledOrdersResult {
  insertedOrderIds: string[];
  skippedExternalOrderIds: string[];
}

/**
 * Normalizes orders from every channel into one shape and owns the order
 * state machine (CLAUDE.md §1, §3). Skeleton only — no channel connector
 * writes into this yet, and method bodies are unimplemented.
 */
export class OrderService {
  constructor(private readonly pool: Pool) {}

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
   * 'validated' is a pass-through today -- only the state-machine edge is
   * enforced, no real validation logic (address/payment/etc.) exists yet.
   * No other `to` value is implemented.
   */
  async transition(tenantId: string, orderId: string, from: OrderStatus, to: OrderStatus): Promise<OrderStatus> {
    if (!isValidOrderTransition(from, to)) {
      throw new Error(`Invalid order transition: ${from} -> ${to}`);
    }

    if (to === "validated") {
      return withTenant(this.pool, tenantId, async (client) => {
        const result = await client.query(
          `UPDATE orders SET status = $1, updated_at = now() WHERE id = $2 AND tenant_id = $3 AND status = $4`,
          [to, orderId, tenantId, from],
        );
        if (result.rowCount === 0) {
          throw new Error(
            `Order ${orderId} is not in status '${from}' -- refusing transition to '${to}' (concurrent update?)`,
          );
        }
        return to;
      });
    }

    if (to === "allocated") {
      return this.allocateOrder(tenantId, orderId, from);
    }

    throw new Error(`OrderService.transition: '${from}' -> '${to}' is not implemented yet`);
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
   */
  private async allocateOrder(tenantId: string, orderId: string, expectedFromStatus: OrderStatus): Promise<OrderStatus> {
    return withTenant(this.pool, tenantId, async (client) => {
      const orderResult = await client.query<{ status: OrderStatus }>(
        `SELECT status FROM orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
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
        return "allocated";
      }

      const location = await client.query<{ id: string }>(
        `SELECT id FROM locations WHERE tenant_id = $1 AND type = 'warehouse' ORDER BY created_at ASC LIMIT 1`,
        [tenantId],
      );
      const locationRow = location.rows[0];
      if (!locationRow) {
        throw new Error(`Tenant ${tenantId} has no warehouse location to allocate against`);
      }
      const locationId = locationRow.id;

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
        return "backordered";
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
      return "allocated";
    });
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
   * ones -- they already went through this before) is walked through
   * received -> validated -> allocated so it doesn't sit at 'received'
   * forever. That has to happen *after* the insert transaction commits, in
   * its own transaction per order: allocateOrder() runs on a different
   * connection (via its own withTenant), and until this transaction
   * commits, that connection's MVCC snapshot can't see the row this one
   * just inserted.
   */
  async persistPulledOrders(tenantId: string, orders: NormalizedOrder[]): Promise<PersistPulledOrdersResult> {
    const { insertedOrderIds, skippedExternalOrderIds } = await withTenant(this.pool, tenantId, async (client) => {
      const insertedOrderIds: string[] = [];
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

        insertedOrderIds.push(orderRow.id);
        await insertOrderLines(client, tenantId, orderRow.id, order);
      }

      return { insertedOrderIds, skippedExternalOrderIds };
    });

    for (const orderId of insertedOrderIds) {
      await this.transition(tenantId, orderId, "received", "validated");
      await this.transition(tenantId, orderId, "validated", "allocated");
    }

    return { insertedOrderIds, skippedExternalOrderIds };
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
