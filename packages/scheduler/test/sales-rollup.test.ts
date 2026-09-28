// Proves migration 0045's daily rollup tables/rollupDailySales() -- CLAUDE.md
// §8's pragmatic v1 of the deferred CDC-fed reporting store -- against real
// seeded Postgres: correct per-channel/per-product aggregation, cancelled
// orders excluded, the DELETE-then-INSERT recompute actually removing a
// group once its only order is cancelled (not just leaving a stale upsert
// behind), cross-tenant isolation, and the trailing-window default only
// ever touching recent days -- the exact reason
// scripts/backfill-sales-rollups.ts exists at all.
//
// Orders/order_lines are inserted directly (not via OrderService) --
// rollupDailySales() only ever reads already-committed orders/order_lines
// rows, so a hand-built row with an explicit placed_at/status is a stronger,
// more direct proof of its own SQL than routing through the full order
// lifecycle would be.
//
// Run with: npm run test --workspace=@alltix/scheduler -- sales-rollup

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import type { Pool } from "pg";
import { createAppPool, withTenant } from "@alltix/db";
import { rollupDailySales } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
loadEnv({ path: join(REPO_ROOT, ".env") });

let pool: Pool;
let adminPool: Pool;

before(() => {
  const appConnectionString = process.env.APP_DATABASE_URL;
  const adminConnectionString = process.env.DATABASE_URL;
  if (!appConnectionString) throw new Error("APP_DATABASE_URL is not set (see .env.example)");
  if (!adminConnectionString) throw new Error("DATABASE_URL is not set (see .env.example)");
  pool = createAppPool({ connectionString: appConnectionString });
  adminPool = createAppPool({ connectionString: adminConnectionString });
});

after(async () => {
  await pool.end();
  await adminPool.end();
});

interface ChannelRollupRow {
  channel: string;
  order_count: number;
  units_sold: number;
  revenue: string;
}

interface ProductRollupRow {
  units_sold: number;
  revenue: string;
}

async function seedTenant(): Promise<string> {
  const tenantId = randomUUID();
  await adminPool.query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, [
    tenantId,
    `sales-rollup-test-tenant-${tenantId.slice(0, 8)}`,
  ]);
  return tenantId;
}

async function seedProduct(tenantId: string, sku: string): Promise<string> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO products (tenant_id, internal_sku, name) VALUES ($1, $2, 'Sales Rollup Test Product') RETURNING id`,
      [tenantId, sku],
    );
    return result.rows[0]!.id;
  });
}

/** Inserts one order plus a single order_line directly -- rollupDailySales()
 *  only ever reads already-committed rows, never the order lifecycle
 *  machinery that produced them. */
async function seedOrder(
  tenantId: string,
  productId: string,
  options: { channel: string; status?: string; placedAt: Date; quantity: number; unitPrice: string },
): Promise<string> {
  return withTenant(pool, tenantId, async (client) => {
    const order = await client.query<{ id: string }>(
      `INSERT INTO orders (tenant_id, channel, external_order_id, status, placed_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [tenantId, options.channel, `ROLLUP-TEST-${randomUUID()}`, options.status ?? "received", options.placedAt.toISOString()],
    );
    const orderId = order.rows[0]!.id;
    await client.query(
      `INSERT INTO order_lines (tenant_id, order_id, product_id, quantity, unit_price, fulfillment_type)
       VALUES ($1, $2, $3, $4, $5, 'seller_fulfilled')`,
      [tenantId, orderId, productId, options.quantity, options.unitPrice],
    );
    return orderId;
  });
}

async function setOrderStatus(tenantId: string, orderId: string, status: string): Promise<void> {
  await withTenant(pool, tenantId, (client) =>
    client.query(`UPDATE orders SET status = $1 WHERE id = $2 AND tenant_id = $3`, [status, orderId, tenantId]),
  );
}

async function getChannelRollup(tenantId: string, channel: string): Promise<ChannelRollupRow | undefined> {
  const result = await withTenant(pool, tenantId, (client) =>
    client.query<ChannelRollupRow>(
      `SELECT channel, order_count, units_sold, revenue::text
         FROM daily_channel_sales_rollups
        WHERE tenant_id = $1 AND channel = $2`,
      [tenantId, channel],
    ),
  );
  return result.rows[0];
}

async function getProductRollup(tenantId: string, productId: string): Promise<ProductRollupRow | undefined> {
  const result = await withTenant(pool, tenantId, (client) =>
    client.query<ProductRollupRow>(
      `SELECT units_sold, revenue::text FROM daily_product_sales_rollups WHERE tenant_id = $1 AND product_id = $2`,
      [tenantId, productId],
    ),
  );
  return result.rows[0];
}

async function cleanup(tenantId: string): Promise<void> {
  await adminPool.query("DELETE FROM daily_channel_sales_rollups WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM daily_product_sales_rollups WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM orders WHERE tenant_id = $1", [tenantId]); // cascades order_lines
  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM products WHERE tenant_id = $1", [tenantId]));
  await adminPool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

test("rollupDailySales aggregates order_count/units_sold/revenue per channel and per product, excluding cancelled orders", async () => {
  const tenantId = await seedTenant();
  try {
    const productA = await seedProduct(tenantId, `SKU-A-${randomUUID().slice(0, 8)}`);
    const now = new Date();

    await seedOrder(tenantId, productA, { channel: "amazon", placedAt: now, quantity: 2, unitPrice: "10.00" });
    await seedOrder(tenantId, productA, { channel: "amazon", placedAt: now, quantity: 3, unitPrice: "10.00" });
    // A cancelled order on the same day/channel/product -- must not be
    // counted anywhere, same "gross revenue for non-cancelled orders"
    // definition the live query it replaced already used.
    await seedOrder(tenantId, productA, { channel: "amazon", status: "cancelled", placedAt: now, quantity: 99, unitPrice: "10.00" });

    await rollupDailySales(adminPool);

    const channelRow = await getChannelRollup(tenantId, "amazon");
    assert.ok(channelRow, "expected a daily_channel_sales_rollups row for amazon");
    assert.equal(channelRow!.order_count, 2, "only the two non-cancelled orders count");
    assert.equal(channelRow!.units_sold, 5, "2 + 3 units across the two non-cancelled orders");
    assert.equal(channelRow!.revenue, "50.00", "5 units x $10.00, the cancelled order's 99 units excluded entirely");

    const productRow = await getProductRollup(tenantId, productA);
    assert.ok(productRow, "expected a daily_product_sales_rollups row for the product");
    assert.equal(productRow!.units_sold, 5);
    assert.equal(productRow!.revenue, "50.00");
  } finally {
    await cleanup(tenantId);
  }
});

test("DELETE-then-INSERT recompute removes a rollup group entirely once its only order is cancelled -- an upsert alone could not do this", async () => {
  const tenantId = await seedTenant();
  try {
    const product = await seedProduct(tenantId, `SKU-CANCEL-${randomUUID().slice(0, 8)}`);
    const now = new Date();
    const orderId = await seedOrder(tenantId, product, { channel: "shopify", placedAt: now, quantity: 4, unitPrice: "25.00" });

    await rollupDailySales(adminPool);
    const before = await getChannelRollup(tenantId, "shopify");
    assert.ok(before, "sanity check: the not-yet-cancelled order produced a rollup row");
    assert.equal(before!.revenue, "100.00");

    await setOrderStatus(tenantId, orderId, "cancelled");
    await rollupDailySales(adminPool);

    const after = await getChannelRollup(tenantId, "shopify");
    assert.equal(after, undefined, "a group whose only order is now cancelled must be gone entirely, not left at a stale non-zero value");

    const productAfter = await getProductRollup(tenantId, product);
    assert.equal(productAfter, undefined, "the product-level rollup must be recomputed away too, not just the channel-level one");
  } finally {
    await cleanup(tenantId);
  }
});

test("two tenants' same-day rollups stay isolated -- one tenant's revenue never bleeds into another's row", async () => {
  const tenantA = await seedTenant();
  const tenantB = await seedTenant();
  try {
    const productA = await seedProduct(tenantA, `SKU-ISO-A-${randomUUID().slice(0, 8)}`);
    const productB = await seedProduct(tenantB, `SKU-ISO-B-${randomUUID().slice(0, 8)}`);
    const now = new Date();

    await seedOrder(tenantA, productA, { channel: "walmart", placedAt: now, quantity: 1, unitPrice: "15.00" });
    await seedOrder(tenantB, productB, { channel: "walmart", placedAt: now, quantity: 1, unitPrice: "999.00" });

    // One admin-level call recomputes every tenant at once -- this is the
    // real cross-tenant shape the cron route itself uses, not a per-tenant
    // loop this test is artificially avoiding.
    await rollupDailySales(adminPool);

    const rowA = await getChannelRollup(tenantA, "walmart");
    const rowB = await getChannelRollup(tenantB, "walmart");
    assert.ok(rowA && rowB, "both tenants must get their own row");
    assert.equal(rowA!.revenue, "15.00", "tenant A's row must reflect only tenant A's own order");
    assert.equal(rowB!.revenue, "999.00", "tenant B's row must reflect only tenant B's own order, not tenant A's");
  } finally {
    await cleanup(tenantA);
    await cleanup(tenantB);
  }
});

test("the default trailing window leaves an old order's rollup untouched; an explicit sinceDate (the backfill script's own reason to exist) picks it up", async () => {
  const tenantId = await seedTenant();
  try {
    const product = await seedProduct(tenantId, `SKU-OLD-${randomUUID().slice(0, 8)}`);
    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000); // well outside the default trailing window
    await seedOrder(tenantId, product, { channel: "ebay", placedAt: oldDate, quantity: 1, unitPrice: "7.50" });

    // Default options -- only the trailing SALES_ROLLUP_RECOMPUTE_DAYS days,
    // exactly what the daily cron route itself calls with.
    await rollupDailySales(adminPool);
    const notYetRolled = await getChannelRollup(tenantId, "ebay");
    assert.equal(notYetRolled, undefined, "an order 40 days old must not be picked up by the default trailing-window recompute");

    // An explicit wide range -- exactly what scripts/backfill-sales-rollups.ts
    // passes for a one-time historical backfill.
    const sinceDate = new Date(Date.UTC(oldDate.getUTCFullYear(), oldDate.getUTCMonth(), oldDate.getUTCDate()));
    const throughDate = new Date(sinceDate.getTime() + 24 * 60 * 60 * 1000);
    await rollupDailySales(adminPool, { sinceDate, throughDate });

    const rolled = await getChannelRollup(tenantId, "ebay");
    assert.ok(rolled, "an explicit sinceDate covering the old order's own date must pick it up");
    assert.equal(rolled!.revenue, "7.50");
  } finally {
    await cleanup(tenantId);
  }
});

test("re-running rollupDailySales over an unchanged range is idempotent -- no duplicate rows, same totals", async () => {
  const tenantId = await seedTenant();
  try {
    const product = await seedProduct(tenantId, `SKU-IDEMPOTENT-${randomUUID().slice(0, 8)}`);
    const now = new Date();
    await seedOrder(tenantId, product, { channel: "temu", placedAt: now, quantity: 6, unitPrice: "3.00" });

    await rollupDailySales(adminPool);
    await rollupDailySales(adminPool);
    await rollupDailySales(adminPool);

    const result = await withTenant(pool, tenantId, (client) =>
      client.query<{ row_count: string }>(
        `SELECT count(*)::text AS row_count FROM daily_channel_sales_rollups WHERE tenant_id = $1 AND channel = 'temu'`,
        [tenantId],
      ),
    );
    assert.equal(result.rows[0]!.row_count, "1", "re-running the same range must never produce a second row for the same (tenant, date, channel)");

    const row = await getChannelRollup(tenantId, "temu");
    assert.equal(row!.revenue, "18.00", "totals must stay correct, not double-counted, across repeated runs");
  } finally {
    await cleanup(tenantId);
  }
});
