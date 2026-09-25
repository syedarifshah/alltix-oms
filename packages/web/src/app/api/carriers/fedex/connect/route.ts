import type { NextRequest } from "next/server";
import { withTenant, encryptChannelSecret, recordAuditEvent } from "@alltix/db";
import { FedExConnector } from "@alltix/carrier-connectors";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";
import { checkRateLimit, RATE_LIMIT_ERROR_MESSAGE } from "@/lib/rate-limit";
import { isCarrierEnabledForTenant } from "@/lib/carrier-flags";

export const dynamic = "force-dynamic";

/**
 * POST /api/carriers/fedex/connect -- persists a tenant's FedEx Project API
 * Key/Secret + account number from the /settings/carriers "Connect FedEx"
 * form. Same shape and same "verify before persist" discipline as
 * /api/carriers/evri/connect (see that route's own doc comment) -- a plain
 * HTML form POSTed in one step, no OAuth redirect, since FedEx's own
 * credential model is a static client_id/client_secret pair (see
 * FedExConnector's own class doc comment for the full CONFIRMED/INFERRED
 * research trail: this is the best-documented carrier researched so far,
 * with a literal rendered OAuth example found on FedEx's own docs page).
 *
 * Three fields, not two -- unlike Royal Mail's/Evri's own connect routes,
 * FedEx's Ship/Rate API bodies both require a real `accountNumber` on every
 * request (confirmed field), so this form collects it up front and stores
 * it in `carrier_connections.external_account_id` -- the first carrier in
 * this codebase's carrier layer where that column holds a genuinely real,
 * independent account identifier (see FedExCredentials' own doc comment in
 * fedex-connector.ts).
 *
 * UNVERIFIED IN PRACTICE, same status Royal Mail's and Evri's own connect
 * routes carried before each carrier's own build: no real FedEx credentials
 * exist anywhere in this codebase or Arif's account yet. Submitting a wrong
 * or placeholder credential set here will correctly fail at
 * verifyConnection() below rather than silently "connecting" nothing.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const pool = getAppPool();
  const user = await requireCurrentUser(req, pool);
  if (!user) {
    return redirectWithError(req, "/settings/carriers", "not signed in");
  }

  if (await checkRateLimit(pool, user.tenantId, "carriers.fedex.connect")) {
    return redirectWithError(req, "/settings/carriers", RATE_LIMIT_ERROR_MESSAGE);
  }

  if (!(await isCarrierEnabledForTenant(pool, user.tenantId, "fedex"))) {
    return redirectWithError(req, "/settings/carriers", "fedex_carrier_not_enabled");
  }

  const formData = await req.formData();
  const clientId = String(formData.get("clientId") ?? "").trim();
  const clientSecret = String(formData.get("clientSecret") ?? "").trim();
  const accountNumber = String(formData.get("accountNumber") ?? "").trim();

  if (!clientId || !clientSecret || !accountNumber) {
    return redirectWithError(req, "/settings/carriers", "fedex_missing_fields");
  }

  const connector = new FedExConnector({ clientId, clientSecret, accountNumber });
  try {
    await connector.verifyConnection();
  } catch (err) {
    return redirectWithError(req, "/settings/carriers", `fedex_verify_failed:${errorMessage(err)}`);
  }

  try {
    await withTenant(pool, user.tenantId, async (client) => {
      const encryptedClientId = await encryptChannelSecret(client, clientId);
      const encryptedClientSecret = await encryptChannelSecret(client, clientSecret);

      const result = await client.query<{ id: string; is_new: boolean }>(
        `INSERT INTO carrier_connections
           (tenant_id, carrier, encrypted_client_id, encrypted_client_secret, external_account_id, status)
         VALUES ($1, 'fedex', $2, $3, $4, 'active')
         ON CONFLICT (tenant_id, carrier)
         DO UPDATE SET
           encrypted_client_id = EXCLUDED.encrypted_client_id,
           encrypted_client_secret = EXCLUDED.encrypted_client_secret,
           external_account_id = EXCLUDED.external_account_id,
           status = 'active',
           consecutive_failures = 0,
           updated_at = now()
         RETURNING id, (xmax = 0) AS is_new`,
        [user.tenantId, encryptedClientId, encryptedClientSecret, accountNumber],
      );
      const { id, is_new: isNew } = result.rows[0]!;

      // Never logs a secret value, same hard rule CLAUDE.md §17's
      // channel-connection-credentials coverage already established. The
      // account number itself is NOT a secret (it's the same identifier a
      // FedEx invoice/label already carries) so it's safe in `details`,
      // unlike client_id/client_secret.
      await recordAuditEvent(client, {
        tenantId: user.tenantId,
        userId: user.id,
        action: isNew ? "carrier_connection.connected" : "carrier_connection.credentials_rotated",
        entityType: "carrier_connection",
        entityId: id,
        details: { carrier: "fedex", accountNumber },
      });
    });
  } catch (err) {
    return redirectWithError(req, "/settings/carriers", `fedex_save_failed:${errorMessage(err)}`);
  }

  return redirectTo(req, "/settings/carriers?connected=fedex");
}
