import { NextResponse, type NextRequest } from "next/server";
import { withTenant, encryptChannelSecret } from "@alltix/db";
import {
  parseTikTokOAuthCallback,
  exchangeTikTokAuthorizationCode,
  getTikTokAuthorizedShops,
  type TikTokAuthorizedShop,
} from "@alltix/channel-connectors";
import { getAppPool } from "@/lib/db";
import { getAuthContext } from "@/lib/auth-context";
import { resolveTenantId } from "@/lib/with-tenant-auth";
import { verifyOAuthState } from "@/lib/tiktok-oauth-state";
import { readTikTokOAuthAppConfig } from "@/lib/tiktok-oauth-config";

export const dynamic = "force-dynamic";

// No real seller has ever hit this against this repo's TikTok Shop
// application -- no application is registered at all yet (see
// .env.example's TIKTOK_* entries), and unlike eBay's own callback (whose
// own doc comment records this project's cloud sandbox as CONFIRMED to
// block api.ebay.com/api.sandbox.ebay.com at the proxy level), this
// environment's ability to reach TikTok's OAuth hosts has never actually
// been tested either way. Implemented anyway per Arif's own explicit
// "Build it, documented as unverified" decision (AskUserQuestion,
// 2026-09-22) -- state sign/verify follows the same pattern already
// unit-tested for Amazon's/eBay's equivalents.
//
// Takes only the FIRST shop returned by getTikTokAuthorizedShops() --
// TikTok Shop Open Platform's own multi-shop-per-authorization model (see
// TikTokCredentials' own doc comment in tiktok-connector.ts: "one
// app_key/access_token pair can cover several shops, each with its own
// shop_cipher") means a tenant authorizing more than one shop under the
// same app would silently only get the first one connected here. A real
// shop-picker step (list every returned shop, let the tenant choose, maybe
// loop to connect more than one) is real, deliberately deferred follow-up
// work -- flagged here rather than silently wrong, same discipline this
// codebase applies to every other known-incomplete piece (CLAUDE.md's own
// "inventory.changed... not retroactive" entry is the most recent example).

function redirectWithError(req: NextRequest, error: string): Response {
  const url = new URL("/settings/channels", req.url);
  url.searchParams.set("error", error);
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest): Promise<Response> {
  const searchParams = req.nextUrl.searchParams;

  // A seller who declines consent is redirected back with an `error` param
  // instead of `code`/`state` -- same check every other channel's own
  // callback route makes first, before attempting to parse a success shape.
  const tiktokError = searchParams.get("error");
  if (tiktokError) {
    return redirectWithError(req, `tiktok_declined:${tiktokError}`);
  }

  const callback = parseTikTokOAuthCallback(searchParams);
  if (!callback) {
    return redirectWithError(req, "tiktok_missing_callback_params");
  }

  const tenantIdFromState = verifyOAuthState(callback.state);
  if (!tenantIdFromState) {
    return redirectWithError(req, "tiktok_invalid_or_expired_state");
  }

  // Application-layer defense-in-depth on top of the signed state token,
  // same reasoning as every other channel's own callback's identical check.
  const authContext = await getAuthContext(req.headers);
  if (!authContext) {
    return redirectWithError(req, "tiktok_not_signed_in");
  }
  const pool = getAppPool();
  const tenantIdFromSession = await resolveTenantId(pool, authContext.clerkUserId);
  if (!tenantIdFromSession || tenantIdFromSession !== tenantIdFromState) {
    return redirectWithError(req, "tiktok_tenant_mismatch");
  }

  const { appKey, appSecret } = readTikTokOAuthAppConfig();

  let accessToken: string;
  let refreshToken: string;
  try {
    ({ accessToken, refreshToken } = await exchangeTikTokAuthorizationCode(callback.code, { appKey, appSecret }));
  } catch (err) {
    console.error("TikTok authorization-code exchange failed:", err instanceof Error ? err.message : err);
    return redirectWithError(req, "tiktok_token_exchange_failed");
  }

  // shop_cipher isn't part of the token-exchange response itself -- a
  // separate signed lookup, see tiktok-oauth.ts's own header comment.
  let shops: TikTokAuthorizedShop[];
  try {
    shops = await getTikTokAuthorizedShops({ appKey, appSecret, accessToken });
  } catch (err) {
    console.error("TikTok authorized-shops lookup failed:", err instanceof Error ? err.message : err);
    return redirectWithError(req, "tiktok_authorized_shops_lookup_failed");
  }
  const shopCipher = shops[0]?.cipher;
  if (!shopCipher) {
    return redirectWithError(req, "tiktok_no_authorized_shops");
  }

  // Same column mapping the POST manual-paste handler in ../connect/route.ts
  // writes to -- see loadTikTokCredentialsFromChannelConnection's own doc
  // comment in tiktok-connector.ts for the full reasoning.
  await withTenant(pool, tenantIdFromState, async (client) => {
    const encryptedAppSecret = await encryptChannelSecret(client, appSecret);
    const encryptedAccessToken = await encryptChannelSecret(client, accessToken);
    const encryptedRefreshToken = await encryptChannelSecret(client, refreshToken);

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
      [tenantIdFromState, shopCipher, appKey, encryptedAppSecret, encryptedAccessToken, encryptedRefreshToken],
    );
  });

  const url = new URL("/settings/channels", req.url);
  url.searchParams.set("connected", "tiktok");
  return NextResponse.redirect(url);
}
