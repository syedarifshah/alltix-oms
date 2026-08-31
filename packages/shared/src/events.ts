// Domain event names published on the event bus (CLAUDE.md §1, §3). The
// order/inventory services publish these without knowing who subscribes;
// rules-engine and reporting consume them independently.
export const DomainEvent = {
  OrderReceived: "order.received",
  OrderValidated: "order.validated",
  OrderAllocated: "order.allocated",
  OrderPicking: "order.picking",
  OrderPacked: "order.packed",
  OrderShipped: "order.shipped",
  OrderDelivered: "order.delivered",
  OrderCancelled: "order.cancelled",
  OrderReturned: "order.returned",
  InventoryChanged: "inventory.changed",
} as const;

export type DomainEventName = (typeof DomainEvent)[keyof typeof DomainEvent];

export interface DomainEventEnvelope<TPayload = unknown> {
  name: DomainEventName;
  tenantId: string;
  occurredAt: string;
  payload: TPayload;
}
