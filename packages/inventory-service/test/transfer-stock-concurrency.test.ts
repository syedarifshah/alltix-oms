// Proves the same failure mode CLAUDE.md §7's fuzz-testing row calls out
// for allocation (packages/order-service/test/allocation-concurrency.test.ts)
// applies just as much to transferStock(): N simultaneous transfer attempts
// against 1 unit of available stock at the source must leave exactly one
// transfer applied and the rest rejected -- never two transfers both
// succeeding against stock that only exists once (a "double-spend" of the
// same unit out of one location). Requires a live Postgres (npm run
// db:migrate).
//
// Run with: npm run test --workspace=@alltix/inventory-service -- transfer-stock-concurrency

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { Client, type Pool } from "pg";
import { createAppPool, withTenant } from "@alltix/db";
import { InventoryService } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
loadEnv({ path: join(REPO_ROOT, ".env") });

const ATTEMPT_COUNT = 10;

let pool: Pool;
const tenantId = randomUUID();

before(async () => {
  const connectionString = process.env.APP_DATABASE_URL;
  if (!connectionString) {
    throw new Error("APP_DATABASE_URL is not set (see .env.example)");
  }
  // Headroom above pg's default max=10, same reasoning as
  // allocation-concurrency.test.ts: every attempt needs its own connection
  // to genuinely race rather than queueing behind the pool.
  pool = createAppPool({ connectionString, max: ATTEMPT_COUNT + 5 });
});

after(async () => {
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query("DELETE FROM inventory_events WHERE tenant_id = $1", [tenantId]);
  await admin.query("DELETE FROM inventory_levels WHERE tenant_id = $1", [tenantId]);
  await admin.end();

  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM products WHERE tenant_id = $1", [tenantId]));
  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM locations WHERE tenant_id = $1", [tenantId]));
  await pool.end();
});

test(`exactly 1 of ${ATTEMPT_COUNT} concurrent transferStock attempts against 1 available unit succeeds`, async () => {
  const { productId, sourceLocationId, destinationLocationId } = await withTenant(pool, tenantId, async (client) => {
    const locations = await client.query<{ id: string }>(
      `INSERT INTO locations (tenant_id, name, type)
       VALUES ($1, 'Transfer Concurrency Test Warehouse A', 'warehouse'),
              ($1, 'Transfer Concurrency Test Warehouse B', 'warehouse')
       RETURNING id`,
      [tenantId],
    );
    const product = await client.query<{ id: string }>(
      `INSERT INTO products (tenant_id, internal_sku, name)
       VALUES ($1, 'TRANSFER-CONCURRENCY-TEST-SKU', 'Transfer Concurrency Test Product') RETURNING id`,
      [tenantId],
    );
    // Exactly 1 unit available at the source -- same "one contested unit"
    // scenario allocation-concurrency.test.ts uses.
    await client.query(
      `INSERT INTO inventory_levels (tenant_id, product_id, location_id, on_hand, reserved) VALUES ($1, $2, $3, 1, 0)`,
      [tenantId, product.rows[0]!.id, locations.rows[0]!.id],
    );
    return {
      productId: product.rows[0]!.id,
      sourceLocationId: locations.rows[0]!.id,
      destinationLocationId: locations.rows[1]!.id,
    };
  });

  const inventoryService = new InventoryService(pool);

  const results = await Promise.allSettled(
    Array.from({ length: ATTEMPT_COUNT }, (_, i) =>
      inventoryService.transferStock({
        tenantId,
        productId,
        fromLocationId: sourceLocationId,
        toLocationId: destinationLocationId,
        quantity: 1,
        // Distinct idempotency keys -- this proves the FOR UPDATE lock
        // itself prevents the oversell, not idempotency collapsing
        // otherwise-identical concurrent calls into one.
        idempotencyKey: `xfer-concurrency:${productId}:${i}`,
      }),
    ),
  );

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one transfer attempt must succeed");
  assert.equal(rejected.length, ATTEMPT_COUNT - 1, "every other attempt must be rejected");
  for (const failure of rejected as PromiseRejectedResult[]) {
    assert.match(String(failure.reason), /insufficient available stock/);
  }

  const sourceLevels = await withTenant(pool, tenantId, (client) =>
    client.query<{ on_hand: number; reserved: number; available: number }>(
      `SELECT on_hand, reserved, available FROM inventory_levels WHERE product_id = $1 AND location_id = $2`,
      [productId, sourceLocationId],
    ),
  );
  assert.deepEqual(
    sourceLevels.rows[0],
    { on_hand: 0, reserved: 0, available: 0 },
    "the source's single unit must be moved exactly once, never oversold to a negative on_hand",
  );

  const destinationLevels = await withTenant(pool, tenantId, (client) =>
    client.query<{ on_hand: number; reserved: number; available: number }>(
      `SELECT on_hand, reserved, available FROM inventory_levels WHERE product_id = $1 AND location_id = $2`,
      [productId, destinationLocationId],
    ),
  );
  assert.deepEqual(destinationLevels.rows[0], { on_hand: 1, reserved: 0, available: 1 });

  const events = await withTenant(pool, tenantId, (client) =>
    client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_events WHERE tenant_id = $1 AND event_type = 'transfer'`,
      [tenantId],
    ),
  );
  assert.equal(events.rows[0]?.count, "2", "exactly one transfer's worth of events (one leg each) must exist, not one per attempt");
});
