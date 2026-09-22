// Proves the wiring persistPulledOrders() -> transition() -> allocateOrder()
// end to end with real order_lines: a pulled order must not sit at
// 'received' forever (CLAUDE.md §3) -- it should land 'allocated' with a
// matching inventory_events row when stock suffices, or 'backordered' with
// none when it doesn't.
//
// Uses a hand-built NormalizedOrder rather than a real Amazon sandbox pull:
// AmazonConnector.pullOrders() only fetches order headers today (order
// items need a separate SP-API call that isn't implemented yet, see
// amazon-connector.ts), so a real pull's `lines` is always empty and can't
// exercise this path. This fills that gap with a synthetic order shaped
// exactly like a real one, tied to a real channel_listings row so
// persistPulledOrders()'s SKU -> product_id resolution runs for real too.
//
// Run with: npm run test --workspace=@alltix/order-service -- persist-and-allocate

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
      `INSERT INTO locations (tenant_id, name, type) VALUES ($1, 'Persist+Allocate Test Warehouse', 'warehouse') RETURNING id`,
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
      `INSERT INTO products (tenant_id, internal_sku, name) VALUES ($1, $2, 'Persist+Allocate Test Product') RETURNING id`,
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

test("a sufficiently-stocked pulled order ends up allocated with a matching inventory_events row", async () => {
  const externalSku = `SKU-${randomUUID().slice(0, 8)}`;
  const productId = await seedProduct(5, externalSku);
  const orderService = new OrderService(pool);

  const result = await orderService.persistPulledOrders(tenantId, [
    makeSyntheticOrder("SUFFICIENT-STOCK-ORDER", externalSku, 2),
  ]);
  assert.equal(result.insertedOrderIds.length, 1);
  const orderId = result.insertedOrderIds[0]!;

  const orderRow = await withTenant(pool, tenantId, (client) =>
    client.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [orderId]),
  );
  assert.equal(orderRow.rows[0]?.status, "allocated", "order must not be stuck at 'received'");

  const events = await withTenant(pool, tenantId, (client) =>
    client.query<{ quantity_delta: number; reference_id: string }>(
      `SELECT quantity_delta, reference_id FROM inventory_events WHERE tenant_id = $1 AND event_type = 'reservation'`,
      [tenantId],
    ),
  );
  assert.equal(events.rows.length, 1);
  assert.equal(events.rows[0]?.quantity_delta, -2);
  assert.equal(events.rows[0]?.reference_id, orderId);

  const levels = await withTenant(pool, tenantId, (client) =>
    client.query<{ reserved: number; available: number }>(
      `SELECT reserved, available FROM inventory_levels WHERE product_id = $1 AND location_id = $2`,
      [productId, locationId],
    ),
  );
  assert.deepEqual(levels.rows[0], { reserved: 2, available: 3 });
});

test("an insufficiently-stocked pulled order ends up backordered with no reservation events", async () => {
  const externalSku = `SKU-${randomUUID().slice(0, 8)}`;
  await seedProduct(1, externalSku);
  const orderService = new OrderService(pool);

  const result = await orderService.persistPulledOrders(tenantId, [
    makeSyntheticOrder("INSUFFICIENT-STOCK-ORDER", externalSku, 100),
  ]);
  const orderId = result.insertedOrderIds[0]!;

  const orderRow = await withTenant(pool, tenantId, (client) =>
    client.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [orderId]),
  );
  assert.equal(orderRow.rows[0]?.status, "backordered", "order must not be stuck at 'received'");

  const events = await withTenant(pool, tenantId, (client) =>
    client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_events WHERE tenant_id = $1 AND reference_id = $2`,
      [tenantId, orderId],
    ),
  );
  assert.equal(events.rows[0]?.count, "0", "a backordered order must not have any reservation events");
});
