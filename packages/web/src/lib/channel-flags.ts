import type { Pool, PoolClient } from "pg";
import { withTenant } from "@alltix/db";

/**
 * Per-tenant channel rollout gating -- CLAUDE.md §9's DevOps table listed
 * "Feature flags ... for gradually rolling out new channel connectors per
 * tenant" as future work; this is that feature, deliberately built as a
 * plain `tenants.enabled_channels TEXT[]` column (migration
 * 0032_tenants_enabled_channels.sql) rather than a LaunchDarkly/Unleash/etc.
 * integration -- same "don't stand up infra a single self-testing tenant
 * hasn't earned yet" call this codebase already makes for BullMQ/Redis
 * (§4.4) and Kafka (§1). See CLAUDE.md's "Channel Feature Flags" section
 * for the full design and scope boundary (this gates *connecting* a
 * channel -- see that section for why it deliberately does NOT gate an
 * already-connected channel's ongoing scheduler sync).
 *
 * ALL_CHANNELS is the single source of truth for "what channels exist" at
 * the app layer -- migration 0032's own CHECK constraint hardcodes the
 * identical list at the DB layer (defense-in-depth, same principle CLAUDE.md
 * §6 applies to tenant isolation). If a seventh channel connector is ever
 * added, both lists need updating together -- there is no way to derive one
 * from the other across the app/DB boundary.
 */
export const ALL_CHANNELS = ["amazon", "shopify", "walmart", "ebay", "temu", "tiktok"] as const;

export type Channel = (typeof ALL_CHANNELS)[number];

function isKnownChannel(value: string): value is Channel {
  return (ALL_CHANNELS as readonly string[]).includes(value);
}

/**
 * Narrows a raw `tenants.enabled_channels` array (whatever Postgres handed
 * back) down to values this app still recognizes as a real channel --
 * pure, no DB/network, so it's unit-tested directly (see
 * test/channel-flags.test.ts), same "extract the pure decision, test it
 * directly" precedent packages/web/src/lib/reorder-threshold.ts and
 * packages/order-service's own extractUsShippingZip set. Guards against a
 * (currently impossible, since the DB CHECK constraint already blocks it)
 * stale/unrecognized value ever silently granting access to something --
 * an unrecognized entry is dropped, not passed through.
 */
export function filterKnownChannels(raw: readonly string[]): Channel[] {
  return raw.filter(isKnownChannel);
}

/** Reads the enabled-channels list for the tenant `client`'s transaction
 *  is already scoped to (RLS: `id = current_setting('app.tenant_id')`) --
 *  callers that already have an open `withTenant`/`withTenantAuth` client
 *  (e.g. a Route Handler wrapped in withTenantAuth, or the /settings/channels
 *  page's own query block) should call this directly rather than opening a
 *  second transaction via {@link isChannelEnabledForTenant}. */
export async function getEnabledChannels(client: PoolClient, tenantId: string): Promise<Channel[]> {
  const result = await client.query<{ enabled_channels: string[] }>(
    "SELECT enabled_channels FROM tenants WHERE id = $1",
    [tenantId],
  );
  return filterKnownChannels(result.rows[0]?.enabled_channels ?? []);
}

/** Same as {@link getEnabledChannels}, narrowed to a single yes/no for one
 *  channel -- the common case at every "Connect X" entry point. */
export async function isChannelEnabled(client: PoolClient, tenantId: string, channel: Channel): Promise<boolean> {
  const enabled = await getEnabledChannels(client, tenantId);
  return enabled.includes(channel);
}

/**
 * Pool-level convenience for a Route Handler that does NOT already have an
 * open tenant-scoped client (the Shopify/Walmart/Temu/TikTok-manual connect
 * routes' own POST handlers -- see each route's doc comment for why they
 * use requireCurrentUser instead of withTenantAuth: their first real step
 * is a live credential-verification network call, and holding a Postgres
 * transaction open across that is what withTenantAuth's own doc comment
 * warns against). Opens and closes its own short-lived withTenant
 * transaction, mirroring resolveTenantId's own wrap-withClerkUser shape in
 * with-tenant-auth.ts.
 */
export async function isChannelEnabledForTenant(pool: Pool, tenantId: string, channel: Channel): Promise<boolean> {
  return withTenant(pool, tenantId, (client) => isChannelEnabled(client, tenantId, channel));
}
