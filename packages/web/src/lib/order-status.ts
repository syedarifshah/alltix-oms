import { ORDER_STATE_TRANSITIONS, isValidOrderTransition, type OrderStatus, type ReturnDisposition } from "@alltix/shared";

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

export interface OrderManualAction {
  to: OrderStatus;
  label: string;
  hint?: string;
}

/**
 * Manual, human-triggered actions to surface as buttons on the order detail
 * page, keyed by the order's current status. Deliberately NOT derived from
 * "every edge ORDER_STATE_TRANSITIONS allows from this status" the way
 * isOrderCancellable is: some edges are only ever taken automatically
 * (received -> validated, and validated -> allocated *during fresh
 * channel-pull ingestion* -- see OrderService.persistPulledOrders), and
 * Cancel has its own dedicated button/predicate (isOrderCancellable) since
 * it's the one transition with a side effect worth its own doc comment.
 * This is a separate, hand-maintained "what could a person looking at this
 * order reasonably want to click" list -- see
 * order-state-machine.ts's ON_HOLD / BACKORDERED RESOLUTION comment and
 * OrderService.transition's doc comment for why each of these exists:
 *
 *  - 'validated' -> 'allocated': without this, an order returned to
 *    'validated' by resuming a hold (see 'on_hold' below) would have no way
 *    forward -- nothing outside ingestion advances 'validated' on its own.
 *  - 'on_hold' -> 'validated': releases the hold, back into the normal flow.
 *    (An order reaches 'on_hold' in the first place via a 'hold_order'
 *    automation rule -- packages/rules-engine/src/index.ts's
 *    placeOrderOnHold -- not a manual button; there's still no
 *    staff-initiated "place this order on hold" action on this page.)
 *  - 'backordered' -> 'allocated': manual retry once stock may have arrived.
 *  - 'shipped' -> 'delivered' / 'refunded': two of the three branches
 *    CLAUDE.md §3 draws off 'shipped'. The third, 'returned', is
 *    deliberately NOT in this list -- it needs a disposition decision
 *    (sellable vs damaged) a plain button can't carry, so the order detail
 *    page renders it as its own small form (see RETURN_DISPOSITIONS below)
 *    posting to a dedicated /api/orders/[id]/return route instead of the
 *    generic /transition route every action below posts to. See
 *    OrderService.transition's doc comment for the restock behavior each
 *    disposition actually triggers.
 */
const MANUAL_ORDER_ACTIONS: Partial<Record<OrderStatus, OrderManualAction[]>> = {
  validated: [
    {
      to: "allocated",
      label: "Allocate now",
      hint: "Reserves inventory for this order.",
    },
  ],
  on_hold: [
    {
      to: "validated",
      label: "Resume order",
      hint: "Releases the hold and returns the order to the normal flow.",
    },
  ],
  backordered: [
    {
      to: "allocated",
      label: "Retry allocation",
      hint: "Tries again now that stock may have arrived.",
    },
  ],
  shipped: [
    { to: "delivered", label: "Mark delivered" },
    { to: "refunded", label: "Mark refunded" },
  ],
};

export interface ReturnDispositionOption {
  value: ReturnDisposition;
  label: string;
  hint: string;
}

/** Options for the order detail page's dedicated "Mark returned" form
 *  (posts to /api/orders/[id]/return, not the generic /transition route --
 *  see MANUAL_ORDER_ACTIONS's own comment on why). Only rendered when
 *  isOrderReturnable(order.status) -- i.e. only from 'shipped', the one
 *  state CLAUDE.md §3's diagram draws a 'returned' edge off of. */
export const RETURN_DISPOSITIONS: ReturnDispositionOption[] = [
  {
    value: "sellable",
    label: "Sellable",
    hint: "Restocks the exact quantity this order shipped, at the location it shipped from.",
  },
  {
    value: "damaged",
    label: "Damaged / not resellable",
    hint: "Marks the order returned without adding anything back to available stock.",
  },
];

/** Whether the order detail page should render the dedicated return form --
 *  delegates to isValidOrderTransition the same way isOrderCancellable does,
 *  so this can never drift out of sync with what the state machine (and
 *  therefore OrderService.transition) actually allows. */
export function isOrderReturnable(status: OrderStatus): boolean {
  return isValidOrderTransition(status, "returned");
}

export function manualOrderActions(status: OrderStatus): OrderManualAction[] {
  return MANUAL_ORDER_ACTIONS[status] ?? [];
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
