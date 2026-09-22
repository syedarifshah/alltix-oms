import { TIKTOK_API_BASE_URL, TIKTOK_AUTH_BASE_URL, buildTikTokSignature } from "./tiktok-connector.js";

// TikTok Shop Open Platform's redirect-based OAuth flow -- the one-time
// "Connect TikTok Shop via OAuth" step that produces the appKey/appSecret/
// accessToken/refreshToken/shopCipher quintuple tiktok-connector.ts's own
// TikTokCredentials already needs, as an alternative to typing all five
// into the manual-paste form /api/channels/tiktok/connect's POST handler
// has used until now. Structurally closest to ebay-oauth.ts (a real
// authorization-code + refresh-token grant, distinct auth host from the
// business-API host) -- NOT eBay-identical, see the two genuine differences
// called out below.
//
// Built per Arif's own explicit "Build it, documented as unverified"
// decision (AskUserQuestion, 2026-09-22) after TikTok's own docs proved
// unreadable yet again (partner.tiktokshop.com/docv2/... -- every page
// fetched this pass, including "Authorization guide (202309)" and the
// specific refresh-token how-to page, returned only navigation chrome, same
// class of problem tiktok-connector.ts's own header comment already
// documents for the business-API side).
//
// RESEARCH TRAIL for this file specifically (tiktok-connector.ts's own
// header comment covers the business-API signing/endpoint side; this
// covers the three OAuth-specific pieces below), CROSS-CONFIRMED across
// four independent, non-copying sources rather than taken on one alone:
//   - A live, Google-indexed real TikTok Shop Seller Center URL
//     (services.tiktokshop.com/open/authorize?app_key=...) -- the single
//     highest-confidence source found, since it's an actual URL TikTok
//     itself generated and search-indexed, not a third party's
//     description of one.
//   - Chilkat's commercial code-example library (example-code.com), whose
//     TikTok Shop OAuth2 and "Get Authorized Shops" examples independently
//     gave the same auth.tiktok-shops.com/api/v2/token/get token-exchange
//     endpoint and the open-api.tiktokglobalshop.com/authorization/202309/
//     shops lookup endpoint tiktok-connector.ts's own base URLs already use.
//   - API2Cart's own integration documentation, which independently
//     confirmed the same token-exchange URL AND its exact query param
//     names (app_key/app_secret/auth_code/grant_type).
//   - A real, published third-party Ruby gem (rymndcs/tiktok_shop_rb_api)
//     whose README documents the same authorize-host/token-exchange shape
//     from actual working client code, and is the source for the two
//     genuine structural differences from eBay's own flow, below.
//
// TWO GENUINE STRUCTURAL DIFFERENCES from ebay-oauth.ts, not oversights:
//   1. NO redirect_uri. The Ruby gem's README states this plainly: "The
//      redirect URL is fixed in Partner Center, so there is no
//      redirect_uri: (passing one raises ArgumentError)." Unlike eBay's
//      RuName (passed on both the authorize URL and the token exchange),
//      TikTok Shop's callback URL is configured once, out-of-band, in the
//      Partner Center app's own settings -- buildTikTokAuthorizeUrl() and
//      exchangeTikTokAuthorizationCode() below deliberately take no such
//      parameter. Do not add one on the assumption this was forgotten.
//   2. `grant_type=authorized_code`, NOT the RFC 6749-standard
//      `authorization_code` eBay's/Amazon's own flows use -- confirmed
//      literally in API2Cart's shown query string. A real, TikTok-specific
//      spelling quirk, not a typo to "fix."
//
// shop_cipher is NOT returned by the token exchange itself (unlike, say, an
// OIDC id_token carrying the resource identifier directly) -- the Ruby
// gem's own README treats it as a separate step ("One authorization can
// cover several shops: list them" via its own authorized_shops call), which
// is why getTikTokAuthorizedShops() below is a second, separately-signed
// call the OAuth callback route makes after the token exchange, not part of
// the exchange response itself.
//
// UNVERIFIED IN PRACTICE, same status as every other piece of this
// codebase's TikTok wiring (see tiktok-connector.ts's own class doc
// comment): no TikTok credentials of any kind exist anywhere in this
// codebase yet, and this environment's ability to reach TikTok's OAuth
// hosts at all has never been tested (unlike eBay's flow, where this
// project's own cloud sandbox network policy was directly confirmed to
// block api.ebay.com/api.sandbox.ebay.com -- no equivalent check has been
// run against TikTok's hosts).

/** One global authorize host, same "one global host, region carried as
 *  data on the shop object" choice TIKTOK_API_BASE_URL's own doc comment
 *  already makes for the business API -- some third-party docs (API2Cart)
 *  additionally show a services.us.tiktokshop.com regional variant, not
 *  used here for the same "nothing to choose between was confirmed"
 *  reasoning TIKTOK_AUTH_BASE_URL's own doc comment gives for skipping a
 *  sandbox host. */
const TIKTOK_AUTHORIZE_URL = "https://services.tiktokshop.com/open/authorize";

export interface TikTokOAuthAppConfig {
  appKey: string;
  appSecret: string;
}

/** Builds the URL a "Connect TikTok Shop via OAuth" link redirects to.
 *  Deliberately takes no redirectUri/scope param -- see this file's header
 *  comment's "NO redirect_uri" note. `service_id`, which some third-party
 *  integration docs (API2Cart, the Ruby gem) show alongside `app_key`, is
 *  omitted here: the one live, TikTok-generated URL this research pass
 *  actually found indexed (services.tiktokshop.com/open/authorize?app_key=...)
 *  carries app_key alone, which reads as the higher-confidence source --
 *  `service_id` may simply be a third-party-integrator synonym for the same
 *  value under a different name, not a genuinely separate required param,
 *  but that is this codebase's own inference, not a confirmed fact. */
export function buildTikTokAuthorizeUrl(appKey: string, state: string): string {
  const params = new URLSearchParams({ app_key: appKey, state });
  return `${TIKTOK_AUTHORIZE_URL}?${params.toString()}`;
}

export interface TikTokOAuthCallbackQuery {
  code: string;
  state: string;
}

/** Parses the callback query params TikTok's consent redirect carries --
 *  `code`, `state`. Not confirmed from a literal official TikTok doc
 *  example (same "docs unreadable" problem this whole file documents) --
 *  inferred from standard OAuth2 Authorization Code Grant behavior (RFC
 *  6749 §4.1.2) and consistent with every third-party TikTok Shop
 *  integration write-up found this pass, same inference-not-official-proof
 *  status parseEbayOAuthCallback() carries for an identical reason (see
 *  ebay-oauth.ts's own header comment). Returns null if either is missing
 *  -- callers must check for TikTok's own `error` param separately first,
 *  same caller contract as parseEbayOAuthCallback()/parseAmazonOAuthCallback(). */
export function parseTikTokOAuthCallback(searchParams: URLSearchParams): TikTokOAuthCallbackQuery | null {
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  if (!code || !state) {
    return null;
  }
  return { code, state };
}

/** Same envelope convention TikTokApiResponse in tiktok-connector.ts
 *  documents (`code === 0` success, `data` payload wrapper) -- duplicated
 *  here rather than importing that un-exported interface, to keep this
 *  file's own exchange/lookup calls independent of tiktok-connector.ts's
 *  internal (non-exported) types. */
interface TikTokOAuthApiResponse<T> {
  code?: number;
  message?: string;
  data?: T;
}

interface TikTokTokenData {
  access_token?: string;
  access_token_expire_in?: number;
  refresh_token?: string;
  refresh_token_expire_in?: number;
  open_id?: string;
  seller_name?: string;
  seller_base_region?: string;
  granted_scopes?: string[];
}

/**
 * Exchanges an authorization `code` for an access/refresh token pair via
 * GET {TIKTOK_AUTH_BASE_URL}/api/v2/token/get -- confirmed endpoint path
 * and query param names (app_key/app_secret/auth_code/grant_type) per this
 * file's own header comment. An UNSIGNED plain query-string GET, same
 * non-standard-for-this-package convention TikTokConnector.authenticate()'s
 * own refresh-token call already uses against this identical host -- this
 * is the analogous initial-exchange call, not a business-API call, so it
 * does NOT go through buildTikTokSignature()/fetchWithBackoff() the way
 * every request TikTokConnector's own private request() makes does.
 * `grant_type=authorized_code` -- see this file's header comment's
 * structural-differences note; do not "correct" this to the RFC-standard
 * spelling.
 */
export async function exchangeTikTokAuthorizationCode(
  code: string,
  { appKey, appSecret }: TikTokOAuthAppConfig,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: string }> {
  const url = new URL(`${TIKTOK_AUTH_BASE_URL}/api/v2/token/get`);
  url.searchParams.set("app_key", appKey);
  url.searchParams.set("app_secret", appSecret);
  url.searchParams.set("auth_code", code);
  url.searchParams.set("grant_type", "authorized_code");

  const response = await fetch(url.toString(), { method: "GET" });
  const data = (await response.json().catch(() => ({}))) as TikTokOAuthApiResponse<TikTokTokenData>;

  if (!response.ok || (data.code !== undefined && data.code !== 0) || !data.data?.access_token || !data.data.refresh_token) {
    const detail = [data.code, data.message].filter((v) => v !== undefined && v !== "").join(": ");
    throw new Error(`TikTok authorization-code exchange failed: ${response.status}${detail ? ` ${detail}` : ` ${response.statusText}`}`);
  }

  const expiresInSeconds = data.data.access_token_expire_in ?? 7 * 24 * 60 * 60; // same fallback authenticate() uses
  return {
    accessToken: data.data.access_token,
    refreshToken: data.data.refresh_token,
    expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
  };
}

/** UNCONFIRMED response field names beyond `cipher` itself -- no source
 *  found this pass rendered a literal example JSON body for this endpoint,
 *  same "endpoint path/params confirmed, exact non-essential field names
 *  not" gap this codebase's TikTokOrder/TikTokOrderLine types already
 *  carry (see tiktok-connector.ts). `cipher` alone is what
 *  getTikTokAuthorizedShops()'s only real caller (the OAuth callback route)
 *  needs. */
export interface TikTokAuthorizedShop {
  cipher: string;
  id?: string;
  name?: string;
  region?: string;
  seller_type?: string;
  [key: string]: unknown;
}

interface TikTokAuthorizedShopsData {
  shops?: TikTokAuthorizedShop[];
  [key: string]: unknown;
}

/**
 * GET {TIKTOK_API_BASE_URL}/authorization/202309/shops -- lists the shop(s)
 * a completed authorization covers, keyed by `cipher` (the shop_cipher
 * TikTokCredentials' own doc comment describes as "obtained from
 * /authorization/202309/shops"). A SIGNED business-API call (unlike the
 * token exchange above), reusing buildTikTokSignature() directly rather
 * than going through TikTokConnector's own private request() -- this is
 * deliberately called BEFORE a full TikTokCredentials (with a real
 * shopCipher) exists, so there is no TikTokConnector instance to call it
 * on yet; `shop_cipher` is correctly omitted from the signed params here,
 * per TikTokCredentials' own doc comment naming "authorization... endpoints"
 * as one of the families that must omit it.
 *
 * Takes only appKey/appSecret/accessToken (no shopCipher) for exactly that
 * reason. The access token still travels only in the `x-tts-access-token`
 * header, never the signed query string, same convention as every other
 * business-API call in this package.
 */
export async function getTikTokAuthorizedShops(credentials: {
  appKey: string;
  appSecret: string;
  accessToken: string;
}): Promise<TikTokAuthorizedShop[]> {
  const path = "/authorization/202309/shops";
  const params: Record<string, unknown> = {
    app_key: credentials.appKey,
    timestamp: Math.round(Date.now() / 1000),
  };
  const sign = buildTikTokSignature(path, params, credentials.appSecret);

  const url = new URL(`${TIKTOK_API_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  url.searchParams.set("sign", sign);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { "x-tts-access-token": credentials.accessToken },
  });
  const data = (await response.json().catch(() => ({}))) as TikTokOAuthApiResponse<TikTokAuthorizedShopsData>;

  if (!response.ok || (data.code !== undefined && data.code !== 0)) {
    const detail = [data.code, data.message].filter((v) => v !== undefined && v !== "").join(": ");
    throw new Error(`TikTok authorized-shops lookup failed: ${response.status}${detail ? ` ${detail}` : ` ${response.statusText}`}`);
  }
  return data.data?.shops ?? [];
}
