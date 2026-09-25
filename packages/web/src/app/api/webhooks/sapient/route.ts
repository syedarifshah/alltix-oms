import { NextResponse, type NextRequest } from "next/server";
import type { Pool } from "pg";
import { withTenant } from "@alltix/db";
import { getAppPool, getAdminPool } from "@/lib/db";
import { parseSapientTrackingWebhookPayload, buildSapientTrackingIdempotencyKey } from "@/lib/sapient-webhook";

export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/sapient -- the real tracking-delivery mechanism for the
 * two carriers this codebase built against Sapient's own CORE API gateway
 * (Evri, §19.2; DPD, §19.7), closing the architectural mismatch both
 * connectors' own trackShipment() have carried since Evri was built:
 * Sapient's own docs confirm POST /v4/trackings is meant for registering
 * tracking numbers from OTHER systems, not polling a shipment created
 * within the same Sapient account, and that real tracking delivery is a
 * configured webhook instead. This route is that webhook's receiving end.
 * See packages/web/src/lib/sapient-webhook.ts's own header comment for the
 * full research trail on what is and isn't confirmed about the payload
 * shape -- not restated here.
 *
 * SETUP IS MANUAL, NOT AN API CALL THIS CODEBASE MAKES: Sapient's own
 * "Set up tracking webhook connection" guide describes a 5-step PORTAL
 * process (access, configure, test, select event types, activate) -- unlike
 * ShopifyConnector.registerWebhooks() (a real POST this codebase makes),
 * there is no confirmed REST endpoint to register a callback URL
 * programmatically. Arif configures this manually in Sapient's own portal
 * once a real account exists, pointing the callback at this route's own
 * path on this app's deployed domain (see /settings/carriers' Evri/DPD info
 * boxes for the exact text shown).
 *
 * NO CONFIRMED SIGNATURE/HMAC VERIFICATION MECHANISM EXISTS FOR THIS
 * WEBHOOK -- confirmed by its total absence across every Sapient doc page
 * fetched this research pass, unlike Shopify's own HMAC-verified webhook
 * (CLAUDE.md §4.5, CLAUDE.md §6: "validate signatures on every inbound
 * webhook ... don't trust unsigned payloads"). SAPIENT_WEBHOOK_SHARED_SECRET
 * is this codebase's OWN app-layer mitigation for that real gap, not
 * something Sapient itself verifies: an optional query-string token
 * (`?token=...`) Arif appends to the callback URL he pastes into Sapient's
 * portal -- Sapient has no way to "sign" anything with it, but an attacker
 * who doesn't know the token can't hit this endpoint at all, which is
 * real protection even without cryptographic proof of origin. Deliberately
 * a no-op (skips the check entirely) when the env var is unset, same
 * "wire it now, verify later" pattern every other optional credential in
 * this codebase follows (CLAUDE.md §13) -- but that means an UNCONFIGURED
 * deployment of this route has NO protection at all beyond "the attacker
 * has to already know a real tracking number," worth being explicit about
 * rather than leaving implicit.
 *
 * Blast radius even with no token configured, worth being explicit about:
 * a forged delivery can only ever affect the ONE shipment row whose own
 * (already-random, carrier-issued) tracking_number matches what the forger
 * guessed or already knew -- it can insert a fabricated
 * shipment_tracking_events row and overwrite that one shipment's own
 * latest_tracking_* columns, nothing more. It cannot create, cancel, or
 * reroute an order, move money, or read/write anything outside that single
 * matched shipment (the adminPool lookup below is scoped to exactly the
 * tracking_number in the payload, and every write after that goes through
 * withTenant() for the tenant that row actually belongs to). Not nothing,
 * but a real ceiling on how bad an unconfigured deployment's exposure is.
 *
 * Multi-tenant resolution, same shape and same justification as
 * resolveShopifyWebhookTenant() (CLAUDE.md §4.5's own webhooks/shopify
 * route): a Sapient delivery carries no tenant id, only whatever tracking
 * number Sapient itself issued when EvriConnector.createShipment()/
 * DpdConnector.createShipment() first requested a label -- resolving that to
 * a tenant and a shipment row is an inherently cross-tenant lookup, so
 * resolveOwningShipment() below uses getAdminPool() (bypasses RLS) for
 * exactly that one query. Every subsequent read/write goes through
 * getAppPool() via withTenant(), scoped exactly like the rest of the app.
 *
 * An unrecognized tracking number (no matching shipments row) is logged and
 * acknowledged with 200, not 404/500 -- Sapient's own CONFIRMED retry
 * policy (8 attempts, 5 minutes up to 72 hours apart, escalating to
 * suspending the webhook entirely on exhaustion) means a non-2xx response
 * to a delivery this app can never resolve (a stray notification, a
 * misconfigured callback URL on a different Sapient account) would just
 * burn through that whole retry schedule for nothing and risk suspending
 * real, resolvable deliveries right along with it -- there is no scenario
 * where retrying an unresolvable delivery would ever start resolving.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const configuredToken = process.env.SAPIENT_WEBHOOK_SHARED_SECRET;
  if (configuredToken) {
    const providedToken = req.nextUrl.searchParams.get("token");
    if (providedToken !== configuredToken) {
      console.warn("Sapient webhook: rejected delivery with missing or incorrect ?token= -- SAPIENT_WEBHOOK_SHARED_SECRET is configured.");
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const events = parseSapientTrackingWebhookPayload(body);
  if (events.length === 0) {
    console.warn("Sapient webhook: received a delivery with no recognizable event -- acknowledging, nothing to record.");
    return NextResponse.json({ status: "ok", recorded: 0 });
  }

  const appPool = getAppPool();
  const adminPool = getAdminPool();
  let recorded = 0;
  let unmatched = 0;

  for (const event of events) {
    if (!event.trackingNumber) {
      console.warn("Sapient webhook: an event in this delivery had no recognizable tracking number field -- skipping that event, raw payload was kept in the request logs only.");
      unmatched++;
      continue;
    }

    const owner = await resolveOwningShipment(adminPool, event.trackingNumber);
    if (!owner) {
      console.warn(
        `Sapient webhook: no shipment found for tracking number '${event.trackingNumber}' -- acknowledging (not an error on this delivery's part, see this route's own doc comment on why unresolved deliveries aren't retried).`,
      );
      unmatched++;
      continue;
    }

    const idempotencyKey = buildSapientTrackingIdempotencyKey(owner.shipmentId, event);
    await withTenant(appPool, owner.tenantId, async (client) => {
      await client.query(
        `INSERT INTO shipment_tracking_events
           (tenant_id, shipment_id, carrier, event_code, milestone, description, location, occurred_at, raw_payload, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          owner.tenantId,
          owner.shipmentId,
          owner.carrier,
          event.eventCode,
          event.milestone,
          event.description,
          event.location,
          event.occurredAt,
          JSON.stringify(event),
          idempotencyKey,
        ],
      );

      // "Latest" is whichever of description/milestone this event actually
      // carried -- never overwritten with a null just because this
      // particular event didn't have one, so a later event with only a
      // milestone (no description) doesn't blank out a status description
      // an earlier event did carry, and vice versa. occurred_at DOES
      // overwrite unconditionally when present, on the theory that a
      // NEWER webhook delivery's own timestamp (even one that itself
      // parsed a different subset of fields) is still the better "as of"
      // marker than an older one -- Sapient's own delivery order isn't
      // confirmed to be strictly sequential, but this is the closest
      // approximation available without a confirmed event-sequence field.
      await client.query(
        `UPDATE shipments
            SET latest_tracking_status = COALESCE($2, latest_tracking_status),
                latest_tracking_milestone = COALESCE($3, latest_tracking_milestone),
                latest_tracking_at = COALESCE($4, latest_tracking_at),
                updated_at = now()
          WHERE id = $1`,
        [owner.shipmentId, event.description ?? event.milestone, event.milestone, event.occurredAt],
      );
    });
    recorded++;
  }

  return NextResponse.json({ status: "ok", recorded, unmatched });
}

interface ResolvedShipmentOwner {
  tenantId: string;
  shipmentId: string;
  carrier: string;
}

/**
 * The one deliberately cross-tenant lookup this route needs -- see this
 * file's own header comment for why getAdminPool() is justified here.
 * Scoped to carrier IN ('evri', 'dpd') -- the only two carriers actually
 * routed through Sapient (CLAUDE.md §19.2/§19.7); every other carrier's own
 * tracking_number lives in a structurally unrelated numbering scheme, so
 * this scope is real defense against an accidental cross-carrier collision,
 * not just documentation. Most-recently-created match wins for the rare
 * case a tracking number were ever reused (shipments has no UNIQUE
 * constraint on tracking_number, migration 0039's own doc comment on why:
 * a void-and-recreate needs a second row) -- an extremely unlikely
 * collision in practice, since Sapient itself issues these numbers.
 */
async function resolveOwningShipment(adminPool: Pool, trackingNumber: string): Promise<ResolvedShipmentOwner | null> {
  const result = await adminPool.query<{ tenant_id: string; id: string; carrier: string }>(
    `SELECT tenant_id, id, carrier
       FROM shipments
      WHERE tracking_number = $1 AND carrier IN ('evri', 'dpd')
      ORDER BY created_at DESC
      LIMIT 1`,
    [trackingNumber],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { tenantId: row.tenant_id, shipmentId: row.id, carrier: row.carrier };
}
