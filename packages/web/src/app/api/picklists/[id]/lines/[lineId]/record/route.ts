import type { NextRequest } from "next/server";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { getWarehouseService } from "@/lib/services";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

/** POST /api/picklists/[id]/lines/[lineId]/record -- records what a picker
 *  actually pulled for one picklist line (WarehouseService.recordPick). The
 *  picklist id in the URL is only used to redirect back to the right page;
 *  recordPick itself resolves the line's own picklist internally. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; lineId: string }> }): Promise<Response> {
  const user = await requireCurrentUser(req, getAppPool());
  if (!user) {
    return redirectWithError(req, "/picklists", "not signed in");
  }

  const { lineId } = await ctx.params;
  const formData = await req.formData();
  const quantityPicked = Number(formData.get("quantityPicked"));
  const damaged = formData.get("damaged") === "on";

  if (!Number.isInteger(quantityPicked) || quantityPicked < 0) {
    return redirectWithError(req, "/picklists", "Quantity picked must be a non-negative whole number.");
  }

  try {
    await getWarehouseService().recordPick(user.tenantId, lineId, quantityPicked, damaged);
  } catch (err) {
    return redirectWithError(req, "/picklists", errorMessage(err));
  }

  return redirectTo(req, "/picklists");
}
