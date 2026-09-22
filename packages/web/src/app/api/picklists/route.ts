import type { NextRequest } from "next/server";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { getWarehouseService } from "@/lib/services";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";
import { checkRateLimit, RATE_LIMIT_ERROR_MESSAGE } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** POST /api/picklists -- generates a picklist covering the selected
 *  'allocated' orders (WarehouseService.generatePicklist), from the
 *  checkbox form on /picklists. Plain HTML form POST, not JSON: this page
 *  works with no client JS. */
export async function POST(req: NextRequest): Promise<Response> {
  const pool = getAppPool();
  const user = await requireCurrentUser(req, pool);
  if (!user) {
    return redirectWithError(req, "/picklists", "not signed in");
  }

  if (await checkRateLimit(pool, user.tenantId, "picklists.create")) {
    return redirectWithError(req, "/picklists", RATE_LIMIT_ERROR_MESSAGE);
  }

  const formData = await req.formData();
  const orderIds = formData.getAll("orderIds").map(String).filter(Boolean);
  if (orderIds.length === 0) {
    return redirectWithError(req, "/picklists", "Select at least one order to generate a picklist.");
  }

  try {
    await getWarehouseService().generatePicklist(user.tenantId, orderIds, user.id);
  } catch (err) {
    return redirectWithError(req, "/picklists", errorMessage(err));
  }

  return redirectTo(req, "/picklists");
}
