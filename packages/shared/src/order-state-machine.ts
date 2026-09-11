import type { OrderStatus } from "./types.js";

// Encodes the diagram in CLAUDE.md §3:
//
//   received → validated → allocated → picking → packed → shipped → delivered
//                 |             |                              |
//              on_hold     backordered                    returned/refunded
//                              |
//                          cancelled
//
// The diagram doesn't show how on_hold/backordered resolve back into the
// main flow (e.g. does a released hold return to `validated`, or move
// straight to `allocated`?) — that's a product decision for order-service to
// make explicitly, not something to infer here. Still undecided; no edges
// out of on_hold/backordered other than the cancellation ones below exist
// yet.
//
// CANCELLATION SCOPE -- decided explicitly, not inferred from the diagram
// (which literally only draws backordered -> cancelled): a cancellable
// order is any order that hasn't been physically packed yet --
// received/validated/on_hold/backordered/allocated/picking can all move to
// 'cancelled'; packed/shipped cannot (see OrderService.cancelOrder's doc
// comment for why: past 'packed' the order is physically boxed, and
// undoing that needs a person to unpack it, not a button in this app;
// 'shipped' already has its own CLAUDE.md §3-drawn path to
// returned/refunded instead). CLAUDE.md §3's own text -- "Cancellation
// after allocation must emit a release inventory event, not just delete
// the reservation" -- already implies allocated-order cancellation is
// in-scope; this only makes that (and the picking case, which has the same
// live-reservation shape) explicit alongside it.
export const ORDER_STATE_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  received: ["validated", "cancelled"],
  validated: ["allocated", "on_hold", "cancelled"],
  on_hold: ["cancelled"],
  allocated: ["picking", "backordered", "cancelled"],
  backordered: ["cancelled"],
  picking: ["packed", "cancelled"],
  packed: ["shipped"],
  shipped: ["delivered", "returned", "refunded"],
  delivered: [],
  returned: [],
  refunded: [],
  cancelled: [],
};

export function isValidOrderTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_STATE_TRANSITIONS[from].includes(to);
}
