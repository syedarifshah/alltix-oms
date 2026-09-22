// Proves OrderService.cancelOrder() (reached via transition(..., 'cancelled'))
// does what CLAUDE.md §3 requires: "Cancellation after allocation must emit a
// release inventory event, not just delete the reservation -- the ledger
// should show *why* stock came back." Covers every state that actually
// reaches cancelOrder with a live reservation to release ('allocated',
// 'picking'), a state with nothing to release ('validated'), and the
// guarded-UPDATE's concurrency check rejecting a stale `from`.
//
// Run with: npm run test --workspace=@alltix/order-service -- cancel-order

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
      `INSERT INTO locations (tenant_id, name, type) VALUES ($1, 'Cancel Test Warehouse', 'warehouse') RETURNING id`,
      [tenantId],
    );
    return location.rows[0]!.id;
  });
});

after(async () => {
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query("DELETE FROM audit_log WHERE tenant_id = $1", [tenantId]);
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
      `INSERT INTO products (tenant_id, internal_sku, name) VALUES ($1, $2, 'Cancel Test Product') RETURNING id`,
      [tenantId, `INTERNAL-${externalSku}`],
    );
    const productId = product.rows[0]!.id;

    await client.query(
      `INSERT INTO channel_listings (tenant_id, product_id, channel, channel_marketplace, external_sku, listing_status)
       VALUES ($1, $2, 'amazon', 'US', $3, 'active')`,
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
    channel: "amazon",
    channelMarketplace: "US",
    placedAt: new Date().toISOString(),
    channelStatus: "Unshipped",
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
    rawPayload: { synthetic: true, note: "hand-built for this test, not a real SP-API response" },
  };
}

test("cancelling an allocated order releases its reservation back to available", async () => {
  const externalSku = `SKU-${randomUUID().slice(0, 8)}`;
  const productId = await seedProduct(5, externalSku);
  const orderService = new OrderService(pool);

  const result = await orderService.persistPulledOrders(tenantId, [
    makeSyntheticOrder("CANCEL-ALLOCATED-ORDER", externalSku, 2),
  ]);
  const orderId = result.insertedOrderIds[0]!;

  const before = await withTenant(pool, tenantId, (client) =>
    client.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [orderId]),
  );
  assert.equal(before.rows[0]?.status, "allocated");

  const finalStatus = await orderService.transition(tenantId, orderId, "allocated", "cancelled");
  assert.equal(finalStatus, "cancelled");

  const after = await withTenant(pool, tenantId, (client) =>
    client.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [orderId]),
  );
  assert.equal(after.rows[0]?.status, "cancelled");

  const releaseEvents = await withTenant(pool, tenantId, (client) =>
    client.query<{ quantity_delta: number }>(
      `SELECT quantity_delta FROM inventory_events WHERE tenant_id = $1 AND reference_id = $2 AND event_type = 'release'`,
      [tenantId, orderId],
    ),
  );
  assert.equal(releaseEvents.rows.length, 1, "exactly one release event, mirroring the one reservation event");
  assert.equal(releaseEvents.rows[0]?.quantity_delta, 2, "release quantity is the positive magnitude given back");

  const levels = await withTenant(pool, tenantId, (client) =>
    client.query<{ reserved: number; available: number }>(
      `SELECT reserved, available FROM inventory_levels WHERE product_id = $1 AND location_id = $2`,
      [productId, locationId],
    ),
  );
  assert.deepEqual(levels.rows[0], { reserved: 0, available: 5 }, "reservation fully released back to available");
});

test("cancelling a picking order also releases its reservation", async () => {
  const externalSku = `SKU-${randomUUID().slice(0, 8)}`;
  const productId = await seedProduct(3, externalSku);
  const orderService = new OrderService(pool);

  const result = await orderService.persistPulledOrders(tenantId, [
    makeSyntheticOrder("CANCEL-PICKING-ORDER", externalSku, 1),
  ]);
  const orderId = result.insertedOrderIds[0]!;

  await orderService.transition(tenantId, orderId, "allocated", "picking");

  const finalStatus = await orderService.transition(tenantId, orderId, "picking", "cancelled");
  assert.equal(finalStatus, "cancelled");

  const levels = await withTenant(pool, tenantId, (client) =>
    client.query<{ reserved: number; available: number }>(
      `SELECT reserved, available FROM inventory_levels WHERE product_id = $1 AND location_id = $2`,
      [productId, locationId],
    ),
  );
  assert.deepEqual(levels.rows[0], { reserved: 0, available: 3 });
});

test("cancelling a validated order (never allocated) has nothing to release", async () => {
  const externalSku = `SKU-${randomUUID().slice(0, 8)}`;
  await seedProduct(5, externalSku);
  const orderService = new OrderService(pool);

  const orderId = await withTenant(pool, tenantId, async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO orders (tenant_id, channel, external_order_id, status, customer, shipping_address, placed_at, raw_payload)
       VALUES ($1, 'amazon', 'CANCEL-VALIDATED-ORDER', 'validated', '{}', '{}', now(), '{}')
       RETURNING id`,
      [tenantId],
    );
    return inserted.rows[0]!.id;
  });

  const finalStatus = await orderService.transition(tenantId, orderId, "validated", "cancelled");
  assert.equal(finalStatus, "cancelled");

  const events = await withTenant(pool, tenantId, (client) =>
    client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_events WHERE tenant_id = $1 AND reference_id = $2`,
      [tenantId, orderId],
    ),
  );
  assert.equal(events.rows[0]?.count, "0", "no reservation ever existed, so no release event either");
});

test("cancelling with a stale `from` is rejected instead of double-cancelling", async () => {
  const externalSku = `SKU-${randomUUID().slice(0, 8)}`;
  await seedProduct(5, externalSku);
  const orderService = new OrderService(pool);

  const result = await orderService.persistPulledOrders(tenantId, [
    makeSyntheticOrder("CANCEL-STALE-FROM-ORDER", externalSku, 1),
  ]);
  const orderId = result.insertedOrderIds[0]!;

  // Order is actually 'allocated'; cancel it once for real.
  await orderService.transition(tenantId, orderId, "allocated", "cancelled");

  // A second cancellation attempt using the same (now-stale) `from` must be
  // rejected by the guarded UPDATE (WHERE status = $3), not silently no-op
  // or double-release.
  await assert.rejects(
    () => orderService.transition(tenantId, orderId, "allocated", "cancelled"),
    /is not in status 'allocated'/,
  );

  const releaseEvents = await withTenant(pool, tenantId, (client) =>
    client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_events WHERE tenant_id = $1 AND reference_id = $2 AND event_type = 'release'`,
      [tenantId, orderId],
    ),
  );
  assert.equal(releaseEvents.rows[0]?.count, "1", "still exactly one release event -- the rejected retry released nothing");
});

test("cancelling a packed order is rejected by the state machine before cancelOrder ever runs", async () => {
  const externalSku = `SKU-${randomUUID().slice(0, 8)}`;
  await seedProduct(5, externalSku);
  const orderService = new OrderService(pool);

  const result = await orderService.persistPulledOrders(tenantId, [
    makeSyntheticOrder("CANCEL-PACKED-ORDER", externalSku, 1),
  ]);
  const orderId = result.insertedOrderIds[0]!;

  await orderService.transition(tenantId, orderId, "allocated", "picking");
  await orderService.transition(tenantId, orderId, "picking", "packed");

  await assert.rejects(
    () => orderService.transition(tenantId, orderId, "packed", "cancelled"),
    /Invalid order transition: packed -> cancelled/,
  );
});
