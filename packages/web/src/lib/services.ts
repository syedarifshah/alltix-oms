import { OrderService } from "@alltix/order-service";
import { WarehouseService } from "@alltix/warehouse-service";
import { getAppPool } from "./db";

/**
 * Fresh OrderService/WarehouseService per call, both bound to the shared
 * app_user pool (getAppPool()). Not singletons: these classes hold no
 * per-instance state beyond the pool reference and (for OrderService) an
 * event bus that defaults to a private in-process one -- fine here, since
 * none of the picklist/pack/ship mutations these back need a subscriber
 * (only order.received does, for RulesEngine, which is wired separately in
 * the order-ingestion path -- see OrderService's own doc comment).
 */
export function getOrderService(): OrderService {
  return new OrderService(getAppPool());
}

export function getWarehouseService(): WarehouseService {
  return new WarehouseService(getAppPool(), getOrderService());
}
