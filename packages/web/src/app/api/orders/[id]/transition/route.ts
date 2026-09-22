import type { NextRequest } from "next/server";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { getOrderService } from "@/lib/services";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";
import { isOrderStatus } from "@/lib/order-status";
import { checkRateLimit, RATE_LIMIT_ERROR_MESSAGE } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * POST /api/orders/[id]/transition -- generic guarded status flip backing
 * every order-detail-page manual action from lib/order-status.ts's
 * `manualOrderActions` EXCEPT cancellation, which keeps its own dedicated
 * /cancel route (see that file): cancelling is the one transition with a
 * side effect (releasing reserved inventory) that predates this route and
 * was already shipped/verified on its own. Every transition this route can
 * reach -- resume (on_hold -> validated), retry/allocate (-> allocated via
 * OrderService.allocateOrder), and the shipped -> delivered/returned/
 * refunded flips -- is a plain OrderService.simpleTransition or
 * allocateOrder call, both of which already reject an invalid `from -> to`
 * pair via isValidOrderTransition before touching the database. So this
 * route doesn't need its own allowlist beyond what OrderService.transition
 * already enforces -- it's just the HTTP plumbing.
 *
 * `from` and `to` both come from hidden fields on the order detail page's
 * own per-action forms: `from` is the order's current status as that page
 * just rendered it, `to` is whichever fixed target that particular form
 * represents. Same "stale/tampered input just fails the guarded UPDATE
 * cleanly, no extra SELECT needed first" reasoning as /cancel's own doc
 * comment.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const pool = getAppPool();
  const user = await requireCurrentUser(req, pool);
  if (!user) {
    return redirectWithError(req, "/orders", "not signed in");
  }

  const { id } = await ctx.params;

  if (await checkRateLimit(pool, user.tenantId, "orders.transition")) {
    return redirectWithError(req, `/orders/${id}`, RATE_LIMIT_ERROR_MESSAGE);
  }

  const formData = await req.formData();
  const from = formData.get("from");
  const to = formData.get("to");

  if (typeof from !== "string" || !isOrderStatus(from) || typeof to !== "string" || !isOrderStatus(to)) {
    return redirectWithError(req, `/orders/${id}`, "Missing or invalid order status.");
  }

  try {
    await getOrderService().transition(user.tenantId, id, from, to);
  } catch (err) {
    return redirectWithError(req, `/orders/${id}`, errorMessage(err));
  }

  return redirectTo(req, `/orders/${id}`);
}
