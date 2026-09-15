// eBay's redirect-based OAuth Authorization Code Grant flow -- the OAuth
// flow behind a "Connect eBay" button. Distinct from ebay-connector.ts's
// authenticate(), which trades an already-held refresh token for a
// short-lived access token; this module is the one-time step that produces
// that refresh token in the first place, via a browser redirect + token
// exchange -- structurally the closest of the three existing channels to
// Amazon's own amazon-oauth.ts (real authorization-code + long-lived
// refresh-token grant), NOT Walmart's client_credentials shape (no user
// consent, no refresh token at all) or Shopify's static-token shape.
//
// Researched against eBay's current developer docs before writing any of
// this (https://developer.ebay.com/api-docs/static/oauth-auth-code-grant-request.html,
// https://developer.ebay.com/develop/guides/sell/authorization,
// https://developer.ebay.com/api-docs/static/oauth-scopes.html): eBay's
// own docs use standard OAuth2 terminology throughout (no SP-API-style
// custom param names like Amazon's spapi_oauth_code/selling_partner_id).
// The token-exchange endpoint/params/response shape below (POST
// /identity/v1/oauth2/token, HTTP Basic client_id:client_secret,
// grant_type=authorization_code, a literal example response with
// access_token/refresh_token/expires_in/refresh_token_expires_in/token_type)
// is confirmed directly from that first doc page's own literal example.
// The consent-screen redirect URL (GET https://auth.ebay.com/oauth2/authorize
// or https://auth.sandbox.ebay.com/oauth2/authorize, params client_id/
// redirect_uri/response_type=code/scope/state) is confirmed the same way.
//
// The callback's own query params (`code`, `state` on success) are NOT
// confirmed from an official eBay doc page with a literal example the way
// everything else in this file is -- every official page fetched during
// this pass described the token-exchange body (which does use a literal
// `code` param) without ever showing the actual redirect URL eBay sends
// the browser back to. `code`/`state` is standard OAuth2 Authorization Code
// Grant behavior (RFC 6749 §4.1.2), and a third-party developer writeup
// (databaaba.com/blog/ebay-oauth-connect-seller-account) independently
// describes "Your callback receives the code (plus state)" -- consistent
// with, but not a literal-official-doc-confirmed replacement for, the RFC
// default. parseEbayOAuthCallback() below is built on that inference; if it
// turns out wrong, only this one function needs correcting, not the
// (separately, directly confirmed) token-exchange shape it feeds into.
//
// UNVERIFIED, same status this repo's whole eBay connector carries (see
// ebay-connector.ts's own class doc comment): this environment's outbound
// network policy blocks both api.ebay.com and api.sandbox.ebay.com entirely
// (confirmed directly -- a token-exchange curl to each was rejected at the
// proxy level), so nothing in this file has been exercised against live
// eBay infrastructure, sandbox or production.

const EBAY_AUTHORIZE_PRODUCTION_URL = "https://auth.ebay.com/oauth2/authorize";
const EBAY_AUTHORIZE_SANDBOX_URL = "https://auth.sandbox.ebay.com/oauth2/authorize";
export const EBAY_TOKEN_PRODUCTION_URL = "https://api.ebay.com/identity/v1/oauth2/token";
export const EBAY_TOKEN_SANDBOX_URL = "https://api.sandbox.ebay.com/identity/v1/oauth2/token";

/** The two OAuth scopes this codebase's eBay wiring actually needs -- write
 *  access to both, not the read-only `sell.fulfillment.readonly` variant
 *  the fulfillment API's own OpenAPI spec also lists as sufficient for
 *  getOrders alone, since EbayConnector.confirmShipment() (createShippingFulfillment)
 *  is a write against the same API family and needs the full scope. */
export const EBAY_OAUTH_SCOPES = [
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
];

export interface EbayOAuthAppConfig {
  clientId: string;
  clientSecret: string;
  /** eBay calls this the application's "RuName" (redirect URL name), not a
   *  literal callback URL string the way Amazon's/most OAuth providers'
   *  redirect_uri is -- it's still passed as the `redirect_uri` param on
   *  both the authorize URL and the token exchange, per eBay's own docs, so
   *  it's named consistently with the rest of this codebase's OAuth config
   *  shapes rather than introducing a differently-named field for the same
   *  role. */
  redirectUri: string;
}

/** Builds the URL a "Connect eBay" button redirects to. `sandbox` picks
 *  auth.sandbox.ebay.com vs. auth.ebay.com -- eBay has no Amazon-style
 *  "Draft application" concept to gate on; sandbox/production are simply
 *  two separate keysets/hosts, matching this connector's own
 *  isSandbox()-by-base-URL pattern (see ebay-connector.ts). */
export function buildEbayAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
  sandbox = false,
  scopes: string[] = EBAY_OAUTH_SCOPES,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    state,
  });
  return `${sandbox ? EBAY_AUTHORIZE_SANDBOX_URL : EBAY_AUTHORIZE_PRODUCTION_URL}?${params.toString()}`;
}

export interface EbayOAuthCallbackQuery {
  code: string;
  state: string;
}

/**
 * Parses the callback query params eBay's consent redirect carries --
 * `code`, `state` (see this file's header comment on why this specific
 * shape is inferred/standard-OAuth2, not a literal-doc-confirmed official
 * example the way the rest of this module is). Returns null if either is
 * missing (including when eBay instead sends back an `error` param because
 * the seller declined consent -- callers should check for that separately
 * before calling this, same pattern as parseAmazonOAuthCallback's own
 * caller contract in amazon-oauth.ts).
 */
export function parseEbayOAuthCallback(searchParams: URLSearchParams): EbayOAuthCallbackQuery | null {
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  if (!code || !state) {
    return null;
  }
  return { code, state };
}

interface EbayTokenSuccess {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_token_expires_in: number;
  token_type: string;
}

interface EbayTokenError {
  error: string;
  error_description?: string;
}

/**
 * Exchanges an authorization `code` for a refresh token via POST
 * /identity/v1/oauth2/token, grant_type=authorization_code -- confirmed
 * request shape (HTTP Basic client_id:client_secret, form-urlencoded
 * grant_type/code/redirect_uri body, and the literal example JSON response
 * shape) from developer.ebay.com's own oauth-auth-code-grant-request.html
 * doc page, fetched live during this pass. `redirectUri` must be the exact
 * RuName registered for `clientId`'s application.
 */
export async function exchangeEbayAuthorizationCode(
  code: string,
  { clientId, clientSecret, redirectUri }: EbayOAuthAppConfig,
  sandbox = false,
): Promise<{ refreshToken: string }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });

  const response = await fetch(sandbox ? EBAY_TOKEN_SANDBOX_URL : EBAY_TOKEN_PRODUCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body,
  });

  const data = (await response.json()) as EbayTokenSuccess | EbayTokenError;

  if (!response.ok || !("refresh_token" in data)) {
    const message =
      "error" in data ? `${data.error}: ${data.error_description ?? ""}`.trim() : response.statusText;
    throw new Error(`eBay authorization-code exchange failed: ${response.status} ${message}`);
  }

  return { refreshToken: data.refresh_token };
}
