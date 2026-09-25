import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createAppPool, withTenant, recordAuditEvent } from "../packages/db/src/index.js";

// Deliberately NOT imported from packages/web/src/lib/carrier-flags.ts --
// same "scripts never reach into @alltix/web's own src/" boundary
// set-channel-flags.ts's own ALL_CHANNELS comment already established (no
// other script in this repo reaches into @alltix/web's own src/, and
// packages/web isn't one of root tsconfig.json's project references), now
// applied to the carrier-layer mirror of that same feature. A third,
// identical list -- same tradeoff migration 0040's own CHECK constraint and
// carrier-flags.ts's own ALL_CARRIERS already accept against the DB and app
// layers respectively. Keep all three in sync by hand if an 8th carrier
// connector is ever added.
const ALL_CARRIERS = ["royal_mail", "evri", "fedex", "parcelforce", "ups", "dhl", "dpd"] as const;
type Carrier = (typeof ALL_CARRIERS)[number];

// Operator-only CLI for toggling CLAUDE.md's "Carrier Feature Flags"
// (migration 0040_tenants_enabled_carriers.sql, packages/web/src/lib/
// carrier-flags.ts) for one tenant -- there is no UI for this, same
// reasoning set-channel-flags.ts's own header comment gives for its own
// channel-layer counterpart (a plain column, not a LaunchDarkly-class
// integration; an operator script is the right amount of tooling at this
// platform's current single-self-testing-tenant stage). Near-literal mirror
// of set-channel-flags.ts, deliberately -- same "the two features stay easy
// to reason about together rather than drifting into two different shapes"
// precedent carrier-flags.ts's own header comment already sets for its
// channel-flags.ts counterpart.
//
// Idempotent -- re-running with the same TENANT_ID/ENABLED_CARRIERS simply
// re-sets the array to the same value. This REPLACES the tenant's enabled
// list wholesale (not an add/remove diff) -- pass every carrier that should
// stay enabled, not just the one being changed.
//
// Run with:
//   TENANT_ID=... ENABLED_CARRIERS=royal_mail,evri \
//   npm run platform:set-carrier-flags
//
// Required:
//   TENANT_ID          -- the tenants.id to update
//   ENABLED_CARRIERS   -- comma-separated, from: royal_mail, evri, fedex,
//                         parcelforce, ups, dhl, dpd. May be empty ("") to
//                         disable every carrier's CONNECT entry point AND
//                         ship-via-carrier for this tenant (an
//                         already-connected carrier's settings card is
//                         unaffected -- see the CLAUDE.md section referenced
//                         above).

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseCarriers(raw: string): Carrier[] {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return [];
  }
  const values = trimmed.split(",").map((v) => v.trim());
  const invalid = values.filter((v) => !(ALL_CARRIERS as readonly string[]).includes(v));
  if (invalid.length > 0) {
    throw new Error(
      `Unrecognized carrier(s) in ENABLED_CARRIERS: ${invalid.join(", ")}. Valid values: ${ALL_CARRIERS.join(", ")}`,
    );
  }
  return values as Carrier[];
}

export async function setCarrierFlags(
  pool: ReturnType<typeof createAppPool>,
  tenantId: string,
  carriers: Carrier[],
): Promise<void> {
  await withTenant(pool, tenantId, async (client) => {
    const result = await client.query("UPDATE tenants SET enabled_carriers = $2 WHERE id = $1", [tenantId, carriers]);
    if (result.rowCount === 0) {
      throw new Error(`No tenant found with id ${tenantId} (or RLS hid it -- check TENANT_ID)`);
    }
    // Same transaction as the UPDATE above, same atomicity reasoning
    // @alltix/db's recordAuditEvent doc comment gives, and the same
    // NULL-user_id-means-operator-script convention
    // set-channel-flags.ts's own call already establishes.
    await recordAuditEvent(client, {
      tenantId,
      userId: null,
      action: "settings.carrier_flags_changed",
      entityType: "tenant",
      entityId: tenantId,
      details: { enabledCarriers: carriers },
    });
  });
}

async function main(): Promise<void> {
  const tenantId = readRequiredEnv("TENANT_ID");
  const carriers = parseCarriers(process.env.ENABLED_CARRIERS ?? "");

  const pool = createAppPool({ connectionString: readRequiredEnv("APP_DATABASE_URL") });
  try {
    await setCarrierFlags(pool, tenantId, carriers);
    console.log(`tenants.enabled_carriers set for ${tenantId}: [${carriers.join(", ")}]`);
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((error: unknown) => {
    console.error("set-carrier-flags failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
