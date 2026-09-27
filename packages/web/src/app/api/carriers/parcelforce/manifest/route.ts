import { NextResponse, type NextRequest } from "next/server";
import { withTenant, recordAuditEvent } from "@alltix/db";
import { createParcelforceConnectorFromCarrierConnection } from "@alltix/carrier-connectors";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";
import { checkRateLimit, RATE_LIMIT_ERROR_MESSAGE } from "@/lib/rate-limit";
import { isCarrierEnabledForTenant } from "@/lib/carrier-flags";
import { recordCarrierFailure, recordCarrierSuccess } from "@/lib/carrier-failure-tracking";

export const dynamic = "force-dynamic";

/**
 * POST /api/carriers/parcelforce/manifest -- real Parcelforce manifest
 * generation, closing out CLAUDE.md §19.4's own standing "Deliberately not
 * built this pass" line (repeated again in §19.10/§19.11 as the one
 * carrier-layer item still open once real credentials and real Sapient
 * webhook receiving were each either closed out or blocked on Arif's own
 * next vendor-facing step, not more of this codebase's own code) -- this is
 * that remaining, genuinely buildable-now item.
 *
 * Calls `ParcelforceConnector.generateManifest()` (see that method's own doc
 * comment in parcelforce-connector.ts for the confirmed/inferred
 * `createManifest`/`printManifest` request shape). Deliberately a plain,
 * no-argument, tenant-initiated action -- same "no scheduler job exists for
 * carriers at all" reasoning `ship-via-carrier`'s and `carrier-rate-estimate`'s
 * own doc comments already give (CLAUDE.md's "Carrier Feature Flags"
 * section) -- a manifest is a real, close-of-day sweep the tenant triggers
 * by hand from /settings/carriers, not something this app schedules.
 *
 * Two genuinely different non-error outcomes, both real per
 * `generateManifest()`'s own doc comment:
 *  - `manifestNumber` present: a real manifest was created. Within one
 *    `withTenant` transaction, this inserts a `carrier_manifests` row
 *    (migration 0042) and flips every one of this tenant's own
 *    `status = 'created'` Parcelforce shipments to `'manifested'`,
 *    recording `manifest_id` on each -- the same "the ledger should show
 *    why" principle CLAUDE.md §2.2/§3 already apply to inventory events and
 *    order cancellation, now applied to shipments finally getting the
 *    `'manifested'` status value `shipments.status`'s own CHECK constraint
 *    (migration 0039) has allowed since day one with no writer until now.
 *    Records `carrier_manifest.generated` in the audit log (CLAUDE.md §17),
 *    inside the same transaction so a rolled-back manifest never leaves a
 *    committed audit row behind.
 *  - `manifestNumber` null: "nothing was pending to manifest" -- a real,
 *    ordinary outcome for a tenant who hasn't shipped anything new since the
 *    last manifest, not an error. No DB writes happen on this branch at
 *    all (no manifest row, no shipment updates, no audit event) -- there is
 *    nothing real to record. Redirected as an informational, non-error
 *    query param (`manifestInfo=`), never `error=`, so /settings/carriers
 *    doesn't render this the same way a real failure would.
 *
 * Same cross-run circuit-breaker discipline every other real, live carrier
 * connector call in this app already follows (CLAUDE.md §19.11,
 * carrier-failure-tracking.ts's own header comment): only the real
 * `connector.generateManifest()` call itself is wrapped with
 * recordCarrierFailure()/recordCarrierSuccess(), never
 * createParcelforceConnectorFromCarrierConnection()'s own credential load,
 * which already fails on its own separate, unrelated "not connected"
 * condition.
 *
 * UNVERIFIED IN PRACTICE, same status every other Parcelforce feature in
 * this codebase carries (CLAUDE.md §19.4): no real Parcelforce expressLink
 * credentials exist anywhere in this codebase or Arif's account yet, so this
 * route's own real `createManifest`/`printManifest` calls have never
 * round-tripped against real infrastructure.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const pool = getAppPool();
  const user = await requireCurrentUser(req, pool);
  if (!user) {
    return redirectWithError(req, "/settings/carriers", "not signed in");
  }

  if (await checkRateLimit(pool, user.tenantId, "carriers.parcelforce.manifest")) {
    return redirectWithError(req, "/settings/carriers", RATE_LIMIT_ERROR_MESSAGE);
  }

  // Same ongoing-use carrier feature-flag gate ship-via-carrier's/
  // carrier-rate-estimate's own routes already apply (CLAUDE.md's "Carrier
  // Feature Flags" section) -- a tenant Parcelforce is disabled for
  // shouldn't be able to generate a real manifest against it either.
  if (!(await isCarrierEnabledForTenant(pool, user.tenantId, "parcelforce"))) {
    return redirectWithError(req, "/settings/carriers", "parcelforce_carrier_not_enabled");
  }

  try {
    const connector = await createParcelforceConnectorFromCarrierConnection(pool, user.tenantId);

    // Cross-run circuit-breaker (CLAUDE.md §19.11) -- same "only the real,
    // live connector call itself is tracked" discipline every other real
    // carrier call in this app already applies, not the credential load
    // above (which fails on its own unrelated "not connected" condition).
    let manifest;
    try {
      manifest = await connector.generateManifest();
    } catch (err) {
      await recordCarrierFailure(pool, user.tenantId, "parcelforce", errorMessage(err));
      throw err;
    }
    await recordCarrierSuccess(pool, user.tenantId, "parcelforce");

    if (!manifest.manifestNumber) {
      // A real, non-error outcome -- see generateManifest()'s own doc
      // comment on why "nothing pending to manifest" isn't a failure. No DB
      // writes on this branch: there is nothing real to record.
      return redirectTo(req, "/settings/carriers?manifestInfo=parcelforce_nothing_pending");
    }

    const shipmentsCovered = await withTenant(pool, user.tenantId, async (client) => {
      const connectionResult = await client.query<{ id: string }>(
        `SELECT id FROM carrier_connections
          WHERE tenant_id = $1 AND carrier = 'parcelforce' AND status = 'active'
          LIMIT 1`,
        [user.tenantId],
      );
      const carrierConnectionId = connectionResult.rows[0]?.id ?? null;

      const manifestInsert = await client.query<{ id: string }>(
        `INSERT INTO carrier_manifests
           (tenant_id, carrier, carrier_connection_id, manifest_number, document_base64, raw_payload)
         VALUES ($1, 'parcelforce', $2, $3, $4, $5)
         RETURNING id`,
        [
          user.tenantId,
          carrierConnectionId,
          manifest.manifestNumber,
          manifest.documentBase64,
          JSON.stringify(manifest.raw),
        ],
      );
      const manifestId = manifestInsert.rows[0]!.id;

      const shipmentsUpdate = await client.query(
        `UPDATE shipments
            SET status = 'manifested', manifest_id = $1, updated_at = now()
          WHERE tenant_id = $2 AND carrier = 'parcelforce' AND status = 'created'`,
        [manifestId, user.tenantId],
      );
      const covered = shipmentsUpdate.rowCount ?? 0;

      await recordAuditEvent(client, {
        tenantId: user.tenantId,
        userId: user.id,
        action: "carrier_manifest.generated",
        entityType: "carrier_manifest",
        entityId: manifestId,
        details: { carrier: "parcelforce", manifestNumber: manifest.manifestNumber, shipmentsCovered: covered },
      });

      return covered;
    });

    const url = new URL("/settings/carriers", req.url);
    url.searchParams.set("manifestGenerated", "parcelforce");
    url.searchParams.set("manifestNumber", manifest.manifestNumber);
    url.searchParams.set("manifestShipmentsCovered", String(shipmentsCovered));
    return NextResponse.redirect(url, { status: 303 });
  } catch (err) {
    return redirectWithError(req, "/settings/carriers", `parcelforce_manifest_failed:${errorMessage(err)}`);
  }
}
