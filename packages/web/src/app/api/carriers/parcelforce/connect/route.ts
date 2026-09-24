import type { NextRequest } from "next/server";
import { withTenant, encryptChannelSecret, recordAuditEvent } from "@alltix/db";
import { ParcelforceConnector } from "@alltix/carrier-connectors";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";
import { checkRateLimit, RATE_LIMIT_ERROR_MESSAGE } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * POST /api/carriers/parcelforce/connect -- persists a tenant's expressLink
 * username/password/contract number from the /settings/carriers "Connect
 * Parcelforce" form. Same three-field shape and same "verify before
 * persist" discipline as /api/carriers/fedex/connect (see that route's own
 * doc comment) -- a plain HTML form POSTed in one step, no OAuth redirect,
 * since Parcelforce's own expressLink credential model is a static
 * username/password/contract-number triple embedded in each SOAP request
 * body, not exchanged for anything (see ParcelforceConnector's own class
 * doc comment for the full CONFIRMED/INFERRED research trail).
 *
 * UNVERIFIED IN PRACTICE, same status every other carrier's own connect
 * route carried before that carrier's own first live pass -- with one real
 * difference worth being explicit about: unlike Royal Mail's and FedEx's
 * own self-serve credential issuance, Parcelforce's expressLink is a
 * closed, contract-gated API (see ParcelforceConnector's own class doc
 * comment) -- no real credentials exist anywhere in this codebase or
 * Arif's account yet, and getting even TEST credentials requires first
 * contacting Parcelforce's own Customer Solutions Team directly. Submitting
 * a wrong or placeholder credential set here will correctly fail at
 * verifyConnection() below rather than silently "connecting" nothing --
 * though see ParcelforceConnector.verifyConnection()'s own doc comment for
 * why that check itself is this connector's single least-confirmed piece.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const pool = getAppPool();
  const user = await requireCurrentUser(req, pool);
  if (!user) {
    return redirectWithError(req, "/settings/carriers", "not signed in");
  }

  if (await checkRateLimit(pool, user.tenantId, "carriers.parcelforce.connect")) {
    return redirectWithError(req, "/settings/carriers", RATE_LIMIT_ERROR_MESSAGE);
  }

  const formData = await req.formData();
  const username = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "").trim();
  const contractNumber = String(formData.get("contractNumber") ?? "").trim();

  if (!username || !password || !contractNumber) {
    return redirectWithError(req, "/settings/carriers", "parcelforce_missing_fields");
  }

  const connector = new ParcelforceConnector({ username, password, contractNumber });
  try {
    await connector.verifyConnection();
  } catch (err) {
    return redirectWithError(req, "/settings/carriers", `parcelforce_verify_failed:${errorMessage(err)}`);
  }

  try {
    await withTenant(pool, user.tenantId, async (client) => {
      const encryptedUsername = await encryptChannelSecret(client, username);
      const encryptedPassword = await encryptChannelSecret(client, password);

      const result = await client.query<{ id: string; is_new: boolean }>(
        `INSERT INTO carrier_connections
           (tenant_id, carrier, encrypted_client_id, encrypted_client_secret, external_account_id, status)
         VALUES ($1, 'parcelforce', $2, $3, $4, 'active')
         ON CONFLICT (tenant_id, carrier)
         DO UPDATE SET
           encrypted_client_id = EXCLUDED.encrypted_client_id,
           encrypted_client_secret = EXCLUDED.encrypted_client_secret,
           external_account_id = EXCLUDED.external_account_id,
           status = 'active',
           consecutive_failures = 0,
           updated_at = now()
         RETURNING id, (xmax = 0) AS is_new`,
        [user.tenantId, encryptedUsername, encryptedPassword, contractNumber],
      );
      const { id, is_new: isNew } = result.rows[0]!;

      // Never logs a secret value, same hard rule CLAUDE.md §17's
      // channel-connection-credentials coverage already established. The
      // contract number itself is NOT a secret (it's the same identifier a
      // Parcelforce invoice/manifest already carries) so it's safe in
      // `details`, unlike username/password.
      await recordAuditEvent(client, {
        tenantId: user.tenantId,
        userId: user.id,
        action: isNew ? "carrier_connection.connected" : "carrier_connection.credentials_rotated",
        entityType: "carrier_connection",
        entityId: id,
        details: { carrier: "parcelforce", contractNumber },
      });
    });
  } catch (err) {
    return redirectWithError(req, "/settings/carriers", `parcelforce_save_failed:${errorMessage(err)}`);
  }

  return redirectTo(req, "/settings/carriers?connected=parcelforce");
}
