// Domain event names published on the event bus (CLAUDE.md §1, §3). The
// order/inventory services publish these without knowing who subscribes;
// rules-engine and reporting consume them independently.
export const DomainEvent = {
  OrderReceived: "order.received",
  OrderValidated: "order.validated",
  OrderAllocated: "order.allocated",
  // allocateOrder()'s other real outcome (CLAUDE.md §3) -- added alongside
  // the rules engine so this path isn't silently invisible on the bus.
  OrderBackordered: "order.backordered",
  OrderPicking: "order.picking",
  OrderPacked: "order.packed",
  OrderShipped: "order.shipped",
  OrderDelivered: "order.delivered",
  OrderCancelled: "order.cancelled",
  OrderReturned: "order.returned",
  OrderRefunded: "order.refunded",
  InventoryChanged: "inventory.changed",
} as const;

export type DomainEventName = (typeof DomainEvent)[keyof typeof DomainEvent];

export interface DomainEventEnvelope<TPayload = unknown> {
  name: DomainEventName;
  tenantId: string;
  occurredAt: string;
  payload: TPayload;
}

/** Payload for `order.received` -- the rules engine's routing trigger.
 *  Deliberately minimal: everything here is already on hand at the point
 *  persistPulledOrders() publishes it (no extra query needed), and covers
 *  the fields a first order-routing rule plausibly conditions on (channel,
 *  marketplace, shipping destination). Other events' payloads stay
 *  untyped (`unknown`) until a real subscriber needs them -- no
 *  speculative typing ahead of an actual consumer. */
export interface OrderReceivedPayload {
  orderId: string;
  channel: string;
  channelMarketplace: string;
  externalOrderId: string;
  shippingAddress: Record<string, unknown> | null;
}
