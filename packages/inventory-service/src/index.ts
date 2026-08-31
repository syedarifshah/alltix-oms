import type { Pool } from "pg";
import { withTenant } from "@alltix/db";
import type { InventoryEventType, InventoryReferenceType } from "@alltix/shared";

export interface RecordInventoryEventInput {
  tenantId: string;
  productId: string;
  locationId: string;
  eventType: InventoryEventType;
  quantityDelta: number;
  referenceType?: InventoryReferenceType;
  referenceId?: string;
  idempotencyKey: string;
}

/**
 * Owns the stock ledger and the derived `inventory_levels` rollup
 * (CLAUDE.md §1, §2.2). This is a skeleton: method bodies are not
 * implemented yet, only the shape the rest of the system should depend on.
 *
 * Every stock mutation must go through `recordInventoryEvent` — nothing else
 * in the codebase should write to `inventory_levels` directly.
 */
export class InventoryService {
  constructor(private readonly pool: Pool) {}

  async recordInventoryEvent(input: RecordInventoryEventInput): Promise<void> {
    await withTenant(this.pool, input.tenantId, async () => {
      throw new Error("InventoryService.recordInventoryEvent: not implemented");
    });
  }

  async getAvailableToSell(tenantId: string, productId: string, locationId: string): Promise<number> {
    return withTenant(this.pool, tenantId, async () => {
      void productId;
      void locationId;
      throw new Error("InventoryService.getAvailableToSell: not implemented");
    });
  }
}
