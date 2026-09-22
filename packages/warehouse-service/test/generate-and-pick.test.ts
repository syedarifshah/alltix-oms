// Proves the full picking workflow order-service's allocateOrder() feeds
// into: allocated -> picklist generation (deriving location from the real
// reservation event allocateOrder() wrote, not a guess) -> recordPick ->
// packOrder, including the partial-pick/damage case where CLAUDE.md §2.2
// requires a real inventory_events entry instead of a silent quantity
// fudge. Requires a live Postgres (npm run db:migrate).
//
// Run with: npm run test --workspace=@alltix/warehouse-service -- generate-and-pick

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { Client, type Pool } from "pg";
import { createAppPool, withTenant, withTenantAndUser } from "@alltix/db";
import { OrderService } from "@alltix/order-service";
import { WarehouseService } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

loadEnv({ path: join(REPO_ROOT, ".env") });

let pool: Pool;
const tenantId = randomUUID();
let locationId: string;
let orderService: OrderService;
let warehouseService: WarehouseService;

before(async () => {
  const connectionString = process.env.APP_DATABASE_URL;
  if (!connectionString) {
    throw new Error("APP_DATABASE_URL is not set (see .env.example)");
  }
  pool = createAppPool({ connectionString });
  orderService = new OrderService(pool);
  warehouseService = new WarehouseService(pool, orderService);

  locationId = await withTenant(pool, tenantId, async (client) => {
    const location = await client.query<{ id: string }>(
      `INSERT INTO locations (tenant_id, name, type) VALUES ($1, 'Picklist Test Warehouse', 'warehouse') RETURNING id`,
      [tenantId],
    );
    return location.rows[0]!.id;
  });
});

after(async () => {
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query("DELETE FROM audit_log WHERE tenant_id = $1", [tenantId]);
  await admin.query("DELETE FROM picklist_lines WHERE tenant_id = $1", [tenantId]);
  await admin.query("DELETE FROM picklists WHERE tenant_id = $1", [tenantId]);
  await admin.query("DELETE FROM inventory_events WHERE tenant_id = $1", [tenantId]);
  await admin.query("DELETE FROM orders WHERE tenant_id = $1", [tenantId]); // cascades order_lines
  await admin.query("DELETE FROM inventory_levels WHERE tenant_id = $1", [tenantId]);
  await admin.query("DELETE FROM users WHERE tenant_id = $1", [tenantId]);
  await admin.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
  await admin.end();

  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM locations WHERE tenant_id = $1", [tenantId]));
  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM products WHERE tenant_id = $1", [tenantId]));
  await pool.end();
});

/**
 * Seeds one product with on-hand stock and one order for it, then runs it
 * through the real OrderService.transition('validated' -> 'allocated')
 * path -- not a hand-built reservation row -- so the reservation event
 * generatePicklist() relies on for its location lookup is the real thing
 * allocateOrder() writes, not a second, parallel fixture shape.
 */
async function seedAllocatedOrder(
  onHand: number,
  quantity: number,
): Promise<{ productId: string; orderId: string; orderLineId: string }> {
  const seeded = await withTenant(pool, tenantId, async (client) => {
    const product = await client.query<{ id: string }>(
      `INSERT INTO products (tenant_id, internal_sku, name) VALUES ($1, $2, 'Picklist Test Product') RETURNING id`,
      [tenantId, `SKU-${randomUUID().slice(0, 8)}`],
    );
    const productId = product.rows[0]!.id;

    await client.query(
      `INSERT INTO inventory_levels (tenant_id, product_id, location_id, on_hand, reserved) VALUES ($1, $2, $3, $4, 0)`,
      [tenantId, productId, locationId, onHand],
    );

    const order = await client.query<{ id: string }>(
      `INSERT INTO orders (tenant_id, channel, external_order_id, status) VALUES ($1, 'amazon', $2, 'validated') RETURNING id`,
      [tenantId, `PICKLIST-TEST-${randomUUID()}`],
    );
    const orderId = order.rows[0]!.id;

    const line = await client.query<{ id: string }>(
      `INSERT INTO order_lines (tenant_id, order_id, product_id, quantity, unit_price, fulfillment_type)
       VALUES ($1, $2, $3, $4, 9.99, 'seller_fulfilled') RETURNING id`,
      [tenantId, orderId, productId, quantity],
    );

    return { productId, orderId, orderLineId: line.rows[0]!.id };
  });

  const status = await orderService.transition(tenantId, seeded.orderId, "validated", "allocated");
  assert.equal(status, "allocated", "test setup requires successful allocation");
  return seeded;
}

test("generatePicklist groups an allocated order's lines under one picklist at the reservation's location, and transitions the order to picking", async () => {
  const { productId, orderId, orderLineId } = await seedAllocatedOrder(10, 3);

  const picklists = await warehouseService.generatePicklist(tenantId, [orderId]);
  assert.equal(picklists.length, 1);
  const picklist = picklists[0]!;
  assert.equal(picklist.locationId, locationId);
  assert.equal(picklist.status, "open");
  assert.deepEqual(picklist.orderIds, [orderId]);
  assert.equal(picklist.lines.length, 1);
  assert.equal(picklist.lines[0]?.orderLineId, orderLineId);
  assert.equal(picklist.lines[0]?.productId, productId);
  assert.equal(picklist.lines[0]?.quantityRequested, 3);
  assert.equal(picklist.lines[0]?.status, "pending");

  const orderRow = await withTenant(pool, tenantId, (client) =>
    client.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [orderId]),
  );
  assert.equal(orderRow.rows[0]?.status, "picking");
});

test("a fully picked and packed order makes no ledger correction and ends up 'packed'", async () => {
  const { productId, orderId } = await seedAllocatedOrder(10, 3);
  const [picklist] = await warehouseService.generatePicklist(tenantId, [orderId]);
  await warehouseService.assignPicklist(tenantId, picklist!.id, await seedPicker());
  await warehouseService.recordPick(tenantId, picklist!.lines[0]!.id, 3);

  await warehouseService.packOrder(tenantId, orderId);

  const orderRow = await withTenant(pool, tenantId, (client) =>
    client.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [orderId]),
  );
  assert.equal(orderRow.rows[0]?.status, "packed");

  const picklistRow = await withTenant(pool, tenantId, (client) =>
    client.query<{ status: string }>("SELECT status FROM picklists WHERE id = $1", [picklist!.id]),
  );
  assert.equal(picklistRow.rows[0]?.status, "completed");

  const levels = await withTenant(pool, tenantId, (client) =>
    client.query<{ on_hand: number; reserved: number }>(
      `SELECT on_hand, reserved FROM inventory_levels WHERE product_id = $1 AND location_id = $2`,
      [productId, locationId],
    ),
  );
  assert.deepEqual(
    levels.rows[0],
    { on_hand: 10, reserved: 3 },
    "a full pick makes no ledger correction -- reserved stays exactly as allocateOrder() left it",
  );
});

test("a short pick logs an 'adjustment' inventory_events entry and releases the shortfall from on_hand and reserved", async () => {
  const { productId, orderId } = await seedAllocatedOrder(10, 5);
  const [picklist] = await warehouseService.generatePicklist(tenantId, [orderId]);
  await warehouseService.assignPicklist(tenantId, picklist!.id, await seedPicker());
  await warehouseService.recordPick(tenantId, picklist!.lines[0]!.id, 3); // 2 short, not damaged

  await warehouseService.packOrder(tenantId, orderId);

  const levels = await withTenant(pool, tenantId, (client) =>
    client.query<{ on_hand: number; reserved: number }>(
      `SELECT on_hand, reserved FROM inventory_levels WHERE product_id = $1 AND location_id = $2`,
      [productId, locationId],
    ),
  );
  assert.deepEqual(levels.rows[0], { on_hand: 8, reserved: 3 }, "the missing 2 units come off both on_hand and reserved");

  const events = await withTenant(pool, tenantId, (client) =>
    client.query<{ quantity_delta: number }>(
      `SELECT quantity_delta FROM inventory_events WHERE tenant_id = $1 AND product_id = $2 AND event_type = 'adjustment'`,
      [tenantId, productId],
    ),
  );
  assert.equal(events.rows.length, 1);
  assert.equal(events.rows[0]?.quantity_delta, -2);
});

test("a damaged pick logs a 'damage' inventory_events entry instead of 'adjustment'", async () => {
  const { productId, orderId } = await seedAllocatedOrder(10, 4);
  const [picklist] = await warehouseService.generatePicklist(tenantId, [orderId]);
  await warehouseService.assignPicklist(tenantId, picklist!.id, await seedPicker());
  await warehouseService.recordPick(tenantId, picklist!.lines[0]!.id, 1, true); // 3 short, damaged

  await warehouseService.packOrder(tenantId, orderId);

  const adjustmentEvents = await withTenant(pool, tenantId, (client) =>
    client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_events WHERE tenant_id = $1 AND product_id = $2 AND event_type = 'adjustment'`,
      [tenantId, productId],
    ),
  );
  assert.equal(adjustmentEvents.rows[0]?.count, "0", "a damaged shortfall must not also log an 'adjustment' event");

  const damageEvents = await withTenant(pool, tenantId, (client) =>
    client.query<{ quantity_delta: number }>(
      `SELECT quantity_delta FROM inventory_events WHERE tenant_id = $1 AND product_id = $2 AND event_type = 'damage'`,
      [tenantId, productId],
    ),
  );
  assert.equal(damageEvents.rows.length, 1);
  assert.equal(damageEvents.rows[0]?.quantity_delta, -3);
});

test("packOrder refuses to pack while any picklist line is still pending", async () => {
  const { orderId } = await seedAllocatedOrder(10, 2);
  await warehouseService.generatePicklist(tenantId, [orderId]);
  // No assignPicklist/recordPick -- the line is still 'pending'.

  await assert.rejects(() => warehouseService.packOrder(tenantId, orderId), /not yet picked/);
});

test("generatePicklist spanning two orders at the same location produces one shared picklist", async () => {
  const seededA = await seedAllocatedOrder(20, 2);
  const seededB = await seedAllocatedOrder(20, 3);

  const picklists = await warehouseService.generatePicklist(tenantId, [seededA.orderId, seededB.orderId]);
  assert.equal(picklists.length, 1);
  assert.equal(picklists[0]!.lines.length, 2);
  assert.deepEqual([...picklists[0]!.orderIds].sort(), [seededA.orderId, seededB.orderId].sort());
});

/** Seeds one real tenants + users row (picklists.assigned_to is a real FK
 *  to users.id, migration 0013) so assignPicklist() has a genuine user to
 *  point at, the same way tenant-isolation.e2e.test.ts seeds real
 *  tenant/user rows rather than an arbitrary string. ON CONFLICT DO NOTHING
 *  on the tenants insert since multiple calls in this file share one tenantId. */
async function seedPicker(): Promise<string> {
  const clerkUserId = `picker-${randomUUID()}`;
  return withTenantAndUser(pool, { tenantId, clerkUserId }, async (client) => {
    await client.query(`INSERT INTO tenants (id, name) VALUES ($1, 'Picklist Test Tenant') ON CONFLICT (id) DO NOTHING`, [
      tenantId,
    ]);
    const user = await client.query<{ id: string }>(
      `INSERT INTO users (tenant_id, clerk_user_id, email) VALUES ($1, $2, $3) RETURNING id`,
      [tenantId, clerkUserId, `${clerkUserId}@example.com`],
    );
    return user.rows[0]!.id;
  });
}
