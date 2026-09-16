import type { NextRequest } from "next/server";
import { withTenant } from "@alltix/db";
import { createEbayConnectorFromChannelConnection } from "@alltix/channel-connectors";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

/**
 * POST /api/channels/ebay/location -- the other of the two Selling Setup
 * forms /settings/channels shows (see that page's own comment), and unlike
 * the business-policies route this one IS a real write against eBay's own
 * Inventory API (EbayConnector.createMerchantLocation()) before persisting
 * anything locally -- same "verify against the real API before saving"
 * discipline the Shopify/Walmart connect routes already follow.
 *
 * merchantLocationKey (the path segment eBay's own API uses to identify
 * this location on every future call, max 36 chars per eBay's own docs) is
 * generated here, not collected from the tenant -- a plain, opaque,
 * per-tenant-unique value with nothing user-facing about it. This
 * codebase's tenant id (a UUID, 36 chars WITH dashes) is used with its
 * dashes stripped (32 chars) to stay safely under that limit -- one
 * location per tenant for v1, same "one eBay connection per tenant" limit
 * channel_connections' own UNIQUE constraint already assumes.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const pool = getAppPool();
  const user = await requireCurrentUser(req, pool);
  if (!user) {
    return redirectWithError(req, "/settings/channels", "ebay_location_not_signed_in");
  }

  const formData = await req.formData();
  const name = String(formData.get("name") ?? "").trim();
  const addressLine1 = String(formData.get("addressLine1") ?? "").trim();
  const city = String(formData.get("city") ?? "").trim();
  const stateOrProvince = String(formData.get("stateOrProvince") ?? "").trim();
  const postalCode = String(formData.get("postalCode") ?? "").trim();
  const country = String(formData.get("country") ?? "").trim().toUpperCase();

  if (!name || !addressLine1 || !city || !stateOrProvince || !postalCode || !country) {
    return redirectWithError(req, "/settings/channels", "ebay_location_missing_fields");
  }

  let connector;
  try {
    connector = await createEbayConnectorFromChannelConnection(pool, user.tenantId);
  } catch (err) {
    return redirectWithError(req, "/settings/channels", `ebay_location_no_connection:${errorMessage(err)}`);
  }

  const merchantLocationKey = user.tenantId.replace(/-/g, "");
  const result = await connector.createMerchantLocation(merchantLocationKey, {
    name,
    addressLine1,
    city,
    stateOrProvince,
    postalCode,
    country,
  });
  if (!result.success) {
    return redirectWithError(req, "/settings/channels", `ebay_location_create_failed:${result.error ?? "unknown error"}`);
  }

  const updated = await withTenant(pool, user.tenantId, (client) =>
    client.query(
      `UPDATE channel_connections
          SET ebay_merchant_location_key = $1, updated_at = now()
        WHERE tenant_id = $2 AND channel = 'ebay' AND status = 'active'`,
      [merchantLocationKey, user.tenantId],
    ),
  );
  if (updated.rowCount === 0) {
    // eBay already has this location even though our own record of it
    // failed to save -- surface that clearly, same reasoning the Shopify/
    // Walmart/Amazon listing routes' own catch blocks document for the
    // equivalent "channel succeeded, local write didn't" gap.
    return redirectWithError(req, "/settings/channels", `ebay_location_created_but_not_recorded:${merchantLocationKey}`);
  }

  return redirectTo(req, "/settings/channels?connected=ebay_location");
}
