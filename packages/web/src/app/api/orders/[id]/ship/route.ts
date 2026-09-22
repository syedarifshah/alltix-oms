import type { NextRequest } from "next/server";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { getWarehouseService } from "@/lib/services";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";
import { checkRateLimit, RATE_LIMIT_ERROR_MESSAGE } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * POST /api/orders/[id]/ship -- confirms shipment with the order's channel
 * and, only once that succeeds, transitions 'packed' -> 'shipped'
 * (WarehouseService.confirmShipment). For an Amazon order this is a real
 * call to AmazonConnector.confirmShipment() against whatever channel
 * connection is on file for the tenant (sandbox, in this repo's current
 * setup) -- not mocked. Amazon SP-API production writes are otherwise out
 * of scope for this MVP pass (pushInventory/submitListing aren't exposed
 * anywhere in this UI, pending the production role-grant review), but
 * confirmShipment against whatever channel connection actually exists is
 * the one write action WarehouseService itself implements as part of the
 * picking->packed->shipped flow this page surfaces.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const pool = getAppPool();
  const user = await requireCurrentUser(req, pool);
  if (!user) {
    return redirectWithError(req, "/picklists", "not signed in");
  }

  if (await checkRateLimit(pool, user.tenantId, "orders.ship")) {
    return redirectWithError(req, "/picklists", RATE_LIMIT_ERROR_MESSAGE);
  }

  const { id } = await ctx.params;
  const formData = await req.formData();
  const carrier = String(formData.get("carrier") ?? "").trim();
  const trackingNumber = String(formData.get("trackingNumber") ?? "").trim();

  if (!carrier || !trackingNumber) {
    return redirectWithError(req, "/picklists", "Carrier and tracking number are required.");
  }

  try {
    await getWarehouseService().confirmShipment(user.tenantId, id, {
      carrier,
      trackingNumber,
      shippedAt: new Date().toISOString(),
    });
  } catch (err) {
    return redirectWithError(req, "/picklists", errorMessage(err));
  }

  return redirectTo(req, "/picklists");
}
