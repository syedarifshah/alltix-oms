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
  // Published when an order reaches on_hold via OrderService.transition()
  // directly (e.g. a future manual "place on hold" action, or a test).
  // RulesEngine's own 'hold_order' automation action does NOT go through
  // transition() -- see its own doc comment for why -- so a rule-driven
  // hold does not publish this; it's picked up via rule_executions instead.
  OrderOnHold: "order.on_hold",
  OrderPicking: "order.picking",
  OrderPacked: "order.packed",
  OrderShipped: "order.shipped",
  OrderDelivered: "order.delivered",
  OrderCancelled: "order.cancelled",
  OrderReturned: "order.returned",
  OrderRefunded: "order.refunded",
  // Published once per short-pick split (WarehouseService.packOrder,
  // CLAUDE.md §3): a picklist line came up short, so the shortfall was spun
  // off into a brand-new order (see OrderSplitForBackorderPayload) rather
  // than silently shipping less than the customer ordered. Fires alongside
  // -- not instead of -- OrderBackordered (published for the new order
  // itself) and, when the original order had nothing left to ship at all,
  // OrderCancelled (for the original) -- this event exists so a subscriber
  // (e.g. a future customer-notification feature) can find both halves of
  // the split together without having to correlate two separate events by
  // timing/orderId guesswork.
  OrderSplitForBackorder: "order.split_for_backorder",
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

/** Payload for `order.split_for_backorder` -- see DomainEvent.OrderSplitForBackorder's
 *  own comment for why this exists as its own event/payload rather than
 *  making a subscriber reconstruct the relationship from OrderBackordered/
 *  OrderCancelled alone. `originalOrderCancelled` is true only when the
 *  original order had nothing left to ship at all (every line short-picked
 *  to zero) and was cancelled outright rather than packed with a reduced
 *  line set -- see WarehouseService.packOrder's doc comment. */
export interface OrderSplitForBackorderPayload {
  originalOrderId: string;
  backorderOrderId: string;
  originalOrderCancelled: boolean;
  lines: Array<{ productId: string; quantity: number }>;
}
