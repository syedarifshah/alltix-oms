import type { Pool, PoolClient } from "pg";
import { withTenant } from "@alltix/db";

/**
 * Per-tenant carrier rollout gating -- the carrier-layer counterpart of
 * channel-flags.ts (migration 0032, CLAUDE.md §15), applied to
 * carrier_connections (migration 0039) via a new
 * tenants.enabled_carriers TEXT[] column (migration
 * 0040_tenants_enabled_carriers.sql). Structurally an almost line-for-line
 * mirror of channel-flags.ts -- deliberately, so the two features stay easy
 * to reason about together rather than drifting into two different shapes
 * for the same underlying idea. See CLAUDE.md's "Carrier Feature Flags"
 * section for the full design and scope boundary (this gates *connecting*
 * a carrier AND generating a new shipment via an already-connected one --
 * see that section for why carriers need the second half too, unlike
 * channels' own scheduler-sync gate: carriers have no scheduler job at all,
 * CLAUDE.md §19's own "Kept on the row... but nothing writes to them yet"
 * note on carrier_connections' failure-tracking columns already says so --
 * ship-via-carrier's own POST is the only "ongoing use" a carrier
 * connection ever gets).
 *
 * ALL_CARRIERS is the single source of truth for "what carriers exist" at
 * the app layer -- migration 0040's own CHECK constraint hardcodes the
 * identical list at the DB layer (defense-in-depth, same principle CLAUDE.md
 * §6 applies to tenant isolation). Deliberately narrower than
 * carrier_connections' own CHECK (migration 0039), which still allows
 * 'hermes' as a historical artifact from before Hermes/Evri were confirmed
 * to be the same carrier (§19.2) -- there is no connector, no connect
 * route, and no /settings/carriers card for 'hermes', so it has no place
 * in this list. If an 8th carrier connector is ever added, both this list
 * and migration 0040's CHECK need updating together -- there is no way to
 * derive one from the other across the app/DB boundary, same standing
 * caveat channel-flags.ts's own header comment carries.
 */
export const ALL_CARRIERS = ["royal_mail", "evri", "fedex", "parcelforce", "ups", "dhl", "dpd"] as const;

export type Carrier = (typeof ALL_CARRIERS)[number];

function isKnownCarrier(value: string): value is Carrier {
  return (ALL_CARRIERS as readonly string[]).includes(value);
}

/**
 * Narrows a raw `tenants.enabled_carriers` array (whatever Postgres handed
 * back) down to values this app still recognizes as a real carrier -- pure,
 * no DB/network, so it's unit-tested directly (see
 * test/carrier-flags.test.ts), same "extract the pure decision, test it
 * directly" precedent channel-flags.ts's own filterKnownChannels sets.
 * Guards against a (currently impossible, since the DB CHECK constraint
 * already blocks it) stale/unrecognized value ever silently granting
 * access to something -- an unrecognized entry is dropped, not passed
 * through.
 */
export function filterKnownCarriers(raw: readonly string[]): Carrier[] {
  return raw.filter(isKnownCarrier);
}

/** Reads the enabled-carriers list for the tenant `client`'s transaction is
 *  already scoped to (RLS: `id = current_setting('app.tenant_id')`) --
 *  callers that already have an open `withTenant` client (e.g.
 *  /settings/carriers' own query block) should call this directly rather
 *  than opening a second transaction via {@link isCarrierEnabledForTenant}. */
export async function getEnabledCarriers(client: PoolClient, tenantId: string): Promise<Carrier[]> {
  const result = await client.query<{ enabled_carriers: string[] }>(
    "SELECT enabled_carriers FROM tenants WHERE id = $1",
    [tenantId],
  );
  return filterKnownCarriers(result.rows[0]?.enabled_carriers ?? []);
}

/** Same as {@link getEnabledCarriers}, narrowed to a single yes/no for one
 *  carrier -- the common case at every "Connect X" entry point and at
 *  ship-via-carrier's own dispatch. */
export async function isCarrierEnabled(client: PoolClient, tenantId: string, carrier: Carrier): Promise<boolean> {
  const enabled = await getEnabledCarriers(client, tenantId);
  return enabled.includes(carrier);
}

/**
 * Pool-level convenience for a Route Handler that does NOT already have an
 * open tenant-scoped client -- every one of the 7 carrier connect routes
 * (none of them use withTenantAuth; see e.g.
 * /api/carriers/evri/connect/route.ts's own doc comment for why: their
 * first real step is a live credential-verification network call, and
 * holding a Postgres transaction open across that is what withTenantAuth's
 * own doc comment warns against) and ship-via-carrier itself all use this,
 * mirroring channel-flags.ts's own isChannelEnabledForTenant/
 * requireCurrentUser pairing exactly. Opens and closes its own short-lived
 * withTenant transaction.
 */
export async function isCarrierEnabledForTenant(pool: Pool, tenantId: string, carrier: Carrier): Promise<boolean> {
  return withTenant(pool, tenantId, (client) => isCarrierEnabled(client, tenantId, carrier));
}
