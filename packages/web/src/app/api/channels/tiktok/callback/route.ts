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
import { resolveCurrentUser } from "@/lib/with-tenant-auth";
import { verifyOAuthState } from "@/lib/tiktok-oauth-state";
import { readTikTokOAuthAppConfig } from "@/lib/tiktok-oauth-config";
import { persistTikTokConnection } from "@/lib/tiktok-connection";
import { createPendingTikTokConnectionToken } from "@/lib/tiktok-oauth-pending";

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
// TikTok Shop Open Platform's own multi-shop-per-authorization model (see
// TikTokCredentials' own doc comment in tiktok-connector.ts: "one
// app_key/access_token pair can cover several shops, each with its own
// shop_cipher") means getTikTokAuthorizedShops() can return more than one
// shop. This used to silently connect only the first one (flagged as a
// Known Follow-up in CLAUDE.md); now, whenever there's more than one, this
// route redirects to /settings/channels/tiktok-shops instead of guessing --
// a real shop-picker page that lets the tenant choose, via a signed,
// encrypted-secrets pending-connection token (tiktok-oauth-pending.ts, see
// its own header comment for why the secrets travel encrypted rather than
// in the clear). A single shop is still connected directly, no extra hop,
// same as before.
//
// Deliberately still "pick exactly one," not "connect every shop this
// authorization covers" -- loadTikTokCredentialsFromChannelConnection
// (tiktok-connector.ts) reads only the most recently created ACTIVE
// 'tiktok' row per tenant (`ORDER BY created_at DESC LIMIT 1`), so every
// real caller (the scheduler's sync job, WarehouseService.confirmShipment())
// only ever uses ONE connection per tenant today regardless of how many
// rows exist. Connecting several shops at once here would look complete
// but silently only ever use whichever was created last -- true concurrent
// multi-shop support needs that loading layer to change first, real,
// separate, deliberately out of scope for this pass (see CLAUDE.md's Known
// Follow-ups).

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
  const currentUser = await resolveCurrentUser(pool, authContext.clerkUserId);
  if (!currentUser || currentUser.tenantId !== tenantIdFromState) {
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
  if (shops.length === 0) {
    return redirectWithError(req, "tiktok_no_authorized_shops");
  }

  // Exactly one shop: connect it directly, no extra hop -- this is still
  // the common case (a self-testing tenant's own single shop) and stays as
  // fast as it was before the picker existed.
  if (shops.length === 1) {
    await persistTikTokConnection(
      pool,
      tenantIdFromState,
      { appKey, appSecret, accessToken, refreshToken, shopCipher: shops[0]!.cipher },
      currentUser.id,
    );
    const url = new URL("/settings/channels", req.url);
    url.searchParams.set("connected", "tiktok");
    return NextResponse.redirect(url);
  }

  // More than one shop: nothing gets persisted yet -- hand off to the
  // picker page via a signed, encrypted-secrets pending token instead of
  // guessing which one the tenant wants (see this file's own header
  // comment, and tiktok-oauth-pending.ts for why the secrets travel
  // encrypted rather than in the clear).
  const pendingToken = await withTenant(pool, tenantIdFromState, async (client) => {
    const [encryptedAppSecret, encryptedAccessToken, encryptedRefreshToken] = await Promise.all([
      encryptChannelSecret(client, appSecret),
      encryptChannelSecret(client, accessToken),
      encryptChannelSecret(client, refreshToken),
    ]);
    return createPendingTikTokConnectionToken({
      tenantId: tenantIdFromState,
      appKey,
      encryptedAppSecret: encryptedAppSecret.toString("base64"),
      encryptedAccessToken: encryptedAccessToken.toString("base64"),
      encryptedRefreshToken: encryptedRefreshToken.toString("base64"),
      shops: shops.map((shop) => ({ cipher: shop.cipher, name: typeof shop.name === "string" ? shop.name : undefined, region: typeof shop.region === "string" ? shop.region : undefined })),
    });
  });

  const pickerUrl = new URL("/settings/channels/tiktok-shops", req.url);
  pickerUrl.searchParams.set("token", pendingToken);
  return NextResponse.redirect(pickerUrl);
}
