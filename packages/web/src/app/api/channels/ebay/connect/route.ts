import { NextResponse, type NextRequest } from "next/server";
import { buildEbayAuthorizeUrl } from "@alltix/channel-connectors";
import { withTenantAuth, type TenantRequestContext } from "@/lib/with-tenant-auth";
import { createOAuthState } from "@/lib/ebay-oauth-state";
import { readEbayOAuthAppConfig, isEbayOAuthSandbox } from "@/lib/ebay-oauth-config";
import { isChannelEnabled } from "@/lib/channel-flags";
import { redirectWithError } from "@/lib/route-helpers";
import { recordRequestAndCheckRateLimit, RateLimitExceededError, RATE_LIMIT_ERROR_MESSAGE } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Redirects the signed-in tenant to eBay's authorization consent screen
 * (the "Connect eBay" button's target) -- mirrors
 * /api/channels/amazon/connect exactly, see that route's own doc comment
 * for the withTenantAuth-for-its-auth-step-only reasoning (including the
 * channel-flags check below, CLAUDE.md's "Channel Feature Flags" section).
 * No registered eBay application exists in this repo yet (see
 * .env.example's EBAY_OAUTH_* entries), so this 500s with a clear
 * missing-env-var error via readEbayOAuthAppConfig() until one is
 * configured -- the truthful behavior rather than redirecting somewhere
 * broken, same as Amazon's own connect route.
 *
 * Rate-limited the identical way -- see connectAmazon's own doc comment for
 * why this uses {@link recordRequestAndCheckRateLimit} against the already-
 * open `client` rather than the pool-level convenience.
 */
async function connectEbay(req: NextRequest, { tenantId, client }: TenantRequestContext): Promise<Response> {
  try {
    await recordRequestAndCheckRateLimit(client, tenantId, "channels.ebay.connect");
  } catch (err) {
    if (err instanceof RateLimitExceededError) {
      return redirectWithError(req, "/settings/channels", RATE_LIMIT_ERROR_MESSAGE);
    }
    throw err;
  }

  if (!(await isChannelEnabled(client, tenantId, "ebay"))) {
    return redirectWithError(req, "/settings/channels", "ebay_channel_not_enabled");
  }
  const { clientId, redirectUri } = readEbayOAuthAppConfig();
  const state = createOAuthState(tenantId);
  const authorizeUrl = buildEbayAuthorizeUrl(clientId, redirectUri, state, isEbayOAuthSandbox());
  return NextResponse.redirect(authorizeUrl);
}

export const GET = withTenantAuth(connectEbay);
