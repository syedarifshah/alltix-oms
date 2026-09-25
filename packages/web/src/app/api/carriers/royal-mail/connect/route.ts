import type { NextRequest } from "next/server";
import { withTenant, encryptChannelSecret, recordAuditEvent } from "@alltix/db";
import { RoyalMailConnector } from "@alltix/carrier-connectors";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";
import { checkRateLimit, RATE_LIMIT_ERROR_MESSAGE } from "@/lib/rate-limit";
import { isCarrierEnabledForTenant } from "@/lib/carrier-flags";

export const dynamic = "force-dynamic";

/**
 * POST /api/carriers/royal-mail/connect -- persists a tenant's Royal Mail
 * credentials from the /settings/carriers "Connect Royal Mail" form. Same
 * shape and same "verify before persist" discipline as
 * /api/channels/walmart/connect (see that route's own doc comment for the
 * full reasoning) -- a plain HTML form POSTed in one step, no OAuth
 * redirect, since Royal Mail's Click & Drop API key has no consent screen
 * either.
 *
 * Two credential pairs, collected together but independently optional past
 * the required Click & Drop key: `clickAndDropApiKey` (required -- this is
 * what createShipment()/voidShipment() need, and what's actually verified
 * live below via RoyalMailConnector.verifyConnection()) and
 * `trackingClientId`/`trackingClientSecret` (optional -- the Tracking API
 * v2 credential pair, INFERRED shape per RoyalMailConnector's own class doc
 * comment; not verified live here since no confirmed token-exchange
 * endpoint exists to call yet -- see that same comment. A tenant can
 * connect labels/orders today without configuring tracking at all).
 *
 * UNVERIFIED IN PRACTICE, same status every other connector in this
 * codebase carried before its first live pass: no real Royal Mail Click &
 * Drop API key exists anywhere in this codebase or Arif's account yet.
 * Submitting a wrong or placeholder key here will correctly fail at
 * verifyConnection() below rather than silently "connecting" nothing.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const pool = getAppPool();
  const user = await requireCurrentUser(req, pool);
  if (!user) {
    return redirectWithError(req, "/settings/carriers", "not signed in");
  }

  if (await checkRateLimit(pool, user.tenantId, "carriers.royal_mail.connect")) {
    return redirectWithError(req, "/settings/carriers", RATE_LIMIT_ERROR_MESSAGE);
  }

  if (!(await isCarrierEnabledForTenant(pool, user.tenantId, "royal_mail"))) {
    return redirectWithError(req, "/settings/carriers", "royal_mail_carrier_not_enabled");
  }

  const formData = await req.formData();
  const clickAndDropApiKey = String(formData.get("clickAndDropApiKey") ?? "").trim();
  const trackingClientId = String(formData.get("trackingClientId") ?? "").trim();
  const trackingClientSecret = String(formData.get("trackingClientSecret") ?? "").trim();

  if (!clickAndDropApiKey) {
    return redirectWithError(req, "/settings/carriers", "royal_mail_missing_fields");
  }

  const connector = new RoyalMailConnector({ clickAndDropApiKey });
  try {
    await connector.verifyConnection();
  } catch (err) {
    return redirectWithError(req, "/settings/carriers", `royal_mail_verify_failed:${errorMessage(err)}`);
  }

  try {
    await withTenant(pool, user.tenantId, async (client) => {
      const encryptedAccessToken = await encryptChannelSecret(client, clickAndDropApiKey);
      const encryptedClientId = trackingClientId ? await encryptChannelSecret(client, trackingClientId) : null;
      const encryptedClientSecret = trackingClientSecret
        ? await encryptChannelSecret(client, trackingClientSecret)
        : null;

      // encrypted_access_token holds the Click & Drop API key -- same
      // "long-lived, high-value, used directly" semantic Shopify's own
      // static token already established for this column
      // (channel_connections, CLAUDE.md §4.5), just under carrier_connections
      // instead. external_account_id has nothing real to reuse the way
      // Walmart/eBay's own connect routes reuse a clientId -- Click & Drop's
      // API key carries no separate account identifier of its own, so this
      // stays NULL (unlike those, there's no UNIQUE constraint column
      // relying on it -- carrier_connections' own UNIQUE(tenant_id, carrier)
      // is what keeps one row per carrier per tenant, migration 0039).
      const result = await client.query<{ id: string; is_new: boolean }>(
        `INSERT INTO carrier_connections
           (tenant_id, carrier, encrypted_access_token, encrypted_client_id, encrypted_client_secret, status)
         VALUES ($1, 'royal_mail', $2, $3, $4, 'active')
         ON CONFLICT (tenant_id, carrier)
         DO UPDATE SET
           encrypted_access_token = EXCLUDED.encrypted_access_token,
           encrypted_client_id = EXCLUDED.encrypted_client_id,
           encrypted_client_secret = EXCLUDED.encrypted_client_secret,
           status = 'active',
           consecutive_failures = 0,
           updated_at = now()
         RETURNING id, (xmax = 0) AS is_new`,
        [user.tenantId, encryptedAccessToken, encryptedClientId, encryptedClientSecret],
      );
      const { id, is_new: isNew } = result.rows[0]!;

      // Never logs a secret value, same "details never includes the actual
      // secret" hard rule CLAUDE.md §17's channel-connection-credentials
      // coverage already established.
      await recordAuditEvent(client, {
        tenantId: user.tenantId,
        userId: user.id,
        action: isNew ? "carrier_connection.connected" : "carrier_connection.credentials_rotated",
        entityType: "carrier_connection",
        entityId: id,
        details: { carrier: "royal_mail", trackingConfigured: Boolean(trackingClientId && trackingClientSecret) },
      });
    });
  } catch (err) {
    return redirectWithError(req, "/settings/carriers", `royal_mail_save_failed:${errorMessage(err)}`);
  }

  return redirectTo(req, "/settings/carriers?connected=royal_mail");
}
