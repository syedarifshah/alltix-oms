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
   * (packages/shared/src/order-state-machine.ts) doesn't allow. Allocation
   * specifically must be atomic with the inventory reservation — see
   * CLAUDE.md §3 — which this skeleton does not yet coordinate.
   */
  async transition(tenantId: string, orderId: string, from: OrderStatus, to: OrderStatus): Promise<void> {
    if (!isValidOrderTransition(from, to)) {
      throw new Error(`Invalid order transition: ${from} -> ${to}`);
    }
    await withTenant(this.pool, tenantId, async () => {
      void orderId;
      throw new Error("OrderService.transition: not implemented");
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
   * moved to. The whole batch is one transaction (via withTenant): if any
   * order's lines can't be persisted, none of the batch is.
   */
  async persistPulledOrders(tenantId: string, orders: NormalizedOrder[]): Promise<PersistPulledOrdersResult> {
    return withTenant(this.pool, tenantId, async (client) => {
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
  }
}

/**
 * Resolves each line's product via channel_listings (channel + external_sku
 * -> product_id, CLAUDE.md §2.1) and inserts it. NormalizedOrder.lines is
 * always empty today -- AmazonConnector.pullOrders() only pulls order
 * headers, since line items need a separate SP-API call (CLAUDE.md §4.1,
 * amazon-connector.ts) that isn't implemented yet -- so this only runs once
 * that's wired up. Fails loudly (aborting the whole batch's transaction)
 * rather than silently dropping a line on an unresolved SKU.
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
