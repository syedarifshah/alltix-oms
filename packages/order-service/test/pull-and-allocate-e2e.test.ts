// Proves the full real path end to end, no synthetic data anywhere:
//   channel_connections row (encrypted creds) -> LWA auth -> real sandbox
//   GetOrders + GetOrderItems calls -> persistPulledOrders() -> real
//   allocation, reserving a real quantity pulled from a real Amazon
//   response against real inventory_levels stock.
//
// persist-and-allocate.test.ts proves the same persist->allocate logic in
// isolation with a hand-built NormalizedOrder (needed because a real
// sandbox pull previously had no line items at all). Now that
// AmazonConnector.pullOrders() fetches real order items, this test proves
// the whole chain with nothing faked.
//
// Requires a live Postgres (npm run db:migrate) and real Amazon sandbox
// credentials in .env, same as the other Amazon-sandbox tests.
//
// Run with: npm run test --workspace=@alltix/order-service -- pull-and-allocate-e2e

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { Client, type Pool } from "pg";
import { createAppPool, withTenant } from "@alltix/db";
import {
  createAmazonConnectorFromChannelConnection,
  SP_API_SANDBOX_TEST_CASE_CREATED_AFTER,
} from "@alltix/channel-connectors";
import { OrderService } from "../src/index.js";
import { seedTestChannelConnection } from "../../../scripts/seed-test-channel-connection.js";
import { seedTestProductCatalog } from "../../../scripts/seed-test-product-catalog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

loadEnv({ path: join(REPO_ROOT, ".env") });

let pool: Pool;
let tenantId: string;
let productId: string;
let locationId: string;

before(async () => {
  const connectionString = process.env.APP_DATABASE_URL;
  if (!connectionString) {
    throw new Error("APP_DATABASE_URL is not set (see .env.example)");
  }
  pool = createAppPool({ connectionString });

  const seeded = await seedTestChannelConnection(pool);
  tenantId = seeded.tenantId;

  // 10 on hand comfortably covers the sandbox's 2 canned orders x 1 unit
  // each -- both should allocate for real, not backorder.
  const catalog = await seedTestProductCatalog(pool, tenantId, 10);
  productId = catalog.productId;
  locationId = catalog.locationId;
});

after(async () => {
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query("DELETE FROM inventory_events WHERE tenant_id = $1", [tenantId]);
  await admin.query("DELETE FROM orders WHERE tenant_id = $1", [tenantId]); // cascades order_lines
  await admin.query("DELETE FROM inventory_levels WHERE tenant_id = $1", [tenantId]);
  await admin.end();

  await withTenant(pool, tenantId, (client) =>
    client.query("DELETE FROM channel_listings WHERE tenant_id = $1", [tenantId]),
  );
  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM locations WHERE tenant_id = $1", [tenantId]));
  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM products WHERE tenant_id = $1", [tenantId]));
  await withTenant(pool, tenantId, (client) =>
    client.query("DELETE FROM channel_connections WHERE tenant_id = $1", [tenantId]),
  );
  await pool.end();
});

test("a real sandbox pull persists with real lines and allocates real inventory", async () => {
  const connector = await createAmazonConnectorFromChannelConnection(pool, tenantId);
  const pulled = await connector.pullOrders(SP_API_SANDBOX_TEST_CASE_CREATED_AFTER);

  assert.ok(pulled.length > 0, "sandbox should return at least one canned order");
  for (const order of pulled) {
    assert.ok(order.lines.length > 0, `order ${order.externalOrderId} must have real line items, not []`);
  }

  const orderService = new OrderService(pool);
  const result = await orderService.persistPulledOrders(tenantId, pulled);
  assert.equal(result.insertedOrderIds.length, pulled.length);

  // Every pulled order requests the sandbox's one SKU at quantity 1
  // (confirmed live against the sandbox), seeded with 10 on hand, so all
  // of them should allocate -- none backordered.
  const statuses = await withTenant(pool, tenantId, (client) =>
    client.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count FROM orders WHERE tenant_id = $1 GROUP BY status`,
      [tenantId],
    ),
  );
  const statusCounts = Object.fromEntries(statuses.rows.map((r) => [r.status, Number(r.count)]));
  assert.deepEqual(statusCounts, { allocated: pulled.length });

  const totalQuantity = pulled.reduce((sum, order) => sum + order.lines.reduce((s, l) => s + l.quantity, 0), 0);

  // Regression test for the /orders "Placed At" column showing
  // 1970-01-19T03:58:30.000Z: the sandbox's own canned PurchaseDate really
  // is that implausible value on every order (confirmed by fetching it raw,
  // bypassing this connector) -- AmazonConnector.parsePurchaseDate() must
  // turn that into null at ingestion rather than persisting/displaying it
  // as if it were a real purchase timestamp.
  const placedAtRows = await withTenant(pool, tenantId, (client) =>
    client.query<{ placed_at: Date | null }>(`SELECT placed_at FROM orders WHERE tenant_id = $1`, [tenantId]),
  );
  assert.equal(placedAtRows.rows.length, pulled.length);
  for (const row of placedAtRows.rows) {
    assert.ok(
      row.placed_at === null || row.placed_at.getFullYear() >= 2000,
      `placed_at must be null or a real-looking date, not epoch-adjacent -- got ${row.placed_at?.toISOString()}`,
    );
  }

  const lines = await withTenant(pool, tenantId, (client) =>
    client.query<{ quantity: number; unit_price: string; fulfillment_type: string; product_id: string }>(
      `SELECT ol.quantity, ol.unit_price, ol.fulfillment_type, ol.product_id
         FROM order_lines ol
         JOIN orders o ON o.id = ol.order_id
        WHERE o.tenant_id = $1`,
      [tenantId],
    ),
  );
  assert.equal(lines.rows.length, pulled.reduce((n, o) => n + o.lines.length, 0));
  for (const line of lines.rows) {
    assert.equal(line.product_id, productId, "line must resolve to the seeded product via channel_listings");
  }

  const events = await withTenant(pool, tenantId, (client) =>
    client.query<{ quantity_delta: number; reference_id: string }>(
      `SELECT quantity_delta, reference_id FROM inventory_events WHERE tenant_id = $1 AND event_type = 'reservation'`,
      [tenantId],
    ),
  );
  assert.equal(events.rows.length, pulled.length, "one reservation event per allocated order");
  const reservedTotal = events.rows.reduce((sum, e) => sum + -e.quantity_delta, 0);
  assert.equal(reservedTotal, totalQuantity, "total reserved must match the real quantities pulled from the sandbox");

  const levels = await withTenant(pool, tenantId, (client) =>
    client.query<{ on_hand: number; reserved: number; available: number }>(
      `SELECT on_hand, reserved, available FROM inventory_levels WHERE product_id = $1 AND location_id = $2`,
      [productId, locationId],
    ),
  );
  assert.deepEqual(levels.rows[0], { on_hand: 10, reserved: totalQuantity, available: 10 - totalQuantity });
});
