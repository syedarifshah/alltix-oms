import type { NextRequest } from "next/server";
import { withTenant, encryptChannelSecret } from "@alltix/db";
import { TemuConnector, TEMU_API_PRODUCTION_BASE_URL } from "@alltix/channel-connectors";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

/**
 * POST /api/channels/temu/connect -- persists a tenant's Temu Open Platform
 * credentials from the /settings/channels "Connect Temu" form.
 *
 * Same shape as /api/channels/walmart/connect (see that route's own doc
 * comment for the full reasoning), not Amazon's/eBay's OAuth redirect/
 * callback pair: Temu's accessToken is used directly on every signed
 * request with nothing to exchange (see TemuCredentials' own doc comment
 * in temu-connector.ts) -- an App Key, App Secret, and Access Token, issued
 * directly to the tenant's own Temu Open Platform application, are typed
 * into one plain HTML form and POSTed here in one step.
 *
 * Not wrapped in withTenantAuth for the identical reason the Walmart/
 * Shopify routes give: the first real step here is a network round trip
 * (TemuConnector.authenticate(), a live bg.open.accesstoken.info.get call)
 * to prove the triple actually works before persisting anything, and
 * holding a Postgres transaction open across that call is what
 * withTenantAuth's own doc comment warns against.
 *
 * No new migration needed -- see loadTemuCredentialsFromChannelConnection's
 * own doc comment in temu-connector.ts for the full column-reuse reasoning
 * (lwa_client_id = appKey, also reused into external_account_id;
 * encrypted_client_secret = appSecret; encrypted_access_token = accessToken,
 * the same column Shopify's own static token already uses for an identical
 * "long-lived, high-value, used directly" semantic).
 *
 * UNVERIFIED IN PRACTICE, more so than any other channel's connect route --
 * see TemuConnector's own class doc comment: no Temu credentials of any
 * kind exist anywhere in this codebase yet, and Temu's own documentation
 * was never even readable during this connector's research pass (unlike
 * Walmart, which at least had no self-serve sandbox but real, readable
 * docs). Submitting a wrong or placeholder triple here will correctly fail
 * at the authenticate() step below rather than silently "connecting"
 * nothing.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const pool = getAppPool();
  const user = await requireCurrentUser(req, pool);
  if (!user) {
    return redirectWithError(req, "/settings/channels", "not signed in");
  }

  const formData = await req.formData();
  const appKey = String(formData.get("appKey") ?? "").trim();
  const appSecret = String(formData.get("appSecret") ?? "").trim();
  const accessToken = String(formData.get("accessToken") ?? "").trim();

  if (!appKey || !appSecret || !accessToken) {
    return redirectWithError(req, "/settings/channels", "temu_missing_fields");
  }

  // Prove the triple actually authenticates against real Temu Open
  // Platform infrastructure before persisting anything -- same "verify
  // before persist" discipline as WalmartConnector's own connect route,
  // just via authenticate() itself here since TemuConnector has no separate
  // read-only verification call either (same reasoning, see that route's
  // own doc comment).
  const connector = new TemuConnector({ appKey, appSecret, accessToken }, TEMU_API_PRODUCTION_BASE_URL);
  try {
    await connector.authenticate();
  } catch (err) {
    return redirectWithError(req, "/settings/channels", `temu_verify_failed:${errorMessage(err)}`);
  }

  try {
    await withTenant(pool, user.tenantId, async (client) => {
      const encryptedAppSecret = await encryptChannelSecret(client, appSecret);
      const encryptedAccessToken = await encryptChannelSecret(client, accessToken);

      // external_account_id = appKey, marketplace = '' -- see
      // loadTemuCredentialsFromChannelConnection's own doc comment in
      // temu-connector.ts for why: no independent Temu seller identifier
      // this connector's calls need, so reusing appKey here is what keeps
      // the table's existing (tenant_id, channel, marketplace,
      // external_account_id) UNIQUE constraint meaningful, same as
      // Walmart's/eBay's own clientId reuse. Reconnecting with the SAME
      // appKey updates the existing row; a different appKey inserts a
      // second row rather than silently overwriting the first.
      await client.query(
        `INSERT INTO channel_connections
           (tenant_id, channel, marketplace, external_account_id, lwa_client_id,
            encrypted_client_secret, encrypted_access_token, status)
         VALUES ($1, 'temu', '', $2, $2, $3, $4, 'active')
         ON CONFLICT (tenant_id, channel, marketplace, external_account_id)
         DO UPDATE SET
           lwa_client_id = EXCLUDED.lwa_client_id,
           encrypted_client_secret = EXCLUDED.encrypted_client_secret,
           encrypted_access_token = EXCLUDED.encrypted_access_token,
           status = 'active',
           updated_at = now()`,
        [user.tenantId, appKey, encryptedAppSecret, encryptedAccessToken],
      );
    });
  } catch (err) {
    return redirectWithError(req, "/settings/channels", `temu_save_failed:${errorMessage(err)}`);
  }

  console.info(`Temu connected for tenant ${user.tenantId}: appKey ${appKey}`);

  return redirectTo(req, "/settings/channels?connected=temu");
}
