// Proves persistPulledOrders() dedupes on the (tenant_id, channel,
// external_order_id) UNIQUE constraint (CLAUDE.md §2.3): calling
// AmazonConnector.pullOrders() and persisting the result twice against the
// same seeded tenant must not create duplicate `orders` rows or error on
// the second run. Requires a live Postgres (npm run db:migrate) and real
// Amazon sandbox credentials in .env, same as
// scripts/amazon-pull-orders-smoke-test.ts.
//
// Run with: npm run test --workspace=@alltix/order-service

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import type { Pool } from "pg";
import { createAppPool, withTenant } from "@alltix/db";
import {
  createAmazonConnectorFromChannelConnection,
  SP_API_SANDBOX_TEST_CASE_CREATED_AFTER,
} from "@alltix/channel-connectors";
import { OrderService } from "../src/index.js";
import { seedTestChannelConnection } from "../../../scripts/seed-test-channel-connection.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

loadEnv({ path: join(REPO_ROOT, ".env") });

let pool: Pool;
let tenantId: string;

before(async () => {
  const connectionString = process.env.APP_DATABASE_URL;
  if (!connectionString) {
    throw new Error("APP_DATABASE_URL is not set (see .env.example)");
  }
  pool = createAppPool({ connectionString });

  const seeded = await seedTestChannelConnection(pool);
  tenantId = seeded.tenantId;
});

after(async () => {
  await withTenant(pool, tenantId, (client) =>
    client.query("DELETE FROM channel_connections WHERE tenant_id = $1", [tenantId]),
  );
  // orders has no DELETE grant for app_user by design (see migrations/0007
  // -- orders are transitioned/cancelled, never hard-deleted by the app), so
  // clean those up via the schema-owning connection, same as
  // packages/web/test/tenant-isolation.e2e.test.ts does for users/tenants.
  const { Client } = await import("pg");
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query("DELETE FROM orders WHERE tenant_id = $1", [tenantId]);
  await admin.end();
  await pool.end();
});

test("persisting the same pullOrders() result twice is idempotent", async () => {
  const connector = await createAmazonConnectorFromChannelConnection(pool, tenantId);
  const orderService = new OrderService(pool);

  const firstPull = await connector.pullOrders(SP_API_SANDBOX_TEST_CASE_CREATED_AFTER);
  assert.ok(firstPull.length > 0, "sandbox should return at least one canned order");

  const firstResult = await orderService.persistPulledOrders(tenantId, firstPull);
  assert.equal(firstResult.insertedOrderIds.length, firstPull.length);
  assert.equal(firstResult.skippedExternalOrderIds.length, 0);

  const countAfterFirst = await withTenant(pool, tenantId, (client) =>
    client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM orders WHERE tenant_id = $1",
      [tenantId],
    ),
  );
  assert.equal(Number(countAfterFirst.rows[0]!.count), firstPull.length);

  // Re-running pullOrders() (same sandbox trigger -> same canned orders) and
  // persisting again must be a no-op, not a duplicate-insert error.
  const secondPull = await connector.pullOrders(SP_API_SANDBOX_TEST_CASE_CREATED_AFTER);
  const secondResult = await orderService.persistPulledOrders(tenantId, secondPull);

  assert.equal(secondResult.insertedOrderIds.length, 0, "second run must not insert any new rows");
  assert.equal(
    secondResult.skippedExternalOrderIds.length,
    secondPull.length,
    "second run must dedupe every order it pulled",
  );

  const countAfterSecond = await withTenant(pool, tenantId, (client) =>
    client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM orders WHERE tenant_id = $1",
      [tenantId],
    ),
  );
  assert.equal(
    Number(countAfterSecond.rows[0]!.count),
    firstPull.length,
    "row count must not grow on the second run",
  );
});
