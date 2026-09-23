// Proves CLAUDE.md §12's "TikTok Shop OAuth: no true multi-shop CONNECT" gap
// is actually closed, not just documented as closed: a tenant with TWO
// active 'tiktok' channel_connections rows (two connected shops) gets both
// of them discovered and synced independently by syncTikTokOrders() --
// before this pass, the discovery query deduplicated to one row per
// TENANT and loadTikTokCredentialsFromChannelConnection() always resolved
// "whichever row is most recently created," so a second shop was silently
// never synced at all.
//
// Same "no live credentials, no network call" shape as
// sync-failure-tracking.test.ts/rate-limit-cooldown.test.ts: a 'tiktok'
// channel_connections row with no encrypted_access_token/refresh_token
// fails deterministically inside loadTikTokCredentialsFromChannelConnection
// (tiktok-connector.ts) -- the row IS found (proving discovery/scoping
// works), but its own "is missing an access or refresh token" check throws
// before ever reaching the network -- exactly the same guaranteed,
// deterministic failure those two files already rely on, just for TikTok
// instead of Shopify. Needs only a real local Postgres (npm run db:migrate).
//
// Run with: npm run test --workspace=@alltix/scheduler -- tiktok-multi-shop

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import type { Pool } from "pg";
import { createAppPool, withTenant } from "@alltix/db";
import { InProcessEventBus } from "@alltix/shared";
import {
  syncTikTokOrders,
  recordSyncFailure,
  recordSyncSuccess,
  recordRateLimitTrip,
  CONSECUTIVE_FAILURE_ERROR_THRESHOLD,
} from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
loadEnv({ path: join(REPO_ROOT, ".env") });

let appPool: Pool;
let adminPool: Pool;

before(() => {
  const appConnectionString = process.env.APP_DATABASE_URL;
  const adminConnectionString = process.env.DATABASE_URL;
  if (!appConnectionString) throw new Error("APP_DATABASE_URL is not set (see .env.example)");
  if (!adminConnectionString) throw new Error("DATABASE_URL is not set (see .env.example)");
  appPool = createAppPool({ connectionString: appConnectionString });
  adminPool = createAppPool({ connectionString: adminConnectionString });
});

after(async () => {
  await appPool.end();
  await adminPool.end();
});

interface ConnectionRow {
  id: string;
  status: string;
  consecutive_failures: number;
  rate_limited_until: string | null;
}

/** Seeds a real `tenants` row (adminPool -- app_user has no INSERT grant,
 *  migration 0010's own comment, needed since syncTikTokOrders()'s
 *  discovery query joins `tenants` and requires 'tiktok' = ANY
 *  (enabled_channels)) plus TWO 'tiktok' channel_connections rows for it,
 *  each with a distinct shop_cipher and neither with an
 *  encrypted_access_token/refresh_token -- see this file's header comment
 *  for why that's the deterministic, network-free failure trigger every
 *  test below relies on. */
async function seedTenantWithTwoTikTokShops(): Promise<{ tenantId: string; connectionIdA: string; connectionIdB: string }> {
  const tenantId = randomUUID();
  await adminPool.query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, [
    tenantId,
    `tiktok-multi-shop-test-tenant-${tenantId.slice(0, 8)}`,
  ]);
  const connectionIdA = await withTenant(appPool, tenantId, async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO channel_connections (tenant_id, channel, marketplace, external_account_id)
       VALUES ($1, 'tiktok', '', $2) RETURNING id`,
      [tenantId, `shop-a-${tenantId.slice(0, 8)}`],
    );
    return result.rows[0]!.id;
  });
  const connectionIdB = await withTenant(appPool, tenantId, async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO channel_connections (tenant_id, channel, marketplace, external_account_id)
       VALUES ($1, 'tiktok', '', $2) RETURNING id`,
      [tenantId, `shop-b-${tenantId.slice(0, 8)}`],
    );
    return result.rows[0]!.id;
  });
  return { tenantId, connectionIdA, connectionIdB };
}

async function getConnection(tenantId: string, connectionId: string): Promise<ConnectionRow> {
  const result = await withTenant(appPool, tenantId, (client) =>
    client.query<ConnectionRow>(
      `SELECT id, status, consecutive_failures, rate_limited_until
         FROM channel_connections WHERE tenant_id = $1 AND id = $2`,
      [tenantId, connectionId],
    ),
  );
  const row = result.rows[0];
  assert.ok(row, `expected a channel_connections row for tenant ${tenantId}, connection ${connectionId}`);
  return row;
}

async function cleanup(tenantId: string): Promise<void> {
  await withTenant(appPool, tenantId, (client) =>
    client.query("DELETE FROM channel_connections WHERE tenant_id = $1", [tenantId]),
  );
  await adminPool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

test("syncTikTokOrders discovers and syncs BOTH of a tenant's active shops independently, not just the most recently connected one", async () => {
  const { tenantId, connectionIdA, connectionIdB } = await seedTenantWithTwoTikTokShops();
  try {
    const results = await syncTikTokOrders({ appPool, adminPool, eventBus: new InProcessEventBus() });
    const ourResults = results.filter((r) => r.tenantId === tenantId);

    assert.equal(ourResults.length, 2, "both connected shops must produce their own result, not just one for the tenant");

    const connectionIds = ourResults.map((r) => r.connectionId).sort();
    assert.deepEqual(
      connectionIds,
      [connectionIdA, connectionIdB].sort(),
      "the two results must correspond to the two real connection ids, not the same row twice",
    );

    for (const result of ourResults) {
      assert.equal(result.success, false, "each shop fails deterministically (no real credentials) -- that's expected here");
      // The row IS found (that's the whole point of this test -- both shops get
      // discovered) but has no encrypted_access_token/refresh_token seeded, so
      // loadTikTokCredentialsFromChannelConnection fails one step later than a
      // missing/inactive row would -- see its own "is missing an access or
      // refresh token" throw, not the earlier "No active ... row found" one.
      assert.match(result.error ?? "", /is missing an access or refresh token/);
    }
  } finally {
    await cleanup(tenantId);
  }
});

test("one shop flipping to status='error' does not affect a different, healthy shop for the same tenant", async () => {
  const { tenantId, connectionIdA, connectionIdB } = await seedTenantWithTwoTikTokShops();
  try {
    for (let i = 1; i <= CONSECUTIVE_FAILURE_ERROR_THRESHOLD; i++) {
      await recordSyncFailure(appPool, tenantId, "tiktok", `shop A failure ${i}`, connectionIdA);
    }
    const shopA = await getConnection(tenantId, connectionIdA);
    assert.equal(shopA.status, "error");
    assert.equal(shopA.consecutive_failures, CONSECUTIVE_FAILURE_ERROR_THRESHOLD);

    const shopB = await getConnection(tenantId, connectionIdB);
    assert.equal(shopB.status, "active", "shop B must be completely untouched by shop A's own failures");
    assert.equal(shopB.consecutive_failures, 0);

    // Discovery must now skip A (status='error') but still pick up B.
    const results = await syncTikTokOrders({ appPool, adminPool, eventBus: new InProcessEventBus() });
    const ourResults = results.filter((r) => r.tenantId === tenantId);
    assert.equal(ourResults.length, 1, "only the still-active shop should be discovered");
    assert.equal(ourResults[0]!.connectionId, connectionIdB);
  } finally {
    await cleanup(tenantId);
  }
});

test("recordSyncSuccess resets only the given connection's consecutive_failures, not a sibling shop's", async () => {
  const { tenantId, connectionIdA, connectionIdB } = await seedTenantWithTwoTikTokShops();
  try {
    await recordSyncFailure(appPool, tenantId, "tiktok", "shop A transient failure", connectionIdA);
    await recordSyncFailure(appPool, tenantId, "tiktok", "shop B transient failure", connectionIdB);
    assert.equal((await getConnection(tenantId, connectionIdA)).consecutive_failures, 1);
    assert.equal((await getConnection(tenantId, connectionIdB)).consecutive_failures, 1);

    await recordSyncSuccess(appPool, tenantId, "tiktok", connectionIdA);

    assert.equal(
      (await getConnection(tenantId, connectionIdA)).consecutive_failures,
      0,
      "shop A's own success must reset its own counter",
    );
    assert.equal(
      (await getConnection(tenantId, connectionIdB)).consecutive_failures,
      1,
      "shop B's counter must be untouched by shop A's success",
    );
  } finally {
    await cleanup(tenantId);
  }
});

test("recordRateLimitTrip cools down only the given connection, not a sibling shop", async () => {
  const { tenantId, connectionIdA, connectionIdB } = await seedTenantWithTwoTikTokShops();
  try {
    await recordRateLimitTrip(appPool, tenantId, "tiktok", 60_000, connectionIdA);

    const shopA = await getConnection(tenantId, connectionIdA);
    assert.ok(shopA.rate_limited_until, "shop A must be cooling down");

    const shopB = await getConnection(tenantId, connectionIdB);
    assert.equal(shopB.rate_limited_until, null, "shop B must not be affected by shop A's own rate limit trip");
  } finally {
    await cleanup(tenantId);
  }
});

test("omitting connectionId (every other channel's own call shape) still applies to every active row of that channel for the tenant, unchanged", async () => {
  const { tenantId, connectionIdA, connectionIdB } = await seedTenantWithTwoTikTokShops();
  try {
    // No connectionId at all -- the pre-this-pass call shape every other
    // channel's sync path still uses. Must still touch BOTH rows, proving
    // the new parameter is additive (opt-in scoping), not a breaking change
    // to the original "every active row of this channel" behavior.
    await recordSyncFailure(appPool, tenantId, "tiktok", "whole-channel failure");

    assert.equal((await getConnection(tenantId, connectionIdA)).consecutive_failures, 1);
    assert.equal((await getConnection(tenantId, connectionIdB)).consecutive_failures, 1);
  } finally {
    await cleanup(tenantId);
  }
});
