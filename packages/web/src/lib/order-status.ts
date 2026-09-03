import { ORDER_STATE_TRANSITIONS, type OrderStatus } from "@alltix/shared";

/** Every status in the CLAUDE.md §3 state machine, in the diagram's own
 *  order -- Object.keys preserves insertion order, and
 *  ORDER_STATE_TRANSITIONS was written in exactly that order (see
 *  packages/shared/src/order-state-machine.ts). Single source of truth: this
 *  never drifts from the state machine the backend actually enforces. */
export const ALL_ORDER_STATUSES = Object.keys(ORDER_STATE_TRANSITIONS) as OrderStatus[];

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
