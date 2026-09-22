import { NextResponse, type NextRequest } from "next/server";
import { withTenant, encryptChannelSecret } from "@alltix/db";
import { TikTokConnector, TIKTOK_API_BASE_URL, buildTikTokAuthorizeUrl } from "@alltix/channel-connectors";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser, withTenantAuth, type TenantRequestContext } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";
import { createOAuthState } from "@/lib/tiktok-oauth-state";
import { readTikTokOAuthAppConfig } from "@/lib/tiktok-oauth-config";

export const dynamic = "force-dynamic";

/**
 * GET /api/channels/tiktok/connect -- redirects to TikTok Shop's OAuth
 * consent screen (the "Connect via TikTok OAuth" link on /settings/channels),
 * added alongside the POST manual-paste form below rather than replacing
 * it. Mirrors /api/channels/ebay/connect exactly (see that route's own doc
 * comment for the withTenantAuth-for-its-auth-step-only reasoning) --
 * genuine differences are pushed down into buildTikTokAuthorizeUrl() itself
 * (no redirectUri param; see tiktok-oauth.ts's own header comment), not
 * this route.
 *
 * The manual-paste POST form stays: it remains the only path for a tenant
 * whose TikTok Shop application issues long-lived tokens directly (no
 * consent-screen flow to redirect through), and is a useful fallback if the
 * OAuth path below turns out to be wrong once a real TikTok application
 * exists to test it against (see tiktok-oauth.ts's own "UNVERIFIED IN
 * PRACTICE" note).
 */
async function connectTikTokViaOAuth(_req: NextRequest, { tenantId }: TenantRequestContext): Promise<Response> {
  const { appKey } = readTikTokOAuthAppConfig();
  const state = createOAuthState(tenantId);
  const authorizeUrl = buildTikTokAuthorizeUrl(appKey, state);
  return NextResponse.redirect(authorizeUrl);
}

export const GET = withTenantAuth(connectTikTokViaOAuth);

/**
 * POST /api/channels/tiktok/connect -- persists a tenant's TikTok Shop Open
 * Platform credentials from the /settings/channels "Connect TikTok Shop
 * (manual)" form.
 *
 * Five fields instead of the usual two/three -- more than any other channel
 * in this codebase -- because TikTok Shop's own credential model genuinely
 * has five independent parts (see TikTokCredentials' own doc comment in
 * tiktok-connector.ts): appKey, appSecret, accessToken, refreshToken, and
 * shopCipher (a real, independent per-shop identifier, unlike every other
 * channel's own reuse of external_account_id).
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
 * where that last column holds what its name actually says). The GET
 * OAuth-redirect handler above and its callback (../callback/route.ts)
 * write to the exact same columns, so either path can reconnect/overwrite
 * what the other one stored.
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
