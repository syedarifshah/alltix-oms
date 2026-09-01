// Proves the failure mode CLAUDE.md §11.2 and §7's fuzz-testing row call
// out: N simultaneous allocation attempts against 1 unit of stock must
// leave exactly one order allocated and the rest backordered -- never two
// orders both allocated (oversell), never an error, never a partial
// allocation. Requires a live Postgres (npm run db:migrate).
//
// Run with: npm run test --workspace=@alltix/order-service -- allocation-concurrency

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { Client, type Pool } from "pg";
import { createAppPool, withTenant } from "@alltix/db";
import type { OrderStatus } from "@alltix/shared";
import { OrderService } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

loadEnv({ path: join(REPO_ROOT, ".env") });

const ORDER_COUNT = 10;

let pool: Pool;
const tenantId = randomUUID();

interface Scenario {
  productId: string;
  locationId: string;
  orderIds: string[];
}

async function seedScenario(): Promise<Scenario> {
  return withTenant(pool, tenantId, async (client) => {
    const location = await client.query<{ id: string }>(
      `INSERT INTO locations (tenant_id, name, type) VALUES ($1, 'Concurrency Test Warehouse', 'warehouse') RETURNING id`,
      [tenantId],
    );
    const locationId = location.rows[0]!.id;

    const product = await client.query<{ id: string }>(
      `INSERT INTO products (tenant_id, internal_sku, name) VALUES ($1, 'CONCURRENCY-TEST-SKU', 'Concurrency Test Product') RETURNING id`,
      [tenantId],
    );
    const productId = product.rows[0]!.id;

    // Exactly 1 unit available -- CLAUDE.md §7's fuzz-testing scenario.
    await client.query(
      `INSERT INTO inventory_levels (tenant_id, product_id, location_id, on_hand, reserved) VALUES ($1, $2, $3, 1, 0)`,
      [tenantId, productId, locationId],
    );

    const orderIds: string[] = [];
    for (let i = 0; i < ORDER_COUNT; i++) {
      const order = await client.query<{ id: string }>(
        `INSERT INTO orders (tenant_id, channel, external_order_id, status)
         VALUES ($1, 'amazon', $2, 'validated') RETURNING id`,
        [tenantId, `CONCURRENCY-TEST-${i}`],
      );
      const orderId = order.rows[0]!.id;
      orderIds.push(orderId);

      await client.query(
        `INSERT INTO order_lines (tenant_id, order_id, product_id, quantity, unit_price, fulfillment_type)
         VALUES ($1, $2, $3, 1, 9.99, 'seller_fulfilled')`,
        [tenantId, orderId, productId],
      );
    }

    return { productId, locationId, orderIds };
  });
}

before(async () => {
  const connectionString = process.env.APP_DATABASE_URL;
  if (!connectionString) {
    throw new Error("APP_DATABASE_URL is not set (see .env.example)");
  }
  // Headroom above pg's default max=10 so all ORDER_COUNT allocation
  // attempts can genuinely run concurrently, each holding its own
  // connection for the duration of its transaction.
  pool = createAppPool({ connectionString, max: ORDER_COUNT + 5 });
});

after(async () => {
  // inventory_events/orders/inventory_levels have no DELETE grant for
  // app_user by design (migrations 0005-0007) -- clean up via the
  // schema-owning connection, same pattern as the other order-service test.
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

test(`exactly 1 of ${ORDER_COUNT} concurrent allocation attempts against 1 unit of stock succeeds`, async () => {
  const { productId, locationId, orderIds } = await seedScenario();
  const orderService = new OrderService(pool);

  const results = await Promise.all(
    orderIds.map((orderId) => orderService.transition(tenantId, orderId, "validated", "allocated")),
  );

  const counts = results.reduce<Partial<Record<OrderStatus, number>>>((acc, status) => {
    acc[status] = (acc[status] ?? 0) + 1;
    return acc;
  }, {});

  assert.equal(counts.allocated, 1, "exactly one order must end up allocated");
  assert.equal(counts.backordered, ORDER_COUNT - 1, "every other order must end up backordered");

  const levels = await withTenant(pool, tenantId, (client) =>
    client.query<{ on_hand: number; reserved: number; available: number }>(
      `SELECT on_hand, reserved, available FROM inventory_levels WHERE product_id = $1 AND location_id = $2`,
      [productId, locationId],
    ),
  );
  assert.deepEqual(
    levels.rows[0],
    { on_hand: 1, reserved: 1, available: 0 },
    "stock must be reserved exactly once, never oversold",
  );

  const events = await withTenant(pool, tenantId, (client) =>
    client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_events WHERE tenant_id = $1 AND event_type = 'reservation'`,
      [tenantId],
    ),
  );
  assert.equal(events.rows[0]?.count, "1", "exactly one reservation event must exist");

  const statuses = await withTenant(pool, tenantId, (client) =>
    client.query<{ status: OrderStatus; count: string }>(
      `SELECT status, count(*)::text AS count FROM orders WHERE tenant_id = $1 GROUP BY status`,
      [tenantId],
    ),
  );
  const statusCounts = Object.fromEntries(statuses.rows.map((r) => [r.status, Number(r.count)]));
  assert.deepEqual(statusCounts, { allocated: 1, backordered: ORDER_COUNT - 1 });
});
