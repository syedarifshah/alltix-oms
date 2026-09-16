import { NextResponse, type NextRequest } from "next/server";
import { withTenant, encryptChannelSecret } from "@alltix/db";
import { parseAmazonOAuthCallback, exchangeAmazonAuthorizationCode } from "@alltix/channel-connectors";
import { getAppPool } from "@/lib/db";
import { getAuthContext } from "@/lib/auth-context";
import { resolveTenantId } from "@/lib/with-tenant-auth";
import { verifyOAuthState } from "@/lib/amazon-oauth-state";
import { readAmazonOAuthAppConfig } from "@/lib/amazon-oauth-config";

export const dynamic = "force-dynamic";

// No real seller has ever hit this against this repo's Amazon app -- it's
// Private, and the redirect-based flow this route is the callback half of
// only exists for Public applications (see the header comment in
// packages/channel-connectors/src/amazon-oauth.ts). Implemented anyway per
// the product requirement, ready for when/if that app is published; every
// step short of "a real spapi_oauth_code from a real Amazon consent screen"
// has been exercised (state sign/verify unit tests in
// test/amazon-oauth-state.test.ts; the LWA exchange request shape itself
// against the real endpoint in
// scripts/amazon-oauth-token-exchange-isolation-test.ts).

function redirectWithError(req: NextRequest, error: string): Response {
  const url = new URL("/settings/channels", req.url);
  url.searchParams.set("error", error);
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest): Promise<Response> {
  const searchParams = req.nextUrl.searchParams;

  // A seller who clicks "Cancel" on Amazon's consent screen is redirected
  // back with an `error` param instead of the three success params below.
  const amazonError = searchParams.get("error");
  if (amazonError) {
    return redirectWithError(req, `amazon_declined:${amazonError}`);
  }

  const callback = parseAmazonOAuthCallback(searchParams);
  if (!callback) {
    return redirectWithError(req, "missing_callback_params");
  }

  const tenantIdFromState = verifyOAuthState(callback.state);
  if (!tenantIdFromState) {
    return redirectWithError(req, "invalid_or_expired_state");
  }

  // The signed state token above is the real CSRF protection (it's what
  // ties this callback to the specific "Connect Amazon" click that started
  // it). This session check is application-layer defense-in-depth on top of
  // that (CLAUDE.md §6, never rely on one isolation mechanism alone): the
  // browser completing the callback must also currently be signed in as a
  // user belonging to that same tenant.
  const authContext = await getAuthContext(req.headers);
  if (!authContext) {
    return redirectWithError(req, "not_signed_in");
  }
  const pool = getAppPool();
  const tenantIdFromSession = await resolveTenantId(pool, authContext.clerkUserId);
  if (!tenantIdFromSession || tenantIdFromSession !== tenantIdFromState) {
    return redirectWithError(req, "tenant_mismatch");
  }

  const { clientId, clientSecret, redirectUri } = readAmazonOAuthAppConfig();

  let refreshToken: string;
  try {
    ({ refreshToken } = await exchangeAmazonAuthorizationCode(callback.spapiOauthCode, {
      clientId,
      clientSecret,
      redirectUri,
    }));
  } catch (err) {
    console.error("Amazon LWA authorization-code exchange failed:", err instanceof Error ? err.message : err);
    return redirectWithError(req, "token_exchange_failed");
  }

  // No marketplace comes back on the callback itself (only
  // selling_partner_id does) -- a full implementation would call
  // GET /sellers/v1/marketplaceParticipations with the fresh token to
  // discover the seller's real marketplace(s), the way
  // amazon-connector.ts's smoke test already does. Deferred here: that call
  // needs a base URL (sandbox vs. production SP-API host) this route has no
  // way to choose correctly for an application that doesn't exist yet, and
  // -- per the header comment above -- there is no live app to prove that
  // choice against anyway. So this stores a *region*, not a real
  // marketplace id -- createAmazonConnectorFromChannelConnection() (see its
  // own doc comment, added while fixing a real production 403) reads this
  // value back at sync time to pick a production SP-API host and discover
  // the real marketplace id(s) live via getMarketplaceParticipations().
  // Must be one of SP-API's three real regions (NA/EU/FE, CLAUDE.md §4.1) --
  // anything else is treated as not-a-real-production-connection and stays
  // on the sandbox host, so this default has to be a real region, not the
  // country code "US" this used to (wrongly) default to.
  const marketplace = process.env.AMAZON_OAUTH_DEFAULT_MARKETPLACE ?? "NA";

  await withTenant(pool, tenantIdFromState, async (client) => {
    const encryptedClientSecret = await encryptChannelSecret(client, clientSecret);
    const encryptedRefreshToken = await encryptChannelSecret(client, refreshToken);

    await client.query(
      `INSERT INTO channel_connections
         (tenant_id, channel, marketplace, external_account_id, lwa_client_id, encrypted_client_secret, encrypted_refresh_token, status)
       VALUES ($1, 'amazon', $2, $3, $4, $5, $6, 'active')
       ON CONFLICT (tenant_id, channel, marketplace, external_account_id)
       DO UPDATE SET
         lwa_client_id = EXCLUDED.lwa_client_id,
         encrypted_client_secret = EXCLUDED.encrypted_client_secret,
         encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
         status = 'active',
         updated_at = now()`,
      [tenantIdFromState, marketplace, callback.sellingPartnerId, clientId, encryptedClientSecret, encryptedRefreshToken],
    );
  });

  const url = new URL("/settings/channels", req.url);
  url.searchParams.set("connected", "amazon");
  return NextResponse.redirect(url);
}
