import { InventoryService } from "@alltix/inventory-service";
import { OrderService } from "@alltix/order-service";
import { WarehouseService } from "@alltix/warehouse-service";
import { getAppPool } from "./db";

/**
 * Fresh OrderService/WarehouseService/InventoryService per call, all bound
 * to the shared app_user pool (getAppPool()). Not singletons: these classes
 * hold no per-instance state beyond the pool reference and (for
 * OrderService) an event bus that defaults to a private in-process one --
 * fine here, since none of the picklist/pack/ship/transfer mutations these
 * back need a subscriber (only order.received does, for RulesEngine, which
 * is wired separately in the order-ingestion path -- see OrderService's own
 * doc comment).
 */
export function getOrderService(): OrderService {
  return new OrderService(getAppPool());
}

export function getWarehouseService(): WarehouseService {
  return new WarehouseService(getAppPool(), getOrderService());
}

export function getInventoryService(): InventoryService {
  // Same default-to-a-private-in-process-bus shape as the other two
  // factories above -- fine for the same reason: nothing here has a
  // subscriber today. Its `inventory.changed` publish (see
  // InventoryService's own class doc comment) still fires on this private
  // bus for every real call this factory backs (the manual /inventory
  // transfer route) -- it just has no listener yet, same as
  // OrderService's/WarehouseService's own unshared-bus publishes.
  return new InventoryService(getAppPool());
}
