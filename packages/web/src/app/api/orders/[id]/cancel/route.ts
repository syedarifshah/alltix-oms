import type { NextRequest } from "next/server";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { getOrderService } from "@/lib/services";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";
import { isOrderStatus } from "@/lib/order-status";

export const dynamic = "force-dynamic";

/**
 * POST /api/orders/[id]/cancel -- cancels an order (OrderService.transition
 * with to='cancelled'; see OrderService.cancelOrder's doc comment for which
 * states that's actually reachable from and what it releases).
 *
 * `from` comes from a hidden field on the order detail page's own Cancel
 * form, set to the order's status as that page just rendered it -- not
 * re-queried here first. That's deliberate, not a shortcut: OrderService's
 * guarded `UPDATE ... WHERE status = $from` (same pattern simpleTransition/
 * allocateOrder already use elsewhere in that file) is exactly the real
 * check, so a stale or tampered `from` value just fails the transition with
 * a clear error instead of silently doing the wrong thing -- an extra SELECT
 * here first wouldn't make this any safer, only slower.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const user = await requireCurrentUser(req, getAppPool());
  if (!user) {
    return redirectWithError(req, "/orders", "not signed in");
  }

  const { id } = await ctx.params;
  const formData = await req.formData();
  const from = formData.get("from");

  if (typeof from !== "string" || !isOrderStatus(from)) {
    return redirectWithError(req, `/orders/${id}`, "Missing or invalid current order status.");
  }

  try {
    await getOrderService().transition(user.tenantId, id, from, "cancelled");
  } catch (err) {
    return redirectWithError(req, `/orders/${id}`, errorMessage(err));
  }

  return redirectTo(req, `/orders/${id}`);
}
