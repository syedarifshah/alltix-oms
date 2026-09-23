import type { NextRequest } from "next/server";
import { withTenant, encryptChannelSecret, recordAuditEvent } from "@alltix/db";
import { WalmartConnector, WALMART_PRODUCTION_BASE_URL } from "@alltix/channel-connectors";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";
import { isChannelEnabledForTenant } from "@/lib/channel-flags";
import { checkRateLimit, RATE_LIMIT_ERROR_MESSAGE } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * POST /api/channels/walmart/connect -- persists a tenant's Walmart
 * Marketplace API credentials from the /settings/channels "Connect Walmart"
 * form.
 *
 * Same shape as /api/channels/shopify/connect (see that route's own doc
 * comment for the full reasoning), not Amazon's OAuth redirect/callback
 * pair: Walmart's client_credentials grant has no consent screen either --
 * a Client ID and Client Secret, issued directly to the tenant's own
 * Walmart seller/Solution Provider account (CLAUDE.md §4.2), are the entire
 * credential, typed into one plain HTML form and POSTed here in one step.
 *
 * Not wrapped in withTenantAuth for the identical reason the Shopify route
 * gives: the first real step here is a network round trip
 * (WalmartConnector.authenticate(), a live client_credentials token
 * exchange) to prove the pair actually works before persisting anything,
 * and holding a Postgres transaction open across that call is what
 * withTenantAuth's own doc comment warns against.
 *
 * UNVERIFIED IN PRACTICE, same status as WalmartConnector itself (see its
 * class doc comment): this route's logic is complete and typechecked, but
 * nobody has submitted a real Walmart clientId/clientSecret pair through it
 * yet -- there's no self-serve Walmart sandbox the way Shopify's free dev
 * store or Amazon's Private-app self-authorization gave the other two
 * connectors, so this stays untested against live Walmart infrastructure
 * until a tenant (or this project) gets an approved seller/Solution
 * Provider account. Submitting a wrong or placeholder pair here will
 * correctly fail at the authenticate() step below rather than silently
 * "connecting" nothing.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const pool = getAppPool();
  const user = await requireCurrentUser(req, pool);
  if (!user) {
    return redirectWithError(req, "/settings/channels", "not signed in");
  }

  if (await checkRateLimit(pool, user.tenantId, "channels.walmart.connect")) {
    return redirectWithError(req, "/settings/channels", RATE_LIMIT_ERROR_MESSAGE);
  }

  if (!(await isChannelEnabledForTenant(pool, user.tenantId, "walmart"))) {
    return redirectWithError(req, "/settings/channels", "walmart_channel_not_enabled");
  }

  const formData = await req.formData();
  const clientId = String(formData.get("clientId") ?? "").trim();
  const clientSecret = String(formData.get("clientSecret") ?? "").trim();

  if (!clientId || !clientSecret) {
    return redirectWithError(req, "/settings/channels", "walmart_missing_fields");
  }

  // Prove the pair actually authenticates against real Walmart Marketplace
  // API infrastructure before persisting anything -- same "verify before
  // persist" discipline as ShopifyConnector.verifyConnection(), just via
  // authenticate() itself here since WalmartConnector has no separate
  // read-only verification call the way Shopify's { shop { name } } query
  // is. Always against production (see createWalmartConnectorFromChannelConnection's
  // own comment) -- a real tenant is connecting their real seller account,
  // never this repo's internal sandbox.
  const connector = new WalmartConnector({ clientId, clientSecret }, WALMART_PRODUCTION_BASE_URL);
  try {
    await connector.authenticate();
  } catch (err) {
    return redirectWithError(req, "/settings/channels", `walmart_verify_failed:${errorMessage(err)}`);
  }

  try {
    await withTenant(pool, user.tenantId, async (client) => {
      const encryptedClientSecret = await encryptChannelSecret(client, clientSecret);

      // external_account_id = clientId, marketplace = '' -- see
      // loadWalmartCredentialsFromChannelConnection's own doc comment in
      // walmart-connector.ts for why: no independent Walmart identifier
      // this connector's calls need, so reusing clientId here is what keeps
      // the table's existing (tenant_id, channel, marketplace,
      // external_account_id) UNIQUE constraint meaningful -- reconnecting
      // with the *same* clientId updates the existing row; connecting a
      // *different* Walmart account (a different clientId) would insert a
      // second row rather than silently overwriting the first, matching
      // how a tenant could in principle hold more than one Amazon
      // connection today. encrypted_refresh_token is left NULL -- nothing
      // to put there for Walmart's client_credentials grant.
      const result = await client.query<{ id: string; is_new: boolean }>(
        `INSERT INTO channel_connections
           (tenant_id, channel, marketplace, external_account_id, lwa_client_id, encrypted_client_secret, status)
         VALUES ($1, 'walmart', '', $2, $2, $3, 'active')
         ON CONFLICT (tenant_id, channel, marketplace, external_account_id)
         DO UPDATE SET
           lwa_client_id = EXCLUDED.lwa_client_id,
           encrypted_client_secret = EXCLUDED.encrypted_client_secret,
           status = 'active',
           updated_at = now()
         RETURNING id, (xmax = 0) AS is_new`,
        [user.tenantId, clientId, encryptedClientSecret],
      );
      const { id, is_new: isNew } = result.rows[0]!;

      // Never logs a secret value, only which channel/account changed --
      // see amazon/callback/route.ts's identical comment for the full
      // xmax = 0 reasoning.
      await recordAuditEvent(client, {
        tenantId: user.tenantId,
        userId: user.id,
        action: isNew ? "channel_connection.connected" : "channel_connection.credentials_rotated",
        entityType: "channel_connection",
        entityId: id,
        details: { channel: "walmart", marketplace: "", externalAccountId: clientId },
      });
    });
  } catch (err) {
    return redirectWithError(req, "/settings/channels", `walmart_save_failed:${errorMessage(err)}`);
  }

  console.info(`Walmart connected for tenant ${user.tenantId}: clientId ${clientId}`);

  return redirectTo(req, "/settings/channels?connected=walmart");
}
