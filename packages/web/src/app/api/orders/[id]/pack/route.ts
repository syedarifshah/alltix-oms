import type { NextRequest } from "next/server";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { getWarehouseService } from "@/lib/services";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

/** POST /api/orders/[id]/pack -- resolves an order's picking outcome into
 *  'packed' (WarehouseService.packOrder), reconciling any short-picked
 *  lines into the ledger first. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const user = await requireCurrentUser(req, getAppPool());
  if (!user) {
    return redirectWithError(req, "/picklists", "not signed in");
  }

  const { id } = await ctx.params;

  try {
    await getWarehouseService().packOrder(user.tenantId, id);
  } catch (err) {
    return redirectWithError(req, "/picklists", errorMessage(err));
  }

  return redirectTo(req, "/picklists");
}
