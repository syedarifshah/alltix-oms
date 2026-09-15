// Proves allocateOrder() is now stock-aware across every one of a tenant's
// warehouse locations, not just one: when the preferred/default location is
// short, it falls back to trying other warehouses in priority order instead
// of backordering immediately. Requires a live Postgres (npm run db:migrate).
//
// Run with: npm run test --workspace=@alltix/order-service -- multi-warehouse-allocation

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { Client, type Pool } from "pg";
import { createAppPool, withTenant } from "@alltix/db";
import { OrderService } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

loadEnv({ path: join(REPO_ROOT, ".env") });

let pool: Pool;
const tenantId = randomUUID();

async function seedLocation(name: string): Promise<string> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO locations (tenant_id, name, type) VALUES ($1, $2, 'warehouse') RETURNING id`,
      [tenantId, name],
    );
    return result.rows[0]!.id;
  });
}

async function seedProduct(sku: string): Promise<string> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO products (tenant_id, internal_sku, name) VALUES ($1, $2, $2) RETURNING id`,
      [tenantId, sku],
    );
    return result.rows[0]!.id;
  });
}

async function seedLevel(productId: string, locationId: string, onHand: number): Promise<void> {
  await withTenant(pool, tenantId, (client) =>
    client.query(
      `INSERT INTO inventory_levels (tenant_id, product_id, location_id, on_hand, reserved) VALUES ($1, $2, $3, $4, 0)`,
      [tenantId, productId, locationId, onHand],
    ),
  );
}

async function seedOrder(
  productId: string,
  quantity: number,
  preferredLocationId: string | null = null,
): Promise<string> {
  return withTenant(pool, tenantId, async (client) => {
    const order = await client.query<{ id: string }>(
      `INSERT INTO orders (tenant_id, channel, external_order_id, status, preferred_location_id)
       VALUES ($1, 'amazon', $2, 'validated', $3) RETURNING id`,
      [tenantId, `MULTI-WH-TEST-${randomUUID()}`, preferredLocationId],
    );
    const orderId = order.rows[0]!.id;
    await client.query(
      `INSERT INTO order_lines (tenant_id, order_id, product_id, quantity, unit_price, fulfillment_type)
       VALUES ($1, $2, $3, $4, 9.99, 'seller_fulfilled')`,
      [tenantId, orderId, productId, quantity],
    );
    return orderId;
  });
}

before(async () => {
  const connectionString = process.env.APP_DATABASE_URL;
  if (!connectionString) {
    throw new Error("APP_DATABASE_URL is not set (see .env.example)");
  }
  pool = createAppPool({ connectionString });
});

after(async () => {
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query("DELETE FROM inventory_events WHERE tenant_id = $1", [tenantId]);
  await admin.query("DELETE FROM orders WHERE tenant_id = $1", [tenantId]); // cascades order_lines
  await admin.query("DELETE FROM inventory_levels WHERE tenant_id = $1", [tenantId]);
  await admin.end();

  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM locations WHERE tenant_id = $1", [tenantId]));
  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM products WHERE tenant_id = $1", [tenantId]));
  await pool.end();
});

test("a short default warehouse falls back to a second warehouse with enough stock, instead of backordering", async () => {
  const shortLocationId = await seedLocation("Multi-WH Short (Default/Oldest)");
  const sufficientLocationId = await seedLocation("Multi-WH Sufficient (Fallback)");
  const productId = await seedProduct("MULTI-WH-SKU-1");
  await seedLevel(productId, shortLocationId, 1); // short: order needs 3
  await seedLevel(productId, sufficientLocationId, 10);

  const orderId = await seedOrder(productId, 3);
  const orderService = new OrderService(pool);
  const status = await orderService.transition(tenantId, orderId, "validated", "allocated");

  assert.equal(status, "allocated", "must allocate against the fallback warehouse instead of backordering");

  const order = await withTenant(pool, tenantId, (client) =>
    client.query<{ preferred_location_id: string | null }>(
      `SELECT preferred_location_id FROM orders WHERE id = $1`,
      [orderId],
    ),
  );
  // preferred_location_id was never set on this order -- it stays null.
  // The point under test is *where the reservation landed*, checked below.
  assert.equal(order.rows[0]?.preferred_location_id, null);

  const events = await withTenant(pool, tenantId, (client) =>
    client.query<{ location_id: string; quantity_delta: number }>(
      `SELECT location_id, quantity_delta FROM inventory_events
       WHERE tenant_id = $1 AND reference_id = $2 AND event_type = 'reservation'`,
      [tenantId, orderId],
    ),
  );
  assert.equal(events.rows.length, 1);
  assert.equal(events.rows[0]?.location_id, sufficientLocationId, "reservation must be at the fallback warehouse");
  assert.equal(events.rows[0]?.quantity_delta, -3);

  const shortLevel = await withTenant(pool, tenantId, (client) =>
    client.query<{ reserved: number }>(
      `SELECT reserved FROM inventory_levels WHERE product_id = $1 AND location_id = $2`,
      [productId, shortLocationId],
    ),
  );
  assert.equal(shortLevel.rows[0]?.reserved, 0, "the short location must be untouched, not partially reserved");

  const sufficientLevel = await withTenant(pool, tenantId, (client) =>
    client.query<{ reserved: number }>(
      `SELECT reserved FROM inventory_levels WHERE product_id = $1 AND location_id = $2`,
      [productId, sufficientLocationId],
    ),
  );
  assert.equal(sufficientLevel.rows[0]?.reserved, 3);
});

test("a short preferred location falls back to a non-preferred warehouse with enough stock", async () => {
  const preferredLocationId = await seedLocation("Multi-WH Preferred (Short)");
  const fallbackLocationId = await seedLocation("Multi-WH Fallback (Sufficient)");
  const productId = await seedProduct("MULTI-WH-SKU-2");
  await seedLevel(productId, preferredLocationId, 0); // short
  await seedLevel(productId, fallbackLocationId, 5);

  const orderId = await seedOrder(productId, 2, preferredLocationId);
  const orderService = new OrderService(pool);
  const status = await orderService.transition(tenantId, orderId, "validated", "allocated");

  assert.equal(status, "allocated");

  const events = await withTenant(pool, tenantId, (client) =>
    client.query<{ location_id: string }>(
      `SELECT location_id FROM inventory_events
       WHERE tenant_id = $1 AND reference_id = $2 AND event_type = 'reservation'`,
      [tenantId, orderId],
    ),
  );
  assert.equal(events.rows.length, 1);
  assert.equal(
    events.rows[0]?.location_id,
    fallbackLocationId,
    "must fall back to the non-preferred warehouse, since the preferred one is short",
  );
});

test("when every warehouse is short, the order backorders with no reservation at any location", async () => {
  const locationAId = await seedLocation("Multi-WH All-Short A");
  const locationBId = await seedLocation("Multi-WH All-Short B");
  const productId = await seedProduct("MULTI-WH-SKU-3");
  await seedLevel(productId, locationAId, 1);
  await seedLevel(productId, locationBId, 1);

  const orderId = await seedOrder(productId, 5); // more than either location has
  const orderService = new OrderService(pool);
  const status = await orderService.transition(tenantId, orderId, "validated", "allocated");

  assert.equal(status, "backordered");

  const events = await withTenant(pool, tenantId, (client) =>
    client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_events WHERE tenant_id = $1 AND reference_id = $2 AND event_type = 'reservation'`,
      [tenantId, orderId],
    ),
  );
  assert.equal(events.rows[0]?.count, "0", "no reservation should exist against any location");

  for (const locationId of [locationAId, locationBId]) {
    const level = await withTenant(pool, tenantId, (client) =>
      client.query<{ reserved: number }>(
        `SELECT reserved FROM inventory_levels WHERE product_id = $1 AND location_id = $2`,
        [productId, locationId],
      ),
    );
    assert.equal(level.rows[0]?.reserved, 0, `location ${locationId} must be untouched`);
  }
});

test("the tenant's oldest warehouse is tried before a newer one when both have enough stock", async () => {
  const olderLocationId = await seedLocation("Multi-WH Older (Sufficient)");
  const newerLocationId = await seedLocation("Multi-WH Newer (Also Sufficient)");
  const productId = await seedProduct("MULTI-WH-SKU-4");
  await seedLevel(productId, olderLocationId, 10);
  await seedLevel(productId, newerLocationId, 10);

  const orderId = await seedOrder(productId, 2);
  const orderService = new OrderService(pool);
  const status = await orderService.transition(tenantId, orderId, "validated", "allocated");

  assert.equal(status, "allocated");

  const events = await withTenant(pool, tenantId, (client) =>
    client.query<{ location_id: string }>(
      `SELECT location_id FROM inventory_events
       WHERE tenant_id = $1 AND reference_id = $2 AND event_type = 'reservation'`,
      [tenantId, orderId],
    ),
  );
  assert.equal(
    events.rows[0]?.location_id,
    olderLocationId,
    "the older (created-first) warehouse must be preferred when no location is explicitly routed and both have stock",
  );
});
