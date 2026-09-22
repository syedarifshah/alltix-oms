import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createAppPool, withTenant } from "../packages/db/src/index.js";

// Deliberately NOT imported from packages/web/src/lib/channel-flags.ts --
// no other script in this repo reaches into @alltix/web's own src/ (every
// import here comes from an actual workspace package under packages/*),
// and packages/web isn't one of root tsconfig.json's project references
// (see build:web's own separate `npm run build --workspace=@alltix/web`),
// so nothing would catch this list and channel-flags.ts's own ALL_CHANNELS
// silently drifting apart. A third, identical list -- same tradeoff
// migration 0032's own CHECK constraint already accepts against the app
// layer's list. Keep all three in sync by hand if a channel is ever added.
const ALL_CHANNELS = ["amazon", "shopify", "walmart", "ebay", "temu", "tiktok"] as const;
type Channel = (typeof ALL_CHANNELS)[number];

// Operator-only CLI for toggling CLAUDE.md's "Channel Feature Flags"
// (migration 0032_tenants_enabled_channels.sql, packages/web/src/lib/
// channel-flags.ts) for one tenant -- there is no UI for this (deliberately:
// see that migration's own doc comment on why this is a plain column, not a
// LaunchDarkly-class integration, and CLAUDE.md's own "Channel Feature
// Flags" section for why an operator script is the right amount of tooling
// at this platform's current single-self-testing-tenant stage). Mirrors
// scripts/add-channel-listing.ts's own "general-purpose, production-safe,
// env-var-driven" shape, not seed-test-channel-connection.ts's
// throwaway-test-data one.
//
// Idempotent -- re-running with the same TENANT_ID/ENABLED_CHANNELS simply
// re-sets the array to the same value. This REPLACES the tenant's enabled
// list wholesale (not an add/remove diff) -- pass every channel that should
// stay enabled, not just the one being changed.
//
// Run with:
//   TENANT_ID=... ENABLED_CHANNELS=amazon,shopify \
//   npm run platform:set-channel-flags
//
// Required:
//   TENANT_ID         -- the tenants.id to update
//   ENABLED_CHANNELS  -- comma-separated, from: amazon, shopify, walmart,
//                        ebay, temu, tiktok. May be empty ("") to disable
//                        every channel's CONNECT entry point for this
//                        tenant (already-connected channels are unaffected
//                        -- see the CLAUDE.md section referenced above).

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseChannels(raw: string): Channel[] {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return [];
  }
  const values = trimmed.split(",").map((v) => v.trim());
  const invalid = values.filter((v) => !(ALL_CHANNELS as readonly string[]).includes(v));
  if (invalid.length > 0) {
    throw new Error(
      `Unrecognized channel(s) in ENABLED_CHANNELS: ${invalid.join(", ")}. Valid values: ${ALL_CHANNELS.join(", ")}`,
    );
  }
  return values as Channel[];
}

export async function setChannelFlags(
  pool: ReturnType<typeof createAppPool>,
  tenantId: string,
  channels: Channel[],
): Promise<void> {
  await withTenant(pool, tenantId, async (client) => {
    const result = await client.query("UPDATE tenants SET enabled_channels = $2 WHERE id = $1", [tenantId, channels]);
    if (result.rowCount === 0) {
      throw new Error(`No tenant found with id ${tenantId} (or RLS hid it -- check TENANT_ID)`);
    }
    // Same transaction as the UPDATE above, same atomicity reasoning
    // packages/web/src/lib/audit-log.ts's own recordAuditEvent doc comment
    // gives -- inlined here rather than imported from that module, same
    // "scripts never reach into @alltix/web's own src/" boundary this
    // file's own ALL_CHANNELS comment already established. user_id is NULL
    // -- an operator running this script from a shell has no Clerk
    // session to attribute the change to (see migration
    // 0034_audit_log.sql's own doc comment on why that's NULL, not a
    // required column).
    await client.query(
      `INSERT INTO audit_log (tenant_id, user_id, action, entity_type, entity_id, details)
       VALUES ($1, NULL, 'settings.channel_flags_changed', 'tenant', $1, $2)`,
      [tenantId, JSON.stringify({ enabledChannels: channels })],
    );
  });
}

async function main(): Promise<void> {
  const tenantId = readRequiredEnv("TENANT_ID");
  const channels = parseChannels(process.env.ENABLED_CHANNELS ?? "");

  const pool = createAppPool({ connectionString: readRequiredEnv("APP_DATABASE_URL") });
  try {
    await setChannelFlags(pool, tenantId, channels);
    console.log(`tenants.enabled_channels set for ${tenantId}: [${channels.join(", ")}]`);
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((error: unknown) => {
    console.error("set-channel-flags failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
