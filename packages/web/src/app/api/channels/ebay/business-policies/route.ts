import type { NextRequest } from "next/server";
import { withTenant } from "@alltix/db";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError } from "@/lib/route-helpers";
import { checkRateLimit, RATE_LIMIT_ERROR_MESSAGE } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * POST /api/channels/ebay/business-policies -- saves a tenant's choice of
 * fulfillment/payment/return business policy (one of the two Selling Setup
 * forms /settings/channels shows once eBay is connected but not yet ready
 * for EbayConnector.createListing(), see that page's own comment). Pure
 * persistence, no live eBay call here -- the options this form's `<select>`
 * offered were already fetched live and validated by eBay's own existence
 * (a tenant can only pick an id eBay itself returned), so there's nothing
 * left to verify before saving. Unlike the Shopify/Walmart connect routes
 * (which authenticate live before persisting anything), this route trusts
 * the page that rendered the form.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const pool = getAppPool();
  const user = await requireCurrentUser(req, pool);
  if (!user) {
    return redirectWithError(req, "/settings/channels", "ebay_policies_not_signed_in");
  }

  if (await checkRateLimit(pool, user.tenantId, "channels.ebay.business_policies")) {
    return redirectWithError(req, "/settings/channels", RATE_LIMIT_ERROR_MESSAGE);
  }

  const formData = await req.formData();
  const fulfillmentPolicyId = String(formData.get("fulfillmentPolicyId") ?? "").trim();
  const paymentPolicyId = String(formData.get("paymentPolicyId") ?? "").trim();
  const returnPolicyId = String(formData.get("returnPolicyId") ?? "").trim();

  if (!fulfillmentPolicyId || !paymentPolicyId || !returnPolicyId) {
    return redirectWithError(req, "/settings/channels", "ebay_policies_missing_fields");
  }

  const updated = await withTenant(pool, user.tenantId, (client) =>
    client.query(
      `UPDATE channel_connections
          SET ebay_fulfillment_policy_id = $1, ebay_payment_policy_id = $2, ebay_return_policy_id = $3,
              updated_at = now()
        WHERE tenant_id = $4 AND channel = 'ebay' AND status = 'active'`,
      [fulfillmentPolicyId, paymentPolicyId, returnPolicyId, user.tenantId],
    ),
  );

  if (updated.rowCount === 0) {
    return redirectWithError(req, "/settings/channels", "ebay_policies_no_active_connection");
  }

  return redirectTo(req, "/settings/channels?connected=ebay_policies");
}
