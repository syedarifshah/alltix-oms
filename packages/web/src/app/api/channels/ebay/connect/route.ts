import { NextResponse, type NextRequest } from "next/server";
import { buildEbayAuthorizeUrl } from "@alltix/channel-connectors";
import { withTenantAuth, type TenantRequestContext } from "@/lib/with-tenant-auth";
import { createOAuthState } from "@/lib/ebay-oauth-state";
import { readEbayOAuthAppConfig, isEbayOAuthSandbox } from "@/lib/ebay-oauth-config";

export const dynamic = "force-dynamic";

/**
 * Redirects the signed-in tenant to eBay's authorization consent screen
 * (the "Connect eBay" button's target) -- mirrors
 * /api/channels/amazon/connect exactly, see that route's own doc comment
 * for the withTenantAuth-for-its-auth-step-only reasoning. No registered
 * eBay application exists in this repo yet (see .env.example's EBAY_OAUTH_*
 * entries), so this 500s with a clear missing-env-var error via
 * readEbayOAuthAppConfig() until one is configured -- the truthful
 * behavior rather than redirecting somewhere broken, same as Amazon's own
 * connect route.
 */
async function connectEbay(_req: NextRequest, { tenantId }: TenantRequestContext): Promise<Response> {
  const { clientId, redirectUri } = readEbayOAuthAppConfig();
  const state = createOAuthState(tenantId);
  const authorizeUrl = buildEbayAuthorizeUrl(clientId, redirectUri, state, isEbayOAuthSandbox());
  return NextResponse.redirect(authorizeUrl);
}

export const GET = withTenantAuth(connectEbay);
