import { NextResponse, type NextRequest } from "next/server";
import { withTenant, encryptChannelSecret } from "@alltix/db";
import { parseEbayOAuthCallback, exchangeEbayAuthorizationCode } from "@alltix/channel-connectors";
import { getAppPool } from "@/lib/db";
import { getAuthContext } from "@/lib/auth-context";
import { resolveTenantId } from "@/lib/with-tenant-auth";
import { verifyOAuthState } from "@/lib/ebay-oauth-state";
import { readEbayOAuthAppConfig, isEbayOAuthSandbox } from "@/lib/ebay-oauth-config";

export const dynamic = "force-dynamic";

// No real seller has ever hit this against this repo's eBay app -- no
// application is registered at all yet (see .env.example's EBAY_OAUTH_*
// entries), and this environment can't reach eBay's API hosts to prove the
// token exchange live even with one (see EbayConnector's own class doc
// comment). Implemented anyway per the product requirement, ready for when
// a real eBay application exists -- state sign/verify follows the same
// pattern already unit-tested for Amazon's equivalent
// (test/amazon-oauth-state.test.ts); no ebay-oauth-state.test.ts exists yet
// since this module is a near-literal fork (see its own header comment).

function redirectWithError(req: NextRequest, error: string): Response {
  const url = new URL("/settings/channels", req.url);
  url.searchParams.set("error", error);
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest): Promise<Response> {
  const searchParams = req.nextUrl.searchParams;

  // A seller who declines consent on eBay's screen is redirected back with
  // an `error` param instead of `code`/`state` -- same check Amazon's
  // callback route makes first, before attempting to parse a success shape.
  //
  // Every error code below is prefixed "ebay_" -- deliberately, unlike
  // Amazon's own callback route (whose codes like "missing_callback_params"/
  // "token_exchange_failed" carry no channel prefix at all, since Amazon's
  // OAuth flow was built before any other channel had one to disambiguate
  // from). The settings page's error banner logic keys off exactly this
  // prefix to route an eBay failure to the eBay card instead of falling
  // into Amazon's catch-all banner -- see that page's own comment.
  const ebayError = searchParams.get("error");
  if (ebayError) {
    return redirectWithError(req, `ebay_declined:${ebayError}`);
  }

  const callback = parseEbayOAuthCallback(searchParams);
  if (!callback) {
    return redirectWithError(req, "ebay_missing_callback_params");
  }

  const tenantIdFromState = verifyOAuthState(callback.state);
  if (!tenantIdFromState) {
    return redirectWithError(req, "ebay_invalid_or_expired_state");
  }

  // Application-layer defense-in-depth on top of the signed state token,
  // same reasoning as the Amazon callback's identical check.
  const authContext = await getAuthContext(req.headers);
  if (!authContext) {
    return redirectWithError(req, "ebay_not_signed_in");
  }
  const pool = getAppPool();
  const tenantIdFromSession = await resolveTenantId(pool, authContext.clerkUserId);
  if (!tenantIdFromSession || tenantIdFromSession !== tenantIdFromState) {
    return redirectWithError(req, "ebay_tenant_mismatch");
  }

  const { clientId, clientSecret, redirectUri } = readEbayOAuthAppConfig();

  let refreshToken: string;
  try {
    ({ refreshToken } = await exchangeEbayAuthorizationCode(
      callback.code,
      { clientId, clientSecret, redirectUri },
      isEbayOAuthSandbox(),
    ));
  } catch (err) {
    console.error("eBay authorization-code exchange failed:", err instanceof Error ? err.message : err);
    return redirectWithError(req, "ebay_token_exchange_failed");
  }

  // No independent seller identifier comes back on eBay's callback the way
  // Amazon's own selling_partner_id does -- eBay's REST APIs identify the
  // seller purely from the access token itself (see EbayCredentials' own
  // doc comment). external_account_id reuses the tenant's own clientId
  // instead, same "no independent seller id this connector's calls need"
  // reuse WalmartConnector's own connect route already established for the
  // identical reason -- this keeps the (tenant_id, channel, marketplace,
  // external_account_id) UNIQUE constraint meaningful (one eBay connection
  // per tenant per registered application) rather than needing a second API
  // call (e.g. eBay's GetUser) just to populate a column nothing else reads.
  await withTenant(pool, tenantIdFromState, async (client) => {
    const encryptedClientSecret = await encryptChannelSecret(client, clientSecret);
    const encryptedRefreshToken = await encryptChannelSecret(client, refreshToken);

    await client.query(
      `INSERT INTO channel_connections
         (tenant_id, channel, marketplace, external_account_id, lwa_client_id, encrypted_client_secret, encrypted_refresh_token, status)
       VALUES ($1, 'ebay', '', $2, $2, $3, $4, 'active')
       ON CONFLICT (tenant_id, channel, marketplace, external_account_id)
       DO UPDATE SET
         lwa_client_id = EXCLUDED.lwa_client_id,
         encrypted_client_secret = EXCLUDED.encrypted_client_secret,
         encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
         status = 'active',
         updated_at = now()`,
      [tenantIdFromState, clientId, encryptedClientSecret, encryptedRefreshToken],
    );
  });

  const url = new URL("/settings/channels", req.url);
  url.searchParams.set("connected", "ebay");
  return NextResponse.redirect(url);
}
