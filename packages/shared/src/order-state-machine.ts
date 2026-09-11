import type { OrderStatus } from "./types.js";

// Encodes the diagram in CLAUDE.md §3:
//
//   received → validated → allocated → picking → packed → shipped → delivered
//                 |             |                              |
//              on_hold     backordered                    returned/refunded
//                              |
//                          cancelled
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
//
// ON_HOLD / BACKORDERED RESOLUTION -- also decided explicitly (the diagram
// doesn't show how either resolves back into the main flow):
//  - a released hold returns to 'validated', not straight to 'allocated' --
//    it re-enters the normal flow rather than skipping the allocation
//    decision. See OrderService's `validated` manual-action doc comment for
//    why a *manual* validated -> allocated action had to be added alongside
//    this: outside of fresh channel-pull ingestion (which auto-chains
//    validated -> allocated with no gap), nothing else advances a
//    'validated' order on its own, so without that action a resumed order
//    would dead-end at 'validated'.
//  - backordered -> allocated is a manual retry (a person re-triggers it
//    once they know stock is back), not automatic on inventory receipt --
//    simpler for now, no new event-subscription infrastructure required.
// Both re-run the exact same allocateOrder() sufficiency check an initial
// allocation attempt does, so a retry that's still short on stock just
// lands back on 'backordered' rather than erroring.
export const ORDER_STATE_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  received: ["validated", "cancelled"],
  validated: ["allocated", "on_hold", "cancelled"],
  on_hold: ["validated", "cancelled"],
  allocated: ["picking", "backordered", "cancelled"],
  backordered: ["allocated", "cancelled"],
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
