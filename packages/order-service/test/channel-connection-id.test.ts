// Proves persistPulledOrders()'s new optional channelConnectionId parameter
// (migration 0037_orders_channel_connection_id.sql) actually writes
// orders.channel_connection_id -- the piece that lets a multi-connection
// channel (today, only TikTok Shop -- CLAUDE.md §12's "no true multi-shop
// CONNECT" gap) later resolve an order back to the specific shop it came
// from (see WarehouseService.confirmShipment's own updated TikTok branch).
//
// Deliberately channel-agnostic at the DB layer here -- this column's write
// path lives entirely inside persistPulledOrders() itself, not in any
// channel-specific code, so proving it with a synthetic order (same
// hand-built-NormalizedOrder pattern batch-partial-failure.test.ts already
// established) is exactly as strong a proof as driving it through a real
// TikTok pull would be, without needing live TikTok credentials that don't
// exist anywhere in this codebase yet.
//
// Run with: npm run test --workspace=@alltix/order-service -- channel-connection-id

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
      `INSERT INTO locations (tenant_id, name, type) VALUES ($1, 'Channel Connection Id Test Warehouse', 'warehouse') RETURNING id`,
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
  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM channel_connections WHERE tenant_id = $1", [tenantId]));
  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM locations WHERE tenant_id = $1", [tenantId]));
  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM products WHERE tenant_id = $1", [tenantId]));
  await pool.end();
});

async function seedProduct(externalSku: string): Promise<string> {
  return withTenant(pool, tenantId, async (client) => {
    const product = await client.query<{ id: string }>(
      `INSERT INTO products (tenant_id, internal_sku, name) VALUES ($1, $2, 'Channel Connection Id Test Product') RETURNING id`,
      [tenantId, `INTERNAL-${externalSku}`],
    );
    const productId = product.rows[0]!.id;

    await client.query(
      `INSERT INTO channel_listings (tenant_id, product_id, channel, channel_marketplace, external_sku, listing_status)
       VALUES ($1, $2, 'tiktok', '', $3, 'active')`,
      [tenantId, productId, externalSku],
    );

    await client.query(
      `INSERT INTO inventory_levels (tenant_id, product_id, location_id, on_hand, reserved) VALUES ($1, $2, $3, 10, 0)`,
      [tenantId, productId, locationId],
    );

    return productId;
  });
}

/** A real 'tiktok' channel_connections row -- just enough to get a real id
 *  back to pass into persistPulledOrders(); this test never calls
 *  loadTikTokCredentialsFromChannelConnection() or reaches the network, so
 *  the row doesn't need real credentials. */
async function seedTikTokConnection(shopCipher: string): Promise<string> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO channel_connections (tenant_id, channel, marketplace, external_account_id)
       VALUES ($1, 'tiktok', '', $2) RETURNING id`,
      [tenantId, shopCipher],
    );
    return result.rows[0]!.id;
  });
}

function makeSyntheticOrder(externalOrderId: string, externalSku: string): NormalizedOrder {
  return {
    externalOrderId,
    channel: "tiktok",
    channelMarketplace: "",
    placedAt: new Date().toISOString(),
    channelStatus: "open",
    customer: {},
    shippingAddress: {},
    lines: [
      {
        externalLineId: `${externalOrderId}-line-1`,
        externalSku,
        quantity: 1,
        unitPrice: "9.99",
        fulfillmentType: "seller_fulfilled",
      },
    ],
    rawPayload: { synthetic: true, note: "hand-built for this test, not a real TikTok Shop payload" },
  };
}

async function getChannelConnectionId(externalOrderId: string): Promise<string | null> {
  const result = await withTenant(pool, tenantId, (client) =>
    client.query<{ channel_connection_id: string | null }>(
      `SELECT channel_connection_id FROM orders WHERE tenant_id = $1 AND external_order_id = $2`,
      [tenantId, externalOrderId],
    ),
  );
  const row = result.rows[0];
  assert.ok(row, `expected an orders row for ${externalOrderId}`);
  return row.channel_connection_id;
}

test("persistPulledOrders stamps orders.channel_connection_id when given one, leaves it NULL when omitted", async () => {
  const sku = `CCID-${randomUUID().slice(0, 8)}`;
  await seedProduct(sku);
  const connectionId = await seedTikTokConnection(`shop-cipher-${randomUUID().slice(0, 8)}`);

  const orderService = new OrderService(pool);

  const withConnection = `WITH-CONN-${randomUUID()}`;
  const withoutConnection = `WITHOUT-CONN-${randomUUID()}`;

  const withResult = await orderService.persistPulledOrders(tenantId, [makeSyntheticOrder(withConnection, sku)], connectionId);
  assert.equal(withResult.insertedOrderIds.length, 1);
  assert.equal(
    await getChannelConnectionId(withConnection),
    connectionId,
    "the order pulled from a specific connection must record that connection's id",
  );

  // No third argument at all -- exactly how every non-TikTok channel's own
  // call site still calls this (Amazon/Shopify/Walmart/eBay/Temu's sync
  // jobs, the Shopify webhook handler): must stay NULL, not somehow
  // inherit the previous call's connectionId or default to anything else.
  const withoutResult = await orderService.persistPulledOrders(tenantId, [makeSyntheticOrder(withoutConnection, sku)]);
  assert.equal(withoutResult.insertedOrderIds.length, 1);
  assert.equal(
    await getChannelConnectionId(withoutConnection),
    null,
    "omitting channelConnectionId must leave the column NULL, exactly as before this parameter existed",
  );
});

test("two orders from two different connections each record their own, distinct channel_connection_id", async () => {
  const sku = `CCID-MULTI-${randomUUID().slice(0, 8)}`;
  await seedProduct(sku);
  const connectionA = await seedTikTokConnection(`shop-cipher-a-${randomUUID().slice(0, 8)}`);
  const connectionB = await seedTikTokConnection(`shop-cipher-b-${randomUUID().slice(0, 8)}`);
  assert.notEqual(connectionA, connectionB);

  const orderService = new OrderService(pool);

  const orderFromA = `FROM-A-${randomUUID()}`;
  const orderFromB = `FROM-B-${randomUUID()}`;

  await orderService.persistPulledOrders(tenantId, [makeSyntheticOrder(orderFromA, sku)], connectionA);
  await orderService.persistPulledOrders(tenantId, [makeSyntheticOrder(orderFromB, sku)], connectionB);

  assert.equal(await getChannelConnectionId(orderFromA), connectionA);
  assert.equal(await getChannelConnectionId(orderFromB), connectionB);
});
