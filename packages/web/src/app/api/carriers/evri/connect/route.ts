import type { NextRequest } from "next/server";
import { withTenant, encryptChannelSecret, recordAuditEvent } from "@alltix/db";
import { EvriConnector } from "@alltix/carrier-connectors";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";
import { checkRateLimit, RATE_LIMIT_ERROR_MESSAGE } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * POST /api/carriers/evri/connect -- persists a tenant's Sapient/Evri
 * client_id + client_secret from the /settings/carriers "Connect Evri"
 * form. Same shape and same "verify before persist" discipline as
 * /api/carriers/royal-mail/connect (see that route's own doc comment for
 * the full reasoning) -- a plain HTML form POSTed in one step, no OAuth
 * redirect, since Sapient's own credential model is a static client_id/
 * client_secret pair, not a consent screen (see EvriConnector's own class
 * doc comment for the full CONFIRMED/INFERRED research trail: this is a
 * gateway integration, not a direct Evri API, since Evri itself publishes
 * no self-serve API of any kind).
 *
 * Unlike Royal Mail's Click & Drop key (used directly, no verification call
 * needed other than a real read), Sapient's own credential pair genuinely
 * needs a live OAuth2 token exchange to prove it's real --
 * EvriConnector.verifyConnection() does exactly that (see its own doc
 * comment for why it reuses the token exchange itself as the verification
 * call, no cheaper authenticated read-only endpoint having been found for
 * Sapient this pass).
 *
 * UNVERIFIED IN PRACTICE, same status Royal Mail's own connect route
 * carried before Royal Mail's build, and more so: no real Sapient
 * client_id/client_secret exists anywhere in this codebase or Arif's
 * account yet, and unlike Royal Mail's Click & Drop API key (a real,
 * confirmed credential shape), Sapient's own token-exchange request shape
 * is itself INFERRED, not confirmed by a literal example (see
 * EvriConnector's own class doc comment). Submitting a wrong or placeholder
 * credential pair here will correctly fail at verifyConnection() below
 * rather than silently "connecting" nothing.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const pool = getAppPool();
  const user = await requireCurrentUser(req, pool);
  if (!user) {
    return redirectWithError(req, "/settings/carriers", "not signed in");
  }

  if (await checkRateLimit(pool, user.tenantId, "carriers.evri.connect")) {
    return redirectWithError(req, "/settings/carriers", RATE_LIMIT_ERROR_MESSAGE);
  }

  const formData = await req.formData();
  const clientId = String(formData.get("clientId") ?? "").trim();
  const clientSecret = String(formData.get("clientSecret") ?? "").trim();

  if (!clientId || !clientSecret) {
    return redirectWithError(req, "/settings/carriers", "evri_missing_fields");
  }

  const connector = new EvriConnector({ clientId, clientSecret });
  try {
    await connector.verifyConnection();
  } catch (err) {
    return redirectWithError(req, "/settings/carriers", `evri_verify_failed:${errorMessage(err)}`);
  }

  try {
    await withTenant(pool, user.tenantId, async (client) => {
      const encryptedClientId = await encryptChannelSecret(client, clientId);
      const encryptedClientSecret = await encryptChannelSecret(client, clientSecret);

      // No independent account identifier exists to put in
      // external_account_id -- same "nothing real to reuse" reasoning
      // Royal Mail's own connect route already documents; carrier_connections'
      // own UNIQUE(tenant_id, carrier) constraint (migration 0039) is what
      // keeps one row per carrier per tenant regardless.
      const result = await client.query<{ id: string; is_new: boolean }>(
        `INSERT INTO carrier_connections
           (tenant_id, carrier, encrypted_client_id, encrypted_client_secret, status)
         VALUES ($1, 'evri', $2, $3, 'active')
         ON CONFLICT (tenant_id, carrier)
         DO UPDATE SET
           encrypted_client_id = EXCLUDED.encrypted_client_id,
           encrypted_client_secret = EXCLUDED.encrypted_client_secret,
           status = 'active',
           consecutive_failures = 0,
           updated_at = now()
         RETURNING id, (xmax = 0) AS is_new`,
        [user.tenantId, encryptedClientId, encryptedClientSecret],
      );
      const { id, is_new: isNew } = result.rows[0]!;

      // Never logs a secret value, same hard rule CLAUDE.md §17's
      // channel-connection-credentials coverage already established.
      await recordAuditEvent(client, {
        tenantId: user.tenantId,
        userId: user.id,
        action: isNew ? "carrier_connection.connected" : "carrier_connection.credentials_rotated",
        entityType: "carrier_connection",
        entityId: id,
        details: { carrier: "evri" },
      });
    });
  } catch (err) {
    return redirectWithError(req, "/settings/carriers", `evri_save_failed:${errorMessage(err)}`);
  }

  return redirectTo(req, "/settings/carriers?connected=evri");
}
