import type { NextRequest } from "next/server";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { getOrderService } from "@/lib/services";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";
import { isOrderStatus, RETURN_DISPOSITIONS } from "@/lib/order-status";
import { checkRateLimit, RATE_LIMIT_ERROR_MESSAGE } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * POST /api/orders/[id]/return -- the order detail page's dedicated return
 * form (order-status.ts's RETURN_DISPOSITIONS), separate from the generic
 * /transition route the same way /cancel is: this transition has a real
 * side effect (restocking inventory for a 'sellable' disposition, see
 * OrderService.returnOrder's doc comment) that a plain `to` value on the
 * generic route can't express.
 *
 * Same "trust the hidden `from` field, let the guarded UPDATE be the real
 * check" reasoning as /cancel's own doc comment -- a stale or tampered
 * `from` just fails the transition cleanly. `disposition` is validated
 * against RETURN_DISPOSITIONS (the same list the form itself rendered as
 * radio options) rather than accepted as an arbitrary string -- an invalid
 * or missing value fails here with a clear message instead of reaching
 * OrderService.transition only to throw its own less specific error.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const pool = getAppPool();
  const user = await requireCurrentUser(req, pool);
  if (!user) {
    return redirectWithError(req, "/orders", "not signed in");
  }

  const { id } = await ctx.params;

  if (await checkRateLimit(pool, user.tenantId, "orders.return")) {
    return redirectWithError(req, `/orders/${id}`, RATE_LIMIT_ERROR_MESSAGE);
  }

  const formData = await req.formData();
  const from = formData.get("from");
  const disposition = formData.get("disposition");

  if (typeof from !== "string" || !isOrderStatus(from)) {
    return redirectWithError(req, `/orders/${id}`, "Missing or invalid current order status.");
  }
  if (typeof disposition !== "string" || !RETURN_DISPOSITIONS.some((option) => option.value === disposition)) {
    return redirectWithError(req, `/orders/${id}`, "Choose whether the returned item is sellable or damaged.");
  }

  try {
    await getOrderService().transition(user.tenantId, id, from, "returned", {
      disposition: disposition as (typeof RETURN_DISPOSITIONS)[number]["value"],
    });
  } catch (err) {
    return redirectWithError(req, `/orders/${id}`, errorMessage(err));
  }

  return redirectTo(req, `/orders/${id}`);
}
