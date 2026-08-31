import type { Pool } from "pg";
import { withTenant } from "@alltix/db";

export interface PicklistLine {
  orderLineId: string;
  productId: string;
  locationId: string;
  quantity: number;
}

export interface Picklist {
  id: string;
  tenantId: string;
  orderIds: string[];
  lines: PicklistLine[];
}

/**
 * Owns picklists, packing, kitting/bundling, and shipment confirmation back
 * to channels (CLAUDE.md §1). Skeleton only — no persistence or carrier
 * integration yet.
 */
export class WarehouseService {
  constructor(private readonly pool: Pool) {}

  async generatePicklist(tenantId: string, orderIds: string[]): Promise<Picklist> {
    return withTenant(this.pool, tenantId, async () => {
      void orderIds;
      throw new Error("WarehouseService.generatePicklist: not implemented");
    });
  }

  async packOrder(tenantId: string, orderId: string): Promise<void> {
    await withTenant(this.pool, tenantId, async () => {
      void orderId;
      throw new Error("WarehouseService.packOrder: not implemented");
    });
  }

  async confirmShipment(tenantId: string, orderId: string, trackingNumber: string): Promise<void> {
    await withTenant(this.pool, tenantId, async () => {
      void orderId;
      void trackingNumber;
      throw new Error("WarehouseService.confirmShipment: not implemented");
    });
  }
}
