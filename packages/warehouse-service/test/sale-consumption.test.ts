// Proves the sale-consumption fix (recordShipmentSaleEvents, see its own
// doc comment in src/index.ts for the gap it closes: a fully-picked,
// successfully-shipped order never used to consume any inventory at all).
// Exercised directly rather than through confirmShipment() -- confirmShipment()
// needs a live, successfully-confirming marketplace connection this repo
// doesn't have for any channel (see that method's own doc comment and
// confirm-shipment-e2e.test.ts, which only ever reaches a documented sandbox
// failure) -- but recordShipmentSaleEvents() is exported standalone
// specifically so this can be proven without one, the same "exported for
// testability" precedent packages/scheduler/src/index.ts's
// recordSyncFailure/recordSyncSuccess already set.
//
// Requires a live Postgres (npm run db:migrate).
//
// Run with: npm run test --workspace=@alltix/warehouse-service -- sale-consumption

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { Client, type Pool } from "pg";
import { createAppPool, withTenant, withTenantAndUser } from "@alltix/db";
import { InventoryService } from "@alltix/inventory-service";
import { OrderService } from "@alltix/order-service";
import { DomainEvent, InProcessEventBus, type InventoryChangedPayload } from "@alltix/shared";
import { WarehouseService, recordShipmentSaleEvents } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

loadEnv({ path: join(REPO_ROOT, ".env") });

let pool: Pool;
let inventoryService: InventoryService;
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
  inventoryService = new InventoryService(pool);
  orderService = new OrderService(pool);
  warehouseService = new WarehouseService(pool, orderService);

  locationId = await withTenant(pool, tenantId, async (client) => {
    const location = await client.query<{ id: string }>(
      `INSERT INTO locations (tenant_id, name, type) VALUES ($1, 'Sale Consumption Test Warehouse', 'warehouse') RETURNING id`,
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

/** Same shape as generate-and-pick.test.ts's seedAllocatedOrder -- runs a
 *  real order through allocateOrder() so the 'reservation' event
 *  recordShipmentSaleEvents() looks up is the real thing, not a parallel
 *  fixture shape. */
async function seedAllocatedOrder(onHand: number, quantity: number): Promise<{ productId: string; orderId: string }> {
  const seeded = await withTenant(pool, tenantId, async (client) => {
    const product = await client.query<{ id: string }>(
      `INSERT INTO products (tenant_id, internal_sku, name) VALUES ($1, $2, 'Sale Consumption Test Product') RETURNING id`,
      [tenantId, `SKU-${randomUUID().slice(0, 8)}`],
    );
    const productId = product.rows[0]!.id;

    await client.query(
      `INSERT INTO inventory_levels (tenant_id, product_id, location_id, on_hand, reserved) VALUES ($1, $2, $3, $4, 0)`,
      [tenantId, productId, locationId, onHand],
    );

    const order = await client.query<{ id: string }>(
      `INSERT INTO orders (tenant_id, channel, external_order_id, status) VALUES ($1, 'amazon', $2, 'validated') RETURNING id`,
      [tenantId, `SALE-CONSUMPTION-TEST-${randomUUID()}`],
    );
    const orderId = order.rows[0]!.id;

    await client.query(
      `INSERT INTO order_lines (tenant_id, order_id, product_id, quantity, unit_price, fulfillment_type)
       VALUES ($1, $2, $3, $4, 9.99, 'seller_fulfilled')`,
      [tenantId, orderId, productId, quantity],
    );

    return { productId, orderId };
  });

  const status = await orderService.transition(tenantId, seeded.orderId, "validated", "allocated");
  assert.equal(status, "allocated", "test setup requires successful allocation");
  return seeded;
}

/** Same shape as generate-and-pick.test.ts's own seedPicker -- picklists.assigned_to
 *  is a real FK to users(id), so this needs a real seeded user, not a bare UUID. */
async function seedPicker(): Promise<string> {
  const clerkUserId = `picker-${randomUUID()}`;
  return withTenantAndUser(pool, { tenantId, clerkUserId }, async (client) => {
    await client.query(`INSERT INTO tenants (id, name) VALUES ($1, 'Sale Consumption Test Tenant') ON CONFLICT (id) DO NOTHING`, [
      tenantId,
    ]);
    const user = await client.query<{ id: string }>(
      `INSERT INTO users (tenant_id, clerk_user_id, email) VALUES ($1, $2, $3) RETURNING id`,
      [tenantId, clerkUserId, `${clerkUserId}@example.com`],
    );
    return user.rows[0]!.id;
  });
}

async function levelsOf(productId: string): Promise<{ on_hand: number; reserved: number }> {
  const result = await withTenant(pool, tenantId, (client) =>
    client.query<{ on_hand: number; reserved: number }>(
      `SELECT on_hand, reserved FROM inventory_levels WHERE product_id = $1 AND location_id = $2`,
      [productId, locationId],
    ),
  );
  return result.rows[0]!;
}

test("recordShipmentSaleEvents consumes on_hand and releases reserved together, for a fully-picked order", async () => {
  const { productId, orderId } = await seedAllocatedOrder(10, 3);
  const [picklist] = await warehouseService.generatePicklist(tenantId, [orderId]);
  await warehouseService.assignPicklist(tenantId, picklist!.id, await seedPicker());
  await warehouseService.recordPick(tenantId, picklist!.lines[0]!.id, 3);
  await warehouseService.packOrder(tenantId, orderId);

  assert.deepEqual(await levelsOf(productId), { on_hand: 10, reserved: 3 }, "sanity check: packing alone never touches the ledger for a full pick");

  await recordShipmentSaleEvents(pool, inventoryService, tenantId, orderId);

  assert.deepEqual(
    await levelsOf(productId),
    { on_hand: 7, reserved: 0 },
    "shipping must consume on_hand and release the matching reserved together",
  );

  const saleEvent = await withTenant(pool, tenantId, (client) =>
    client.query<{ event_type: string; quantity_delta: number; reference_type: string }>(
      `SELECT event_type, quantity_delta, reference_type FROM inventory_events
        WHERE tenant_id = $1 AND reference_id = $2 AND event_type = 'sale'`,
      [tenantId, orderId],
    ),
  );
  assert.equal(saleEvent.rows.length, 1);
  assert.equal(saleEvent.rows[0]?.quantity_delta, -3);
  assert.equal(saleEvent.rows[0]?.reference_type, "order");
});

test("recordShipmentSaleEvents' sale consumption publishes inventory.changed on WarehouseService's own shared eventBus -- proving the real (not test-only) production wiring", async () => {
  const eventBus = new InProcessEventBus();
  const published: InventoryChangedPayload[] = [];
  eventBus.subscribe<InventoryChangedPayload>(DomainEvent.InventoryChanged, (event) => {
    published.push(event.payload);
  });
  // A second InventoryService/WarehouseService pair sharing `eventBus`,
  // exactly the shape a real caller (scheduler, a web route) would use to
  // let a future subscriber (a low-stock notifier, analytics) see these --
  // see WarehouseService's own constructor doc comment for why its
  // InventoryService shares this bus rather than getting a private one.
  const sharedInventoryService = new InventoryService(pool, eventBus);
  const sharedWarehouseService = new WarehouseService(pool, orderService, eventBus);

  const { productId, orderId } = await seedAllocatedOrder(10, 2);
  const [picklist] = await sharedWarehouseService.generatePicklist(tenantId, [orderId]);
  await sharedWarehouseService.assignPicklist(tenantId, picklist!.id, await seedPicker());
  await sharedWarehouseService.recordPick(tenantId, picklist!.lines[0]!.id, 2);
  await sharedWarehouseService.packOrder(tenantId, orderId);

  await recordShipmentSaleEvents(pool, sharedInventoryService, tenantId, orderId);

  const saleEvents = published.filter((p) => p.eventType === "sale" && p.productId === productId);
  assert.equal(saleEvents.length, 1);
  assert.deepEqual(saleEvents[0], { productId, locationId, eventType: "sale", onHand: 8, reserved: 0, available: 8 });
});

test("recordShipmentSaleEvents sells the reduced (short-picked) quantity, not the original request", async () => {
  const { productId, orderId } = await seedAllocatedOrder(10, 5);
  const [picklist] = await warehouseService.generatePicklist(tenantId, [orderId]);
  await warehouseService.assignPicklist(tenantId, picklist!.id, await seedPicker());
  await warehouseService.recordPick(tenantId, picklist!.lines[0]!.id, 2); // short-picked: 2 of 5
  await warehouseService.packOrder(tenantId, orderId);

  // packOrder's short-pick correction already took the missing 3 off
  // on_hand/reserved as an 'adjustment' -- 10 - 3 = 7 on_hand, 5 - 3 = 2
  // reserved (still covering the 2 that really were picked).
  assert.deepEqual(await levelsOf(productId), { on_hand: 7, reserved: 2 });

  await recordShipmentSaleEvents(pool, inventoryService, tenantId, orderId);

  assert.deepEqual(
    await levelsOf(productId),
    { on_hand: 5, reserved: 0 },
    "must sell exactly the 2 units actually shipped, not the original 5",
  );
});

test("recordShipmentSaleEvents is idempotent -- calling it twice for the same order doesn't double-consume", async () => {
  const { productId, orderId } = await seedAllocatedOrder(10, 4);
  const [picklist] = await warehouseService.generatePicklist(tenantId, [orderId]);
  await warehouseService.assignPicklist(tenantId, picklist!.id, await seedPicker());
  await warehouseService.recordPick(tenantId, picklist!.lines[0]!.id, 4);
  await warehouseService.packOrder(tenantId, orderId);

  await recordShipmentSaleEvents(pool, inventoryService, tenantId, orderId);
  await recordShipmentSaleEvents(pool, inventoryService, tenantId, orderId);

  assert.deepEqual(await levelsOf(productId), { on_hand: 6, reserved: 0 }, "a second call must be a safe no-op");
});

test("recordShipmentSaleEvents on a zero-line order is a correct no-op", async () => {
  const orderId = await withTenant(pool, tenantId, async (client) => {
    const order = await client.query<{ id: string }>(
      `INSERT INTO orders (tenant_id, channel, external_order_id, status) VALUES ($1, 'amazon', $2, 'packed') RETURNING id`,
      [tenantId, `SALE-CONSUMPTION-ZERO-LINE-${randomUUID()}`],
    );
    return order.rows[0]!.id;
  });

  await assert.doesNotReject(() => recordShipmentSaleEvents(pool, inventoryService, tenantId, orderId));
});
