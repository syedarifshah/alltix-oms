// Regression coverage for CLAUDE.md §4.5's "Update" on the real Shopify
// demo-order incident (a Shopify line item with no SKU that can never
// resolve to a channel_listings row): before this fix, persistPulledOrders()
// throwing on that permanently-bad order made every syncXTenant()/
// syncXConnection() catch block call recordSyncFailure() exactly like a real
// connection outage would, so one bad order could eventually flip an
// otherwise perfectly healthy connection to status='error' after
// CONSECUTIVE_FAILURE_ERROR_THRESHOLD runs. recordPartialOrderPersistFailure()
// (called whenever the caught error is a PartialOrderPersistFailureError,
// not a generic one -- see that class's own doc comment in
// @alltix/order-service) is the fix: it calls recordSyncSuccess() instead,
// since every other order in the batch already proved the connection itself
// is healthy.
//
// Exercises recordPartialOrderPersistFailure() directly against a real
// Postgres channel_connections row -- same "deterministic, network-free"
// discipline sync-failure-tracking.test.ts already establishes for
// recordSyncFailure()/recordSyncSuccess(), rather than trying to drive a
// full syncShopifyConnection() run through a real partial-batch failure
// (which would need live Shopify credentials this environment doesn't have).
//
// Run with: npm run test --workspace=@alltix/scheduler -- partial-order-persist-failure

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import type { Pool } from "pg";
import { createAppPool, withTenant } from "@alltix/db";
import { PartialOrderPersistFailureError } from "@alltix/order-service";
import { recordSyncFailure, recordPartialOrderPersistFailure, CONSECUTIVE_FAILURE_ERROR_THRESHOLD } from "../src/index.js";

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
  status: string;
  consecutive_failures: number;
}

// Same minimal "no encrypted_access_token" shape sync-failure-tracking.test.ts
// uses -- irrelevant to this file's own tests (nothing here ever calls a
// connector), just a real channel_connections row to point recordSyncFailure()/
// recordPartialOrderPersistFailure() at.
async function seedShopifyConnection(): Promise<string> {
  const tenantId = randomUUID();
  await adminPool.query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, [
    tenantId,
    `partial-failure-test-tenant-${tenantId.slice(0, 8)}`,
  ]);
  await withTenant(appPool, tenantId, (client) =>
    client.query(
      `INSERT INTO channel_connections (tenant_id, channel, marketplace, external_account_id)
       VALUES ($1, 'shopify', '', $2)`,
      [tenantId, `partial-failure-test-${tenantId.slice(0, 8)}.myshopify.com`],
    ),
  );
  return tenantId;
}

async function getConnection(tenantId: string): Promise<ConnectionRow> {
  const result = await withTenant(appPool, tenantId, (client) =>
    client.query<ConnectionRow>(
      `SELECT status, consecutive_failures FROM channel_connections WHERE tenant_id = $1 AND channel = 'shopify'`,
      [tenantId],
    ),
  );
  const row = result.rows[0];
  assert.ok(row, `expected a channel_connections row for tenant ${tenantId}`);
  return row;
}

async function cleanup(tenantId: string): Promise<void> {
  await withTenant(appPool, tenantId, (client) => client.query("DELETE FROM channel_connections WHERE tenant_id = $1", [tenantId]));
  await adminPool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

test("recordPartialOrderPersistFailure resets consecutive_failures via recordSyncSuccess, not recordSyncFailure -- even one run below the error threshold", async () => {
  const tenantId = await seedShopifyConnection();
  try {
    // Walk the connection right up to the edge: one more recordSyncFailure()
    // would flip it to 'error'. This is the exact real-world shape the bug
    // fixed here: a permanently-bad order re-failing on every run,
    // eventually being the run that tips a connection into 'error'.
    for (let i = 0; i < CONSECUTIVE_FAILURE_ERROR_THRESHOLD - 1; i++) {
      await recordSyncFailure(appPool, tenantId, "shopify", `unrelated real failure ${i + 1}`);
    }
    const beforePartialFailure = await getConnection(tenantId);
    assert.equal(beforePartialFailure.consecutive_failures, CONSECUTIVE_FAILURE_ERROR_THRESHOLD - 1);
    assert.equal(beforePartialFailure.status, "active");

    const err = new PartialOrderPersistFailureError(
      "1 of 2 order(s) in this batch failed to persist: BAD-ORDER-1 (no channel_listings match)",
      [{ externalOrderId: "BAD-ORDER-1", error: "no channel_listings match" }],
      ["good-order-uuid-1"],
      [],
    );
    const result = await recordPartialOrderPersistFailure(appPool, tenantId, "shopify", err);

    const afterPartialFailure = await getConnection(tenantId);
    assert.equal(
      afterPartialFailure.consecutive_failures,
      0,
      "a partial-batch failure must reset the counter, not push it over the threshold into 'error'",
    );
    assert.equal(afterPartialFailure.status, "active", "must never flip to 'error' over a data-quality-only failure");
    assert.equal(result.success, true, "reported as a success -- the connection itself is proven healthy");
  } finally {
    await cleanup(tenantId);
  }
});

test("recordPartialOrderPersistFailure's returned TenantSyncResult carries the error's own partial counts, not empty arrays", async () => {
  const tenantId = await seedShopifyConnection();
  try {
    const err = new PartialOrderPersistFailureError(
      "1 of 3 order(s) in this batch failed to persist: BAD-ORDER-2 (no channel_listings match)",
      [{ externalOrderId: "BAD-ORDER-2", error: "no channel_listings match" }],
      ["good-order-uuid-a", "good-order-uuid-b"],
      ["skipped-external-order-id"],
    );
    const connectionId = randomUUID();
    const result = await recordPartialOrderPersistFailure(appPool, tenantId, "shopify", err, connectionId);

    assert.deepEqual(result, {
      tenantId,
      connectionId,
      success: true,
      insertedOrderIds: ["good-order-uuid-a", "good-order-uuid-b"],
      skippedExternalOrderIds: ["skipped-external-order-id"],
      error: err.message,
    });
  } finally {
    await cleanup(tenantId);
  }
});
