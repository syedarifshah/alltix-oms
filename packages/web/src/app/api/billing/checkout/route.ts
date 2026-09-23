import type { NextRequest } from "next/server";
import { createCheckoutSession } from "@alltix/billing-service";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectWithError, errorMessage } from "@/lib/route-helpers";
import { checkRateLimit, RATE_LIMIT_ERROR_MESSAGE } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** POST /api/billing/checkout -- starts a subscription via Stripe's hosted
 *  Checkout (CLAUDE.md §6: no custom card-collection UI). Redirects
 *  straight to the returned Checkout URL rather than returning JSON, since
 *  this is a plain HTML form POST from /settings/billing. */
export async function POST(req: NextRequest): Promise<Response> {
  const pool = getAppPool();
  const user = await requireCurrentUser(req, pool);
  if (!user) {
    return redirectWithError(req, "/settings/billing", "not signed in");
  }

  if (await checkRateLimit(pool, user.tenantId, "billing.checkout")) {
    return redirectWithError(req, "/settings/billing", RATE_LIMIT_ERROR_MESSAGE);
  }

  const origin = req.nextUrl.origin;

  try {
    const { url } = await createCheckoutSession(getAppPool(), {
      tenantId: user.tenantId,
      successUrl: `${origin}/settings/billing?checkout=success`,
      cancelUrl: `${origin}/settings/billing?checkout=cancelled`,
      actorUserId: user.id,
    });
    return Response.redirect(url, 303);
  } catch (err) {
    return redirectWithError(req, "/settings/billing", errorMessage(err));
  }
}
