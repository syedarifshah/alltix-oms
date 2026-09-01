import { NextResponse, type NextRequest } from "next/server";
import { buildAmazonAuthorizeUrl } from "@alltix/channel-connectors";
import { withTenantAuth, type TenantRequestContext } from "@/lib/with-tenant-auth";
import { createOAuthState } from "@/lib/amazon-oauth-state";
import { readAmazonOAuthAppConfig, isAmazonOAuthAppDraft } from "@/lib/amazon-oauth-config";

export const dynamic = "force-dynamic";

/**
 * Redirects the signed-in tenant to Amazon's authorization consent screen
 * (the "Connect Amazon" button's target). See the header comment in
 * packages/channel-connectors/src/amazon-oauth.ts: this only works once
 * AMAZON_APP_ID refers to a Public SP-API application, which does not exist
 * yet in this repo -- until then this 500s with a clear missing-env-var
 * error via readAmazonOAuthAppConfig(), which is the truthful behavior
 * rather than redirecting somewhere broken.
 *
 * Wrapped in withTenantAuth purely for its auth/tenant-resolution step (the
 * transaction it opens goes unused here) so this route is gated the exact
 * same way every other authenticated route in the app is, instead of a
 * second, parallel auth check.
 */
async function connectAmazon(_req: NextRequest, { tenantId }: TenantRequestContext): Promise<Response> {
  const { applicationId } = readAmazonOAuthAppConfig();
  const state = createOAuthState(tenantId);
  const authorizeUrl = buildAmazonAuthorizeUrl(applicationId, state, isAmazonOAuthAppDraft());
  return NextResponse.redirect(authorizeUrl);
}

export const GET = withTenantAuth(connectAmazon);
