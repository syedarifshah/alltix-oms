import type { NextRequest } from "next/server";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { getWarehouseService } from "@/lib/services";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

/** POST /api/picklists -- generates a picklist covering the selected
 *  'allocated' orders (WarehouseService.generatePicklist), from the
 *  checkbox form on /picklists. Plain HTML form POST, not JSON: this page
 *  works with no client JS. */
export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireCurrentUser(req, getAppPool());
  if (!user) {
    return redirectWithError(req, "/picklists", "not signed in");
  }

  const formData = await req.formData();
  const orderIds = formData.getAll("orderIds").map(String).filter(Boolean);
  if (orderIds.length === 0) {
    return redirectWithError(req, "/picklists", "Select at least one order to generate a picklist.");
  }

  try {
    await getWarehouseService().generatePicklist(user.tenantId, orderIds);
  } catch (err) {
    return redirectWithError(req, "/picklists", errorMessage(err));
  }

  return redirectTo(req, "/picklists");
}
