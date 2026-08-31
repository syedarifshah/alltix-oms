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
// make explicitly, not something to infer here. Only the edges the diagram
// actually draws are included below.
export const ORDER_STATE_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  received: ["validated"],
  validated: ["allocated", "on_hold"],
  on_hold: [],
  allocated: ["picking", "backordered"],
  backordered: ["cancelled"],
  picking: ["packed"],
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
