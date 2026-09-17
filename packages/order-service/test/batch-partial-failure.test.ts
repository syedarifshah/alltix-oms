// Regression coverage for the real production bug found diagnosing a live
// Shopify "No channel_listings match ... cannot resolve product_id for
// order_lines" sync failure (CLAUDE.md's Shopify update note): one order in
// a pulled batch failing insertOrderLines() -- e.g. a line item whose SKU
// can never match a channel_listings row -- used to throw straight out of
// persistPulledOrders()'s loop, which aborted the ENTIRE withTenant
// transaction. Every OTHER order in that same pull window (including ones
// that would persist just fine) was silently rolled back too, not just the
// bad one, and kept being silently re-lost on every retry until the one bad
// order was fixed. This proves the SAVEPOINT-per-order fix: a batch with
// one unresolvable order still commits every other order, the bad order's
// own `orders` row is cleanly rolled back (no orphan row, no orphan
// order_lines), and the overall call still throws/signals failure so the
// scheduler's recordSyncFailure()/last_order_sync_at-doesn't-advance
// contract (packages/scheduler/src/index.ts) keeps working.
//
// Run with: npm run test --workspace=@alltix/order-service -- batch-partial-failure

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { Client, type Pool } from "pg";
import { createAppPool, withTenant } from "@alltix/db";
import type { NormalizedOrder } from "@alltix/channel-connectors";
import { OrderService } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

loadEnv({ path: join(REPO_ROOT, ".env") });

let pool: Pool;
const tenantId = randomUUID();
let locationId: string;

before(async () => {
  const connectionString = process.env.APP_DATABASE_URL;
  if (!connectionString) {
    throw new Error("APP_DATABASE_URL is not set (see .env.example)");
  }
  pool = createAppPool({ connectionString });

  locationId = await withTenant(pool, tenantId, async (client) => {
    const location = await client.query<{ id: string }>(
      `INSERT INTO locations (tenant_id, name, type) VALUES ($1, 'Batch Partial Failure Test Warehouse', 'warehouse') RETURNING id`,
      [tenantId],
    );
    return location.rows[0]!.id;
  });
});

after(async () => {
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query("DELETE FROM inventory_events WHERE tenant_id = $1", [tenantId]);
  await admin.query("DELETE FROM orders WHERE tenant_id = $1", [tenantId]); // cascades order_lines
  await admin.query("DELETE FROM inventory_levels WHERE tenant_id = $1", [tenantId]);
  await admin.end();

  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM channel_listings WHERE tenant_id = $1", [tenantId]));
  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM locations WHERE tenant_id = $1", [tenantId]));
  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM products WHERE tenant_id = $1", [tenantId]));
  await pool.end();
});

/** Seeds a fresh product + channel_listings mapping + inventory_levels row, isolated per test. */
async function seedProduct(onHand: number, externalSku: string): Promise<string> {
  return withTenant(pool, tenantId, async (client) => {
    const product = await client.query<{ id: string }>(
      `INSERT INTO products (tenant_id, internal_sku, name) VALUES ($1, $2, 'Batch Partial Failure Test Product') RETURNING id`,
      [tenantId, `INTERNAL-${externalSku}`],
    );
    const productId = product.rows[0]!.id;

    await client.query(
      `INSERT INTO channel_listings (tenant_id, product_id, channel, channel_marketplace, external_sku, listing_status)
       VALUES ($1, $2, 'shopify', '', $3, 'active')`,
      [tenantId, productId, externalSku],
    );

    await client.query(
      `INSERT INTO inventory_levels (tenant_id, product_id, location_id, on_hand, reserved) VALUES ($1, $2, $3, $4, 0)`,
      [tenantId, productId, locationId, onHand],
    );

    return productId;
  });
}

function makeSyntheticOrder(externalOrderId: string, externalSku: string, quantity: number): NormalizedOrder {
  return {
    externalOrderId,
    channel: "shopify",
    channelMarketplace: "",
    placedAt: new Date().toISOString(),
    channelStatus: "open",
    customer: {},
    shippingAddress: {},
    lines: [
      {
        externalLineId: `${externalOrderId}-line-1`,
        externalSku,
        quantity,
        unitPrice: "9.99",
        fulfillmentType: "seller_fulfilled",
      },
    ],
    rawPayload: { synthetic: true, note: "hand-built for this test, not a real Shopify payload" },
  };
}

test("a batch with one unresolvable-SKU order still persists every other order, rolls back only the bad one, and still signals failure", async () => {
  const goodSkuA = `GOOD-A-${randomUUID().slice(0, 8)}`;
  const goodSkuB = `GOOD-B-${randomUUID().slice(0, 8)}`;
  // Deliberately never seeded into channel_listings -- mirrors a real Shopify
  // line item with no SKU set, whose externalSku falls back to a LineItem
  // gid that can never match a channel_listings row (see
  // normalizeShopifyOrderLine's doc comment in shopify-connector.ts).
  const unresolvableSku = `gid://shopify/LineItem/${randomUUID()}`;

  await seedProduct(10, goodSkuA);
  await seedProduct(10, goodSkuB);

  const goodOrderIdA = `GOOD-ORDER-A-${randomUUID()}`;
  const badOrderId = `BAD-ORDER-${randomUUID()}`;
  const goodOrderIdB = `GOOD-ORDER-B-${randomUUID()}`;

  // The bad order is placed in the MIDDLE of the batch on purpose -- proves
  // the loop doesn't just fail-fast and drop everything after it, it keeps
  // going and still picks up the good order that comes after the bad one.
  const batch = [
    makeSyntheticOrder(goodOrderIdA, goodSkuA, 1),
    makeSyntheticOrder(badOrderId, unresolvableSku, 1),
    makeSyntheticOrder(goodOrderIdB, goodSkuB, 1),
  ];

  const orderService = new OrderService(pool);

  await assert.rejects(
    () => orderService.persistPulledOrders(tenantId, batch),
    (err: Error) => {
      assert.match(err.message, /1 of 3 order\(s\) in this batch failed to persist/);
      assert.match(err.message, new RegExp(badOrderId));
      return true;
    },
    "the call must still throw so the scheduler's recordSyncFailure()/cursor-hold contract keeps working",
  );

  const rows = await withTenant(pool, tenantId, (client) =>
    client.query<{ external_order_id: string; status: string }>(
      `SELECT external_order_id, status FROM orders WHERE tenant_id = $1 ORDER BY external_order_id`,
      [tenantId],
    ),
  );
  const byExternalId = new Map(rows.rows.map((r) => [r.external_order_id, r.status]));

  assert.equal(byExternalId.size, 2, "exactly the two good orders must have committed -- not zero, not three");
  assert.equal(byExternalId.get(goodOrderIdA), "allocated", "the good order BEFORE the bad one must still persist and allocate");
  assert.equal(byExternalId.get(goodOrderIdB), "allocated", "the good order AFTER the bad one must still persist and allocate");
  assert.equal(byExternalId.has(badOrderId), false, "the bad order's own orders row must be cleanly rolled back, not left as an orphan");

  const badOrderLines = await withTenant(pool, tenantId, (client) =>
    client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM order_lines ol
         JOIN orders o ON o.id = ol.order_id
        WHERE o.tenant_id = $1 AND o.external_order_id = $2`,
      [tenantId, badOrderId],
    ),
  );
  assert.equal(badOrderLines.rows[0]?.count, "0", "no orphan order_lines for the bad order either");
});

test("a batch where every order fails throws and leaves nothing committed", async () => {
  const unresolvableSkuA = `gid://shopify/LineItem/${randomUUID()}`;
  const unresolvableSkuB = `gid://shopify/LineItem/${randomUUID()}`;
  const badOrderIdA = `ALL-BAD-A-${randomUUID()}`;
  const badOrderIdB = `ALL-BAD-B-${randomUUID()}`;

  const orderService = new OrderService(pool);

  await assert.rejects(
    () =>
      orderService.persistPulledOrders(tenantId, [
        makeSyntheticOrder(badOrderIdA, unresolvableSkuA, 1),
        makeSyntheticOrder(badOrderIdB, unresolvableSkuB, 1),
      ]),
    /2 of 2 order\(s\) in this batch failed to persist/,
  );

  const rows = await withTenant(pool, tenantId, (client) =>
    client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM orders WHERE tenant_id = $1 AND external_order_id = ANY($2)`,
      [tenantId, [badOrderIdA, badOrderIdB]],
    ),
  );
  assert.equal(rows.rows[0]?.count, "0", "neither all-bad order should have left a row behind");
});
