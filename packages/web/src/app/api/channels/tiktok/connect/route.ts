import type { NextRequest } from "next/server";
import { withTenant, encryptChannelSecret } from "@alltix/db";
import { TikTokConnector, TIKTOK_API_BASE_URL } from "@alltix/channel-connectors";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

/**
 * POST /api/channels/tiktok/connect -- persists a tenant's TikTok Shop Open
 * Platform credentials from the /settings/channels "Connect TikTok Shop"
 * form.
 *
 * Five fields instead of the usual two/three -- more than any other channel
 * in this codebase -- because TikTok Shop's own credential model genuinely
 * has five independent parts (see TikTokCredentials' own doc comment in
 * tiktok-connector.ts): appKey, appSecret, accessToken, refreshToken, and
 * shopCipher (a real, independent per-shop identifier, unlike every other
 * channel's own reuse of external_account_id).
 *
 * Not an OAuth redirect/callback pair like Amazon's/eBay's own connect
 * flow -- same reasoning as Temu's connect route: all five values are typed
 * directly into one plain HTML form (Arif's own tenant already holds them,
 * issued directly by TikTok's own seller/developer console) and POSTed here
 * in one step. A real OAuth authorize-redirect flow could replace this
 * later; this pass mirrors the shape every other single-step-credential
 * channel already uses.
 *
 * Not wrapped in withTenantAuth for the same reason the Walmart/Shopify/
 * Temu routes give: the first real step here is a network round trip
 * (TikTokConnector.authenticate(), a live GET /api/v2/token/refresh call) to
 * prove the credentials actually work before persisting anything, and
 * holding a Postgres transaction open across that call is what
 * withTenantAuth's own doc comment warns against.
 *
 * No new migration needed -- see
 * loadTikTokCredentialsFromChannelConnection's own doc comment in
 * tiktok-connector.ts for the full column-reuse reasoning (lwa_client_id =
 * appKey, encrypted_client_secret = appSecret, encrypted_access_token =
 * accessToken, encrypted_refresh_token = refreshToken,
 * external_account_id = shopCipher -- the one channel in this codebase
 * where that last column holds what its name actually says).
 *
 * UNVERIFIED IN PRACTICE, more so than any other channel's connect route --
 * see TikTokConnector's own class doc comment: no TikTok credentials of any
 * kind exist anywhere in this codebase yet, and TikTok's own official docs
 * were never readable during this connector's research pass (same
 * "unreadable JS SPA" problem Temu's own docs had). Submitting a wrong or
 * placeholder set of values here will correctly fail at the authenticate()
 * step below rather than silently "connecting" nothing.
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
  const refreshToken = String(formData.get("refreshToken") ?? "").trim();
  const shopCipher = String(formData.get("shopCipher") ?? "").trim();

  if (!appKey || !appSecret || !accessToken || !refreshToken || !shopCipher) {
    return redirectWithError(req, "/settings/channels", "tiktok_missing_fields");
  }

  // Prove the credential set actually authenticates against real TikTok
  // Shop Open Platform infrastructure before persisting anything -- same
  // "verify before persist" discipline as every other channel's own
  // connect route.
  const connector = new TikTokConnector(
    { appKey, appSecret, accessToken, refreshToken, shopCipher },
    TIKTOK_API_BASE_URL,
  );
  try {
    await connector.authenticate();
  } catch (err) {
    return redirectWithError(req, "/settings/channels", `tiktok_verify_failed:${errorMessage(err)}`);
  }

  try {
    await withTenant(pool, user.tenantId, async (client) => {
      const encryptedAppSecret = await encryptChannelSecret(client, appSecret);
      const encryptedAccessToken = await encryptChannelSecret(client, accessToken);
      const encryptedRefreshToken = await encryptChannelSecret(client, refreshToken);

      // external_account_id = shopCipher, marketplace = '' -- see
      // loadTikTokCredentialsFromChannelConnection's own doc comment in
      // tiktok-connector.ts. Reconnecting with the SAME shopCipher updates
      // the existing row; a different shopCipher (a second TikTok shop
      // under the same app) inserts a second row rather than silently
      // overwriting the first.
      await client.query(
        `INSERT INTO channel_connections
           (tenant_id, channel, marketplace, external_account_id, lwa_client_id,
            encrypted_client_secret, encrypted_access_token, encrypted_refresh_token, status)
         VALUES ($1, 'tiktok', '', $2, $3, $4, $5, $6, 'active')
         ON CONFLICT (tenant_id, channel, marketplace, external_account_id)
         DO UPDATE SET
           lwa_client_id = EXCLUDED.lwa_client_id,
           encrypted_client_secret = EXCLUDED.encrypted_client_secret,
           encrypted_access_token = EXCLUDED.encrypted_access_token,
           encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
           status = 'active',
           updated_at = now()`,
        [user.tenantId, shopCipher, appKey, encryptedAppSecret, encryptedAccessToken, encryptedRefreshToken],
      );
    });
  } catch (err) {
    return redirectWithError(req, "/settings/channels", `tiktok_save_failed:${errorMessage(err)}`);
  }

  console.info(`TikTok Shop connected for tenant ${user.tenantId}: shopCipher ${shopCipher}`);

  return redirectTo(req, "/settings/channels?connected=tiktok");
}
