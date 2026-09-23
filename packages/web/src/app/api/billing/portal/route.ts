import type { NextRequest } from "next/server";
import { createPortalSession } from "@alltix/billing-service";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectWithError, errorMessage } from "@/lib/route-helpers";
import { checkRateLimit, RATE_LIMIT_ERROR_MESSAGE } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** POST /api/billing/portal -- opens Stripe's hosted Customer Portal for
 *  managing or canceling a subscription (CLAUDE.md §6: no custom UI for
 *  anything Stripe already hosts). */
export async function POST(req: NextRequest): Promise<Response> {
  const pool = getAppPool();
  const user = await requireCurrentUser(req, pool);
  if (!user) {
    return redirectWithError(req, "/settings/billing", "not signed in");
  }

  if (await checkRateLimit(pool, user.tenantId, "billing.portal")) {
    return redirectWithError(req, "/settings/billing", RATE_LIMIT_ERROR_MESSAGE);
  }

  const returnUrl = `${req.nextUrl.origin}/settings/billing`;

  try {
    const { url } = await createPortalSession(getAppPool(), user.tenantId, returnUrl, user.id);
    return Response.redirect(url, 303);
  } catch (err) {
    return redirectWithError(req, "/settings/billing", errorMessage(err));
  }
}
