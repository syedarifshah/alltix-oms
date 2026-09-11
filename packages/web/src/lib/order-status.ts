import { ORDER_STATE_TRANSITIONS, isValidOrderTransition, type OrderStatus } from "@alltix/shared";

/** Every status in the CLAUDE.md §3 state machine, in the diagram's own
 *  order -- Object.keys preserves insertion order, and
 *  ORDER_STATE_TRANSITIONS was written in exactly that order (see
 *  packages/shared/src/order-state-machine.ts). Single source of truth: this
 *  never drifts from the state machine the backend actually enforces. */
export const ALL_ORDER_STATUSES = Object.keys(ORDER_STATE_TRANSITIONS) as OrderStatus[];

/** Narrows an arbitrary string (e.g. a value pulled out of form data) to
 *  OrderStatus -- checked against ALL_ORDER_STATUSES, the same single
 *  source of truth every other status check on this page derives from,
 *  rather than a separate hardcoded list that could drift from it. */
export function isOrderStatus(value: string): value is OrderStatus {
  return (ALL_ORDER_STATUSES as string[]).includes(value);
}

/** Whether an order currently in `status` can be cancelled -- delegates to
 *  isValidOrderTransition(status, 'cancelled') rather than hardcoding its
 *  own list, so the order detail page's Cancel button can never drift out
 *  of sync with what packages/shared/src/order-state-machine.ts (and
 *  therefore OrderService.cancelOrder) actually allows -- see that file's
 *  CANCELLATION SCOPE comment for which states these are and why. */
export function isOrderCancellable(status: OrderStatus): boolean {
  return isValidOrderTransition(status, "cancelled");
}

type BadgeTone = "success" | "warning" | "danger" | "accent" | "neutral";

const STATUS_TONE: Record<OrderStatus, BadgeTone> = {
  received: "neutral",
  validated: "neutral",
  on_hold: "warning",
  allocated: "accent",
  backordered: "warning",
  picking: "accent",
  packed: "accent",
  shipped: "success",
  delivered: "success",
  returned: "danger",
  refunded: "danger",
  cancelled: "danger",
};

export function orderStatusBadgeClass(status: string): string {
  const tone = STATUS_TONE[status as OrderStatus] ?? "neutral";
  return tone === "neutral" ? "badge" : `badge badge-${tone}`;
}
