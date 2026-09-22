import type { NextRequest } from "next/server";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { getWarehouseService } from "@/lib/services";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";
import { checkRateLimit, RATE_LIMIT_ERROR_MESSAGE } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** POST /api/orders/[id]/pack -- resolves an order's picking outcome into
 *  'packed' (WarehouseService.packOrder), reconciling any short-picked
 *  lines into the ledger first. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const pool = getAppPool();
  const user = await requireCurrentUser(req, pool);
  if (!user) {
    return redirectWithError(req, "/picklists", "not signed in");
  }

  if (await checkRateLimit(pool, user.tenantId, "orders.pack")) {
    return redirectWithError(req, "/picklists", RATE_LIMIT_ERROR_MESSAGE);
  }

  const { id } = await ctx.params;

  try {
    await getWarehouseService().packOrder(user.tenantId, id, user.id);
  } catch (err) {
    return redirectWithError(req, "/picklists", errorMessage(err));
  }

  return redirectTo(req, "/picklists");
}
