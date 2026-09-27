// Proves Shopify's own "true multi-store CONNECT" support (mirroring TikTok
// Shop's §4.8.1 pattern) is actually built, not just documented: a tenant
// with TWO active 'shopify' channel_connections rows (two connected stores)
// gets both of them discovered and synced independently by
// syncShopifyOrders() -- before this pass, the discovery query deduplicated
// to one row per TENANT and loadShopifyCredentialsFromChannelConnection()
// always resolved "whichever row is most recently created," so a second
// store was silently never synced at all.
//
// Same "no live credentials, no network call" shape as
// tiktok-multi-shop.test.ts/sync-failure-tracking.test.ts: a 'shopify'
// channel_connections row with no encrypted_access_token fails
// deterministically inside loadShopifyCredentialsFromChannelConnection
// (shopify-connector.ts) -- the row IS found (proving discovery/scoping
// works), but the "no encrypted_access_token" check throws before ever
// reaching the network. Needs only a real local Postgres (npm run
// db:migrate).
//
// Run with: npm run test --workspace=@alltix/scheduler -- shopify-multi-store

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
  syncShopifyOrders,
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
 *  migration 0010's own comment, needed since syncShopifyOrders()'s
 *  discovery query joins `tenants` and requires 'shopify' = ANY
 *  (enabled_channels)) plus TWO 'shopify' channel_connections rows for it,
 *  each with a distinct shop domain and neither with an
 *  encrypted_access_token -- see this file's header comment for why that's
 *  the deterministic, network-free failure trigger every test below relies
 *  on. */
async function seedTenantWithTwoShopifyStores(): Promise<{ tenantId: string; connectionIdA: string; connectionIdB: string }> {
  const tenantId = randomUUID();
  await adminPool.query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, [
    tenantId,
    `shopify-multi-store-test-tenant-${tenantId.slice(0, 8)}`,
  ]);
  const connectionIdA = await withTenant(appPool, tenantId, async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO channel_connections (tenant_id, channel, marketplace, external_account_id)
       VALUES ($1, 'shopify', '', $2) RETURNING id`,
      [tenantId, `store-a-${tenantId.slice(0, 8)}.myshopify.com`],
    );
    return result.rows[0]!.id;
  });
  const connectionIdB = await withTenant(appPool, tenantId, async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO channel_connections (tenant_id, channel, marketplace, external_account_id)
       VALUES ($1, 'shopify', '', $2) RETURNING id`,
      [tenantId, `store-b-${tenantId.slice(0, 8)}.myshopify.com`],
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

test("syncShopifyOrders discovers and syncs BOTH of a tenant's active stores independently, not just the most recently connected one", async () => {
  const { tenantId, connectionIdA, connectionIdB } = await seedTenantWithTwoShopifyStores();
  try {
    const results = await syncShopifyOrders({ appPool, adminPool, eventBus: new InProcessEventBus() });
    const ourResults = results.filter((r) => r.tenantId === tenantId);

    assert.equal(ourResults.length, 2, "both connected stores must produce their own result, not just one for the tenant");

    const connectionIds = ourResults.map((r) => r.connectionId).sort();
    assert.deepEqual(
      connectionIds,
      [connectionIdA, connectionIdB].sort(),
      "the two results must correspond to the two real connection ids, not the same row twice",
    );

    for (const result of ourResults) {
      assert.equal(result.success, false, "each store fails deterministically (no real credentials) -- that's expected here");
      // The row IS found (that's the whole point of this test -- both
      // stores get discovered) but has no encrypted_access_token seeded, so
      // loadShopifyCredentialsFromChannelConnection fails on its own
      // "No active 'shopify' channel_connections row found" guard, which
      // also names the specific connection id it was scoped to.
      assert.match(result.error ?? "", /No active 'shopify' channel_connections row found/);
      assert.match(result.error ?? "", new RegExp(result.connectionId!));
    }
  } finally {
    await cleanup(tenantId);
  }
});

test("one store flipping to status='error' does not affect a different, healthy store for the same tenant", async () => {
  const { tenantId, connectionIdA, connectionIdB } = await seedTenantWithTwoShopifyStores();
  try {
    for (let i = 1; i <= CONSECUTIVE_FAILURE_ERROR_THRESHOLD; i++) {
      await recordSyncFailure(appPool, tenantId, "shopify", `store A failure ${i}`, connectionIdA);
    }
    const storeA = await getConnection(tenantId, connectionIdA);
    assert.equal(storeA.status, "error");
    assert.equal(storeA.consecutive_failures, CONSECUTIVE_FAILURE_ERROR_THRESHOLD);

    const storeB = await getConnection(tenantId, connectionIdB);
    assert.equal(storeB.status, "active", "store B must be completely untouched by store A's own failures");
    assert.equal(storeB.consecutive_failures, 0);

    // Discovery must now skip A (status='error') but still pick up B.
    const results = await syncShopifyOrders({ appPool, adminPool, eventBus: new InProcessEventBus() });
    const ourResults = results.filter((r) => r.tenantId === tenantId);
    assert.equal(ourResults.length, 1, "only the still-active store should be discovered");
    assert.equal(ourResults[0]!.connectionId, connectionIdB);
  } finally {
    await cleanup(tenantId);
  }
});

test("recordSyncSuccess resets only the given connection's consecutive_failures, not a sibling store's", async () => {
  const { tenantId, connectionIdA, connectionIdB } = await seedTenantWithTwoShopifyStores();
  try {
    await recordSyncFailure(appPool, tenantId, "shopify", "store A transient failure", connectionIdA);
    await recordSyncFailure(appPool, tenantId, "shopify", "store B transient failure", connectionIdB);
    assert.equal((await getConnection(tenantId, connectionIdA)).consecutive_failures, 1);
    assert.equal((await getConnection(tenantId, connectionIdB)).consecutive_failures, 1);

    await recordSyncSuccess(appPool, tenantId, "shopify", connectionIdA);

    assert.equal(
      (await getConnection(tenantId, connectionIdA)).consecutive_failures,
      0,
      "store A's own success must reset its own counter",
    );
    assert.equal(
      (await getConnection(tenantId, connectionIdB)).consecutive_failures,
      1,
      "store B's counter must be untouched by store A's success",
    );
  } finally {
    await cleanup(tenantId);
  }
});

test("recordRateLimitTrip cools down only the given connection, not a sibling store", async () => {
  const { tenantId, connectionIdA, connectionIdB } = await seedTenantWithTwoShopifyStores();
  try {
    await recordRateLimitTrip(appPool, tenantId, "shopify", 60_000, connectionIdA);

    const storeA = await getConnection(tenantId, connectionIdA);
    assert.ok(storeA.rate_limited_until, "store A must be cooling down");

    const storeB = await getConnection(tenantId, connectionIdB);
    assert.equal(storeB.rate_limited_until, null, "store B must not be affected by store A's own rate limit trip");
  } finally {
    await cleanup(tenantId);
  }
});

test("omitting connectionId (every other channel's own call shape) still applies to every active row of that channel for the tenant, unchanged", async () => {
  const { tenantId, connectionIdA, connectionIdB } = await seedTenantWithTwoShopifyStores();
  try {
    // No connectionId at all -- the pre-this-pass call shape every other
    // channel's sync path still uses. Must still touch BOTH rows, proving
    // the new parameter is additive (opt-in scoping), not a breaking change
    // to the original "every active row of this channel" behavior.
    await recordSyncFailure(appPool, tenantId, "shopify", "whole-channel failure");

    assert.equal((await getConnection(tenantId, connectionIdA)).consecutive_failures, 1);
    assert.equal((await getConnection(tenantId, connectionIdB)).consecutive_failures, 1);
  } finally {
    await cleanup(tenantId);
  }
});
