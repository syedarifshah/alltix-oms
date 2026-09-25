import type { NextRequest } from "next/server";
import { withTenant, encryptChannelSecret, recordAuditEvent } from "@alltix/db";
import { DpdConnector } from "@alltix/carrier-connectors";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";
import { checkRateLimit, RATE_LIMIT_ERROR_MESSAGE } from "@/lib/rate-limit";
import { isCarrierEnabledForTenant } from "@/lib/carrier-flags";

export const dynamic = "force-dynamic";

/**
 * POST /api/carriers/dpd/connect -- persists a tenant's Sapient/DPD
 * client_id + client_secret from the /settings/carriers "Connect DPD" form.
 * Same shape and same "verify before persist" discipline as
 * /api/carriers/evri/connect (see that route's own doc comment for the full
 * reasoning) -- a plain HTML form POSTed in one step, no OAuth redirect,
 * since Sapient's own credential model is a static client_id/client_secret
 * pair, not a consent screen (see DpdConnector's own class doc comment for
 * the full CONFIRMED/INFERRED research trail: DPD UK's own direct API is
 * confirmed to exist but has no publicly-readable technical reference, so
 * this connector integrates via the SAME Sapient/Intersoft CORE API gateway
 * EvriConnector already uses, not DPD UK's own direct API).
 *
 * Unlike Royal Mail's Click & Drop key (used directly, no verification call
 * needed other than a real read), Sapient's own credential pair genuinely
 * needs a live OAuth2 token exchange to prove it's real --
 * DpdConnector.verifyConnection() does exactly that (see its own doc
 * comment for why it reuses the token exchange itself as the verification
 * call, no cheaper authenticated read-only endpoint having been found for
 * Sapient this pass -- same reasoning EvriConnector.verifyConnection()
 * already carries, since both carriers share one gateway).
 *
 * UNVERIFIED IN PRACTICE, same status every other carrier connect route in
 * this layer carried before its own first live pass: no real Sapient
 * client_id/client_secret exists anywhere in this codebase or Arif's
 * account yet, and like Evri's own connect route, Sapient's token-exchange
 * request shape is itself INFERRED (reused, not re-derived, from
 * EvriConnector's own confirmed shape), not confirmed by a literal example.
 * Submitting a wrong or placeholder credential pair here will correctly
 * fail at verifyConnection() below rather than silently "connecting"
 * nothing.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const pool = getAppPool();
  const user = await requireCurrentUser(req, pool);
  if (!user) {
    return redirectWithError(req, "/settings/carriers", "not signed in");
  }

  if (await checkRateLimit(pool, user.tenantId, "carriers.dpd.connect")) {
    return redirectWithError(req, "/settings/carriers", RATE_LIMIT_ERROR_MESSAGE);
  }

  if (!(await isCarrierEnabledForTenant(pool, user.tenantId, "dpd"))) {
    return redirectWithError(req, "/settings/carriers", "dpd_carrier_not_enabled");
  }

  const formData = await req.formData();
  const clientId = String(formData.get("clientId") ?? "").trim();
  const clientSecret = String(formData.get("clientSecret") ?? "").trim();

  if (!clientId || !clientSecret) {
    return redirectWithError(req, "/settings/carriers", "dpd_missing_fields");
  }

  const connector = new DpdConnector({ clientId, clientSecret });
  try {
    await connector.verifyConnection();
  } catch (err) {
    return redirectWithError(req, "/settings/carriers", `dpd_verify_failed:${errorMessage(err)}`);
  }

  try {
    await withTenant(pool, user.tenantId, async (client) => {
      const encryptedClientId = await encryptChannelSecret(client, clientId);
      const encryptedClientSecret = await encryptChannelSecret(client, clientSecret);

      // No independent account identifier exists to put in
      // external_account_id -- same "nothing real to reuse" reasoning
      // Royal Mail's/Evri's own connect routes already document;
      // carrier_connections' own UNIQUE(tenant_id, carrier) constraint
      // (migration 0039) is what keeps one row per carrier per tenant
      // regardless.
      const result = await client.query<{ id: string; is_new: boolean }>(
        `INSERT INTO carrier_connections
           (tenant_id, carrier, encrypted_client_id, encrypted_client_secret, status)
         VALUES ($1, 'dpd', $2, $3, 'active')
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
        details: { carrier: "dpd" },
      });
    });
  } catch (err) {
    return redirectWithError(req, "/settings/carriers", `dpd_save_failed:${errorMessage(err)}`);
  }

  return redirectTo(req, "/settings/carriers?connected=dpd");
}
