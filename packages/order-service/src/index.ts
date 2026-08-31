import type { Pool } from "pg";
import { withTenant } from "@alltix/db";
import { isValidOrderTransition, type Order, type OrderStatus } from "@alltix/shared";

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
}
