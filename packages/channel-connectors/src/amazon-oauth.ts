// Amazon SP-API's redirect-based "Website Authorization Workflow" -- the
// OAuth flow behind a "Connect Amazon" button. Distinct from
// amazon-connector.ts's authenticate(), which trades an already-held
// refresh token for a short-lived access token; this module is the
// one-time step that produces that refresh token in the first place, via a
// browser redirect + LWA authorization-code exchange, instead of the
// Private-app self-authorization path this repo has actually proven
// working (see scripts/seed-test-channel-connection.ts).
//
// IMPORTANT -- researched against Amazon's current docs before writing any
// of this (https://developer-docs.amazon/sp-api/docs/website-authorization-workflow,
// https://developer-docs.amazon/sp-api/docs/self-authorization): this
// workflow only exists for Public SP-API applications. The Website
// Authorization Workflow doc states plainly "Authorize a public SP-API
// application by using a website authorization flow." A Private
// application -- which is what this repo's AMAZON_SANDBOX_* credentials
// belong to -- is authorized exclusively through self-authorization (a
// manual "Authorize app" click in Seller Central / the Solution Provider
// Portal that hands you a refresh token directly; no redirect, no
// callback, ever). This is not a sandbox-vs-production distinction:
// Public/Private is a property of the application's own registration,
// identical in both environments. So this module cannot be exercised
// end-to-end (real browser -> real Amazon consent screen -> real callback)
// until/unless this SP-API application is published as Public with a
// registered OAuth redirect URI.
//
// What *is* confirmed live: navigating to the exact URL
// buildAmazonAuthorizeUrl() constructs (with a placeholder application_id)
// gets a real 302 from sellercentral.amazon.com straight into Amazon's own
// sign-in flow (openid.return_to echoing our URL back verbatim) rather than
// an immediate rejection -- Amazon defers application_id validation until
// after sign-in, on the consent screen itself, which there is no way to
// reach without a Public app and a real seller session. That confirms the
// URL shape below is correct against live infrastructure, not just the
// docs' prose.

const SELLER_CENTRAL_AUTHORIZE_URL = "https://sellercentral.amazon.com/apps/authorize/consent";
const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";

export interface AmazonOAuthAppConfig {
  /** The SP-API "application_id" (distinct from the LWA client_id) issued when the app is registered in Seller Central's Developer Console. */
  applicationId: string;
  clientId: string;
  clientSecret: string;
  /** Must exactly match the redirect URI registered for `applicationId` -- LWA validates it on token exchange and rejects a mismatch. */
  redirectUri: string;
}

/**
 * Builds the URL a "Connect Amazon" button redirects to. `draft` should be
 * true while `applicationId` refers to an application still in Draft
 * status -- see the Website Authorization Workflow doc cited above ("If you
 * want to test an application that is in the Draft state, add
 * version=beta").
 */
export function buildAmazonAuthorizeUrl(applicationId: string, state: string, draft = true): string {
  const params = new URLSearchParams({ application_id: applicationId, state });
  if (draft) {
    params.set("version", "beta");
  }
  return `${SELLER_CENTRAL_AUTHORIZE_URL}?${params.toString()}`;
}

export interface AmazonOAuthCallbackQuery {
  state: string;
  sellingPartnerId: string;
  spapiOauthCode: string;
}

/**
 * Parses the three query params Amazon's callback redirect carries --
 * `state`, `selling_partner_id`, `spapi_oauth_code` -- per the Website
 * Authorization Workflow doc cited above. Returns null if any are missing
 * (including when Amazon instead sends back an `error` param because the
 * seller declined consent -- callers should check for that separately
 * before calling this).
 */
export function parseAmazonOAuthCallback(searchParams: URLSearchParams): AmazonOAuthCallbackQuery | null {
  const state = searchParams.get("state");
  const sellingPartnerId = searchParams.get("selling_partner_id");
  const spapiOauthCode = searchParams.get("spapi_oauth_code");
  if (!state || !sellingPartnerId || !spapiOauthCode) {
    return null;
  }
  return { state, sellingPartnerId, spapiOauthCode };
}

interface LwaTokenSuccess {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

interface LwaTokenError {
  error: string;
  error_description?: string;
}

/**
 * Exchanges an spapi_oauth_code (5-minute lifetime; the full authorize ->
 * callback -> exchange round trip should complete within 10 minutes, per
 * Amazon's docs) for a refresh token via LWA POST
 * https://api.amazon.com/auth/o2/token, grant_type=authorization_code.
 * `redirectUri` must exactly match the one registered for `clientId`'s
 * application.
 */
export async function exchangeAmazonAuthorizationCode(
  spapiOauthCode: string,
  { clientId, clientSecret, redirectUri }: Pick<AmazonOAuthAppConfig, "clientId" | "clientSecret" | "redirectUri">,
): Promise<{ refreshToken: string }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: spapiOauthCode,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch(LWA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body,
  });

  const data = (await response.json()) as LwaTokenSuccess | LwaTokenError;

  if (!response.ok || !("refresh_token" in data)) {
    const message =
      "error" in data ? `${data.error}: ${data.error_description ?? ""}`.trim() : response.statusText;
    throw new Error(`LWA authorization-code exchange failed: ${response.status} ${message}`);
  }

  return { refreshToken: data.refresh_token };
}
