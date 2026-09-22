// Proves OrderService.persistPulledOrders()'s early-cancellation staging
// consumption (migration 0025_early_channel_cancellations): an order whose
// cancellation was reported (by api/webhooks/shopify/route.ts's
// handleOrderCancelled, simulated here at the DB layer since no HTTP test
// harness exists yet for that route) before the order itself was ever
// created locally must land 'cancelled' the moment it IS created, not go
// through the normal received -> validated -> allocated walk -- even when
// stock would otherwise be sufficient to allocate it.
//
// Run with: npm run test --workspace=@alltix/order-service -- early-cancellation

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { Client, type Pool } from "pg";
import { createAppPool, withTenant } from "@alltix/db";
import { DomainEvent, InProcessEventBus, type DomainEventEnvelope } from "@alltix/shared";
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
      `INSERT INTO locations (tenant_id, name, type) VALUES ($1, 'Early Cancellation Test Warehouse', 'warehouse') RETURNING id`,
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

  await withTenant(pool, tenantId, (client) =>
    client.query("DELETE FROM early_channel_cancellations WHERE tenant_id = $1", [tenantId]),
  );
  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM channel_listings WHERE tenant_id = $1", [tenantId]));
  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM locations WHERE tenant_id = $1", [tenantId]));
  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM products WHERE tenant_id = $1", [tenantId]));
  await pool.end();
});

/** Seeds a fresh product + channel_listings mapping + inventory_levels row, isolated per test. */
async function seedProduct(onHand: number, externalSku: string): Promise<string> {
  return withTenant(pool, tenantId, async (client) => {
    const product = await client.query<{ id: string }>(
      `INSERT INTO products (tenant_id, internal_sku, name) VALUES ($1, $2, 'Early Cancellation Test Product') RETURNING id`,
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
    channelStatus: "cancelled",
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

/** Mirrors exactly what handleOrderCancelled (api/webhooks/shopify/route.ts)
 *  does when it finds no local order yet -- stages the cancellation. */
async function stageEarlyCancellation(channel: string, externalOrderId: string): Promise<void> {
  await withTenant(pool, tenantId, (client) =>
    client.query(
      `INSERT INTO early_channel_cancellations (tenant_id, channel, external_order_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, channel, external_order_id) DO NOTHING`,
      [tenantId, channel, externalOrderId],
    ),
  );
}

test("an order with a staged early cancellation lands 'cancelled' on creation, even with sufficient stock", async () => {
  const externalSku = `SKU-${randomUUID().slice(0, 8)}`;
  const externalOrderId = `EARLY-CANCEL-ORDER-${randomUUID()}`;
  await seedProduct(10, externalSku); // plenty of stock -- proves this isn't why it didn't allocate
  await stageEarlyCancellation("shopify", externalOrderId);

  const eventBus = new InProcessEventBus();
  const publishedEvents: DomainEventEnvelope<{ orderId: string }>[] = [];
  eventBus.subscribe<{ orderId: string }>(DomainEvent.OrderCancelled, async (event) => {
    publishedEvents.push(event);
  });
  const orderService = new OrderService(pool, eventBus);

  const result = await orderService.persistPulledOrders(tenantId, [makeSyntheticOrder(externalOrderId, externalSku, 2)]);

  assert.equal(result.insertedOrderIds.length, 1, "the order must still count as inserted, not skipped");
  const orderId = result.insertedOrderIds[0]!;

  const orderRow = await withTenant(pool, tenantId, (client) =>
    client.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [orderId]),
  );
  assert.equal(orderRow.rows[0]?.status, "cancelled", "must land cancelled, not received/validated/allocated");

  const events = await withTenant(pool, tenantId, (client) =>
    client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_events WHERE tenant_id = $1 AND reference_id = $2`,
      [tenantId, orderId],
    ),
  );
  assert.equal(events.rows[0]?.count, "0", "no reservation should ever be attempted for an order born cancelled");

  const staging = await withTenant(pool, tenantId, (client) =>
    client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM early_channel_cancellations WHERE tenant_id = $1 AND external_order_id = $2`,
      [tenantId, externalOrderId],
    ),
  );
  assert.equal(staging.rows[0]?.count, "0", "the staging row must be consumed (deleted), not left behind");

  assert.equal(publishedEvents.length, 1, "OrderCancelled must still publish for an early-cancelled order");
  assert.equal(publishedEvents[0]?.payload.orderId, orderId);
});

test("a normal order with no staged cancellation is unaffected", async () => {
  const externalSku = `SKU-${randomUUID().slice(0, 8)}`;
  const externalOrderId = `NORMAL-ORDER-${randomUUID()}`;
  await seedProduct(10, externalSku);

  const orderService = new OrderService(pool);
  const result = await orderService.persistPulledOrders(tenantId, [makeSyntheticOrder(externalOrderId, externalSku, 2)]);
  const orderId = result.insertedOrderIds[0]!;

  const orderRow = await withTenant(pool, tenantId, (client) =>
    client.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [orderId]),
  );
  assert.equal(orderRow.rows[0]?.status, "allocated", "an order with no staged cancellation must allocate normally");
});

test("staging the same cancellation twice (redelivery) is idempotent, not an error", async () => {
  const externalOrderId = `REDELIVERED-CANCEL-${randomUUID()}`;
  await stageEarlyCancellation("shopify", externalOrderId);
  await stageEarlyCancellation("shopify", externalOrderId); // must not throw a unique-violation

  const staging = await withTenant(pool, tenantId, (client) =>
    client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM early_channel_cancellations WHERE tenant_id = $1 AND external_order_id = $2`,
      [tenantId, externalOrderId],
    ),
  );
  assert.equal(staging.rows[0]?.count, "1", "redelivery must not create a second row");

  // Clean up this one manually -- it's never consumed by a matching order in this test.
  await withTenant(pool, tenantId, (client) =>
    client.query(`DELETE FROM early_channel_cancellations WHERE tenant_id = $1 AND external_order_id = $2`, [
      tenantId,
      externalOrderId,
    ]),
  );
});

test("a staged cancellation for a DIFFERENT channel with the same external order id does not cross-apply", async () => {
  const externalSku = `SKU-${randomUUID().slice(0, 8)}`;
  const externalOrderId = `CROSS-CHANNEL-${randomUUID()}`;
  await seedProduct(10, externalSku);
  // Staged against 'amazon', but the order being persisted below is 'shopify'.
  await stageEarlyCancellation("amazon", externalOrderId);

  const orderService = new OrderService(pool);
  const result = await orderService.persistPulledOrders(tenantId, [makeSyntheticOrder(externalOrderId, externalSku, 2)]);
  const orderId = result.insertedOrderIds[0]!;

  const orderRow = await withTenant(pool, tenantId, (client) =>
    client.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [orderId]),
  );
  assert.equal(orderRow.rows[0]?.status, "allocated", "a same-id cancellation staged for a different channel must not apply");

  // Clean up the still-unconsumed amazon-channel staging row.
  await withTenant(pool, tenantId, (client) =>
    client.query(`DELETE FROM early_channel_cancellations WHERE tenant_id = $1 AND external_order_id = $2`, [
      tenantId,
      externalOrderId,
    ]),
  );
});
