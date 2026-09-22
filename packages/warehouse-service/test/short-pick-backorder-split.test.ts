// Proves WarehouseService.packOrder()'s SHORT-PICK SPLIT -- the resolution
// of CLAUDE.md §3's former OPEN PRODUCT DECISION (Arif's call: split into a
// partial shipment + backorder, not silently ship-what-was-picked or hold
// the whole order). Continues past generate-and-pick.test.ts's own
// short-pick coverage (which only asserts the ledger correction) into the
// new order/order_lines split behavior.
//
// Requires a live Postgres (npm run db:migrate).
//
// Run with: npm run test --workspace=@alltix/warehouse-service -- short-pick-backorder-split

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { Client, type Pool } from "pg";
import { createAppPool, withTenant, withTenantAndUser } from "@alltix/db";
import { InProcessEventBus, type DomainEventEnvelope } from "@alltix/shared";
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
let eventBus: InProcessEventBus;
let publishedEvents: DomainEventEnvelope[];

before(async () => {
  const connectionString = process.env.APP_DATABASE_URL;
  if (!connectionString) {
    throw new Error("APP_DATABASE_URL is not set (see .env.example)");
  }
  pool = createAppPool({ connectionString });
  orderService = new OrderService(pool);
  eventBus = new InProcessEventBus();
  publishedEvents = [];
  for (const name of ["order.backordered", "order.cancelled", "order.split_for_backorder"] as const) {
    eventBus.subscribe(name, (event) => {
      publishedEvents.push(event as DomainEventEnvelope);
    });
  }
  warehouseService = new WarehouseService(pool, orderService, eventBus);

  locationId = await withTenant(pool, tenantId, async (client) => {
    const location = await client.query<{ id: string }>(
      `INSERT INTO locations (tenant_id, name, type) VALUES ($1, 'Backorder Split Test Warehouse', 'warehouse') RETURNING id`,
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

/** Seeds one order with `quantities.length` order_lines, each for its own
 *  fresh product, allocated for real via OrderService.transition() (same
 *  "the reservation must be the real thing, not a hand-built fixture" style
 *  as generate-and-pick.test.ts's own seedAllocatedOrder). */
async function seedAllocatedOrderWithLines(
  quantities: number[],
): Promise<{ orderId: string; externalOrderId: string; productIds: string[]; orderLineIds: string[] }> {
  const externalOrderId = `BACKORDER-SPLIT-TEST-${randomUUID()}`;
  const seeded = await withTenant(pool, tenantId, async (client) => {
    const order = await client.query<{ id: string }>(
      `INSERT INTO orders (tenant_id, channel, external_order_id, status, customer, shipping_address)
       VALUES ($1, 'amazon', $2, 'validated', $3, $4) RETURNING id`,
      [
        tenantId,
        externalOrderId,
        JSON.stringify({ name: "Test Customer" }),
        JSON.stringify({ line1: "1 Test St" }),
      ],
    );
    const orderId = order.rows[0]!.id;

    const productIds: string[] = [];
    const orderLineIds: string[] = [];
    for (const quantity of quantities) {
      const product = await client.query<{ id: string }>(
        `INSERT INTO products (tenant_id, internal_sku, name) VALUES ($1, $2, 'Backorder Split Test Product') RETURNING id`,
        [tenantId, `SKU-${randomUUID().slice(0, 8)}`],
      );
      const productId = product.rows[0]!.id;
      productIds.push(productId);

      await client.query(
        `INSERT INTO inventory_levels (tenant_id, product_id, location_id, on_hand, reserved) VALUES ($1, $2, $3, $4, 0)`,
        [tenantId, productId, locationId, quantity],
      );

      const line = await client.query<{ id: string }>(
        `INSERT INTO order_lines (tenant_id, order_id, product_id, quantity, unit_price, fulfillment_type)
         VALUES ($1, $2, $3, $4, 12.50, 'seller_fulfilled') RETURNING id`,
        [tenantId, orderId, productId, quantity],
      );
      orderLineIds.push(line.rows[0]!.id);
    }

    return { orderId, productIds, orderLineIds };
  });

  const status = await orderService.transition(tenantId, seeded.orderId, "validated", "allocated");
  assert.equal(status, "allocated", "test setup requires successful allocation");
  return { ...seeded, externalOrderId };
}

async function pickAndPack(orderId: string, picks: number[]): Promise<void> {
  const [picklist] = await warehouseService.generatePicklist(tenantId, [orderId]);
  await warehouseService.assignPicklist(tenantId, picklist!.id, await seedPicker());
  for (let i = 0; i < picklist!.lines.length; i++) {
    await warehouseService.recordPick(tenantId, picklist!.lines[i]!.id, picks[i]!);
  }
  await warehouseService.packOrder(tenantId, orderId);
}

test("a partially short-picked line reduces the original order_line and spins off a backorder for just the shortfall", async () => {
  const { orderId, externalOrderId, productIds, orderLineIds } = await seedAllocatedOrderWithLines([5]);
  publishedEvents.length = 0;

  await pickAndPack(orderId, [3]); // 2 short

  const originalOrder = await withTenant(pool, tenantId, (client) =>
    client.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [orderId]),
  );
  assert.equal(originalOrder.rows[0]?.status, "packed", "a partial pick still ships what was picked");

  const originalLine = await withTenant(pool, tenantId, (client) =>
    client.query<{ quantity: number }>("SELECT quantity FROM order_lines WHERE id = $1", [orderLineIds[0]]),
  );
  assert.equal(originalLine.rows[0]?.quantity, 3, "the original line's quantity must be reduced to what was actually picked");

  const backorder = await withTenant(pool, tenantId, (client) =>
    client.query<{ id: string; status: string; channel: string; external_order_id: string; split_from_order_id: string }>(
      "SELECT id, status, channel, external_order_id, split_from_order_id FROM orders WHERE split_from_order_id = $1",
      [orderId],
    ),
  );
  assert.equal(backorder.rows.length, 1, "exactly one backorder order must be spun off");
  const backorderOrder = backorder.rows[0]!;
  assert.equal(backorderOrder.status, "backordered");
  assert.equal(backorderOrder.channel, "amazon", "the backorder inherits the original order's channel");
  assert.equal(backorderOrder.external_order_id, `${externalOrderId}:backorder`);

  const backorderLines = await withTenant(pool, tenantId, (client) =>
    client.query<{ product_id: string; quantity: number; unit_price: string; fulfillment_type: string }>(
      "SELECT product_id, quantity, unit_price, fulfillment_type FROM order_lines WHERE order_id = $1",
      [backorderOrder.id],
    ),
  );
  assert.equal(backorderLines.rows.length, 1);
  assert.equal(backorderLines.rows[0]?.product_id, productIds[0]);
  assert.equal(backorderLines.rows[0]?.quantity, 2, "the backorder line must carry exactly the shortfall");
  assert.equal(backorderLines.rows[0]?.unit_price, "12.50");
  assert.equal(backorderLines.rows[0]?.fulfillment_type, "seller_fulfilled");

  const eventNames = publishedEvents.map((e) => e.name).sort();
  assert.deepEqual(eventNames, ["order.backordered", "order.split_for_backorder"]);
  const splitEvent = publishedEvents.find((e) => e.name === "order.split_for_backorder");
  assert.deepEqual(splitEvent?.payload, {
    originalOrderId: orderId,
    backorderOrderId: backorderOrder.id,
    originalOrderCancelled: false,
    lines: [{ productId: productIds[0], quantity: 2 }],
  });
});

test("a multi-line order with one full pick and one short pick keeps the untouched line intact on the original order", async () => {
  const { orderId, productIds, orderLineIds } = await seedAllocatedOrderWithLines([4, 6]);

  await pickAndPack(orderId, [4, 2]); // line 0 fully picked, line 1 short by 4

  const originalLines = await withTenant(pool, tenantId, (client) =>
    client.query<{ id: string; product_id: string; quantity: number }>(
      "SELECT id, product_id, quantity FROM order_lines WHERE order_id = $1 ORDER BY quantity DESC",
      [orderId],
    ),
  );
  // The fully-picked line survives completely untouched; the short line was
  // reduced to what was actually picked -- both still belong to the
  // original (now packed) order.
  assert.deepEqual(
    originalLines.rows.map((r) => r.quantity).sort((a, b) => a - b),
    [2, 4],
  );

  const originalOrder = await withTenant(pool, tenantId, (client) =>
    client.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [orderId]),
  );
  assert.equal(originalOrder.rows[0]?.status, "packed");

  const backorderLines = await withTenant(pool, tenantId, (client) =>
    client.query<{ product_id: string; quantity: number }>(
      `SELECT ol.product_id, ol.quantity FROM order_lines ol
         JOIN orders o ON o.id = ol.order_id
        WHERE o.split_from_order_id = $1`,
      [orderId],
    ),
  );
  assert.equal(backorderLines.rows.length, 1, "only the short line should appear on the backorder");
  assert.equal(backorderLines.rows[0]?.product_id, productIds[1]);
  assert.equal(backorderLines.rows[0]?.quantity, 4);
  void orderLineIds;
});

test("an order short-picked to zero on every line is cancelled outright, with its entire content moved to the backorder", async () => {
  const { orderId, productIds } = await seedAllocatedOrderWithLines([3]);
  publishedEvents.length = 0;

  await pickAndPack(orderId, [0]); // nothing picked at all

  const originalOrder = await withTenant(pool, tenantId, (client) =>
    client.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [orderId]),
  );
  assert.equal(
    originalOrder.rows[0]?.status,
    "cancelled",
    "an order with nothing left to ship must be cancelled, not packed as an empty shipment",
  );

  const remainingLines = await withTenant(pool, tenantId, (client) =>
    client.query<{ count: string }>("SELECT count(*)::text AS count FROM order_lines WHERE order_id = $1", [orderId]),
  );
  assert.equal(remainingLines.rows[0]?.count, "0", "the original order_line must be deleted, not left at quantity 0");

  const backorderLines = await withTenant(pool, tenantId, (client) =>
    client.query<{ product_id: string; quantity: number }>(
      `SELECT ol.product_id, ol.quantity FROM order_lines ol
         JOIN orders o ON o.id = ol.order_id
        WHERE o.split_from_order_id = $1`,
      [orderId],
    ),
  );
  assert.equal(backorderLines.rows.length, 1);
  assert.equal(backorderLines.rows[0]?.product_id, productIds[0]);
  assert.equal(backorderLines.rows[0]?.quantity, 3, "the full requested quantity moves to the backorder, nothing was picked");

  const levels = await withTenant(pool, tenantId, (client) =>
    client.query<{ on_hand: number; reserved: number }>(
      `SELECT on_hand, reserved FROM inventory_levels WHERE product_id = $1 AND location_id = $2`,
      [productIds[0], locationId],
    ),
  );
  assert.deepEqual(levels.rows[0], { on_hand: 0, reserved: 0 }, "the ledger correction already released the full reservation");

  const eventNames = publishedEvents.map((e) => e.name).sort();
  assert.deepEqual(eventNames, ["order.backordered", "order.cancelled", "order.split_for_backorder"]);
  const splitEvent = publishedEvents.find((e) => e.name === "order.split_for_backorder");
  assert.equal(
    (splitEvent?.payload as { originalOrderCancelled: boolean } | undefined)?.originalOrderCancelled,
    true,
  );
});

test("the new backorder order can be retried through the ordinary 'backordered' -> 'allocated' path once stock arrives", async () => {
  const { orderId, productIds } = await seedAllocatedOrderWithLines([2]);
  await pickAndPack(orderId, [0]);

  const backorder = await withTenant(pool, tenantId, (client) =>
    client.query<{ id: string }>("SELECT id FROM orders WHERE split_from_order_id = $1", [orderId]),
  );
  const backorderOrderId = backorder.rows[0]!.id;

  // Stock wasn't there at pick time (that's what made it short) -- simulate
  // it arriving via a real receipt-style ledger top-up before retrying.
  await withTenant(pool, tenantId, (client) =>
    client.query(`UPDATE inventory_levels SET on_hand = on_hand + 2 WHERE product_id = $1 AND location_id = $2`, [
      productIds[0],
      locationId,
    ]),
  );

  const status = await orderService.transition(tenantId, backorderOrderId, "backordered", "allocated");
  assert.equal(status, "allocated", "the backorder order must be an ordinary, retryable backordered order");
});

/** Same tenant/user seeding as generate-and-pick.test.ts's own seedPicker. */
async function seedPicker(): Promise<string> {
  const clerkUserId = `picker-${randomUUID()}`;
  return withTenantAndUser(pool, { tenantId, clerkUserId }, async (client) => {
    await client.query(`INSERT INTO tenants (id, name) VALUES ($1, 'Backorder Split Test Tenant') ON CONFLICT (id) DO NOTHING`, [
      tenantId,
    ]);
    const user = await client.query<{ id: string }>(
      `INSERT INTO users (tenant_id, clerk_user_id, email) VALUES ($1, $2, $3) RETURNING id`,
      [tenantId, clerkUserId, `${clerkUserId}@example.com`],
    );
    return user.rows[0]!.id;
  });
}
