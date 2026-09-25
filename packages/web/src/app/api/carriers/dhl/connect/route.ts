import type { NextRequest } from "next/server";
import { withTenant, encryptChannelSecret, recordAuditEvent } from "@alltix/db";
import { DhlConnector } from "@alltix/carrier-connectors";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";
import { checkRateLimit, RATE_LIMIT_ERROR_MESSAGE } from "@/lib/rate-limit";
import { isCarrierEnabledForTenant } from "@/lib/carrier-flags";

export const dynamic = "force-dynamic";

/**
 * POST /api/carriers/dhl/connect -- persists a tenant's DHL Express MyDHL
 * API Basic-auth pair + account number from the /settings/carriers "Connect
 * DHL" form, plus an OPTIONAL fourth field for DHL's own separate Unified
 * Tracking API key. Same "verify before persist" discipline as every other
 * carrier connect route in this layer, calling DhlConnector.verifyConnection()
 * (a real live POST /rates call -- see DhlConnector's own class doc comment
 * for why that's the closest thing to a cheap authenticated read-only
 * endpoint this pass found for MyDHL API) before persisting anything.
 *
 * Four fields, not three -- apiKey/apiSecret/accountNumber (required, same
 * three-field shape as FedEx's/UPS's own connect routes, §19.3/§19.5) plus
 * an optional trackingApiKey (mirrors Royal Mail's own optional
 * trackingClientId/trackingClientSecret pair, §19.1's own connect route --
 * a tenant can connect labels/rates without configuring live tracking at
 * all, since DHL splits these across two genuinely separate APIs with two
 * separate credential sets -- see DhlConnector's own class doc comment).
 * `trackingApiKey` is stored in `carrier_connections.encrypted_refresh_token`
 * -- the FIRST carrier connect route in this layer to write to that column,
 * and NOT a literal OAuth refresh token (DhlCredentials.trackingApiKey's own
 * doc comment explains the reuse). Same "blank clears whatever was there"
 * behavior Royal Mail's own optional tracking-credential fields already
 * establish -- leaving this field blank on a later resubmission clears a
 * previously-configured tracking key rather than silently keeping it, since
 * this form (like every other carrier connect form in this codebase) always
 * submits full replacement values, never a partial "only what changed" diff.
 *
 * UNVERIFIED IN PRACTICE, same status every carrier's own connect route
 * carried before that carrier's own first live pass: no real DHL Express
 * API key/secret, account number, or Unified Tracking API key exists
 * anywhere in this codebase or Arif's account yet. Submitting a wrong or
 * placeholder credential set here will correctly fail at verifyConnection()
 * below rather than silently "connecting" nothing.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const pool = getAppPool();
  const user = await requireCurrentUser(req, pool);
  if (!user) {
    return redirectWithError(req, "/settings/carriers", "not signed in");
  }

  if (await checkRateLimit(pool, user.tenantId, "carriers.dhl.connect")) {
    return redirectWithError(req, "/settings/carriers", RATE_LIMIT_ERROR_MESSAGE);
  }

  if (!(await isCarrierEnabledForTenant(pool, user.tenantId, "dhl"))) {
    return redirectWithError(req, "/settings/carriers", "dhl_carrier_not_enabled");
  }

  const formData = await req.formData();
  const apiKey = String(formData.get("apiKey") ?? "").trim();
  const apiSecret = String(formData.get("apiSecret") ?? "").trim();
  const accountNumber = String(formData.get("accountNumber") ?? "").trim();
  const trackingApiKey = String(formData.get("trackingApiKey") ?? "").trim();

  if (!apiKey || !apiSecret || !accountNumber) {
    return redirectWithError(req, "/settings/carriers", "dhl_missing_fields");
  }

  const connector = new DhlConnector({
    apiKey,
    apiSecret,
    accountNumber,
    trackingApiKey: trackingApiKey || undefined,
  });
  try {
    await connector.verifyConnection();
  } catch (err) {
    return redirectWithError(req, "/settings/carriers", `dhl_verify_failed:${errorMessage(err)}`);
  }

  try {
    await withTenant(pool, user.tenantId, async (client) => {
      const encryptedClientId = await encryptChannelSecret(client, apiKey);
      const encryptedClientSecret = await encryptChannelSecret(client, apiSecret);
      const encryptedTrackingApiKey = trackingApiKey ? await encryptChannelSecret(client, trackingApiKey) : null;

      const result = await client.query<{ id: string; is_new: boolean }>(
        `INSERT INTO carrier_connections
           (tenant_id, carrier, encrypted_client_id, encrypted_client_secret, external_account_id, encrypted_refresh_token, status)
         VALUES ($1, 'dhl', $2, $3, $4, $5, 'active')
         ON CONFLICT (tenant_id, carrier)
         DO UPDATE SET
           encrypted_client_id = EXCLUDED.encrypted_client_id,
           encrypted_client_secret = EXCLUDED.encrypted_client_secret,
           external_account_id = EXCLUDED.external_account_id,
           encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
           status = 'active',
           consecutive_failures = 0,
           updated_at = now()
         RETURNING id, (xmax = 0) AS is_new`,
        [user.tenantId, encryptedClientId, encryptedClientSecret, accountNumber, encryptedTrackingApiKey],
      );
      const { id, is_new: isNew } = result.rows[0]!;

      // Never logs a secret value, same hard rule CLAUDE.md §17's
      // channel-connection-credentials coverage already established. The
      // account number itself is NOT a secret (it's the same identifier a
      // DHL invoice/label already carries) so it's safe in `details`,
      // unlike apiKey/apiSecret/trackingApiKey.
      await recordAuditEvent(client, {
        tenantId: user.tenantId,
        userId: user.id,
        action: isNew ? "carrier_connection.connected" : "carrier_connection.credentials_rotated",
        entityType: "carrier_connection",
        entityId: id,
        details: { carrier: "dhl", accountNumber, trackingConfigured: Boolean(trackingApiKey) },
      });
    });
  } catch (err) {
    return redirectWithError(req, "/settings/carriers", `dhl_save_failed:${errorMessage(err)}`);
  }

  return redirectTo(req, "/settings/carriers?connected=dhl");
}
