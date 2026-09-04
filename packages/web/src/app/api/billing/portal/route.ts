import type { NextRequest } from "next/server";
import { createPortalSession } from "@alltix/billing-service";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectWithError, errorMessage } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

/** POST /api/billing/portal -- opens Stripe's hosted Customer Portal for
 *  managing or canceling a subscription (CLAUDE.md §6: no custom UI for
 *  anything Stripe already hosts). */
export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireCurrentUser(req, getAppPool());
  if (!user) {
    return redirectWithError(req, "/settings/billing", "not signed in");
  }

  const returnUrl = `${req.nextUrl.origin}/settings/billing`;

  try {
    const { url } = await createPortalSession(getAppPool(), user.tenantId, returnUrl);
    return Response.redirect(url, 303);
  } catch (err) {
    return redirectWithError(req, "/settings/billing", errorMessage(err));
  }
}
