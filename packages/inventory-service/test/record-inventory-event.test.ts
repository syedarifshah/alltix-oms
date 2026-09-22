// Proves InventoryService.recordInventoryEvent()/getAvailableToSell() --
// the stock ledger CLAUDE.md §2.2 calls the most important table in the
// system -- against a real Postgres, for every eventType that has a
// well-defined single-location column mapping (see the class's own doc
// comment for why 'transfer' is excluded and thrown instead).
//
// Requires a live Postgres (npm run db:migrate).
//
// Run with: npm run test --workspace=@alltix/inventory-service

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { Client, type Pool } from "pg";
import { createAppPool, withTenant } from "@alltix/db";
import { DomainEvent, InProcessEventBus, type InventoryChangedPayload } from "@alltix/shared";
import { InventoryService } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

loadEnv({ path: join(REPO_ROOT, ".env") });

let pool: Pool;
const tenantId = randomUUID();
let locationId: string;

async function seedProduct(sku: string): Promise<string> {
  return withTenant(pool, tenantId, async (client) => {
    const product = await client.query<{ id: string }>(
      `INSERT INTO products (tenant_id, internal_sku, name) VALUES ($1, $2, $3) RETURNING id`,
      [tenantId, sku, sku],
    );
    return product.rows[0]!.id;
  });
}

async function levelsFor(productId: string): Promise<{ on_hand: number; reserved: number; available: number } | undefined> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query<{ on_hand: number; reserved: number; available: number }>(
      `SELECT on_hand, reserved, available FROM inventory_levels WHERE product_id = $1 AND location_id = $2`,
      [productId, locationId],
    );
    return result.rows[0];
  });
}

before(async () => {
  const connectionString = process.env.APP_DATABASE_URL;
  if (!connectionString) {
    throw new Error("APP_DATABASE_URL is not set (see .env.example)");
  }
  pool = createAppPool({ connectionString });

  const location = await withTenant(pool, tenantId, (client) =>
    client.query<{ id: string }>(
      `INSERT INTO locations (tenant_id, name, type) VALUES ($1, 'Inventory Service Test Warehouse', 'warehouse') RETURNING id`,
      [tenantId],
    ),
  );
  locationId = location.rows[0]!.id;
});

after(async () => {
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query("DELETE FROM inventory_events WHERE tenant_id = $1", [tenantId]);
  await admin.query("DELETE FROM inventory_levels WHERE tenant_id = $1", [tenantId]);
  await admin.end();

  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM products WHERE tenant_id = $1", [tenantId]));
  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM locations WHERE tenant_id = $1", [tenantId]));
  await pool.end();
});

test("a 'receipt' event creates inventory_levels on the fly and increments on_hand only", async () => {
  const productId = await seedProduct(`RECEIPT-${randomUUID().slice(0, 8)}`);
  const inventoryService = new InventoryService(pool);

  const result = await inventoryService.recordInventoryEvent({
    tenantId,
    productId,
    locationId,
    eventType: "receipt",
    quantityDelta: 10,
    referenceType: "po",
    idempotencyKey: `receipt:${productId}`,
  });

  assert.equal(result.applied, true);
  assert.deepEqual(await levelsFor(productId), { on_hand: 10, reserved: 0, available: 10 });
  assert.equal(await inventoryService.getAvailableToSell(tenantId, productId, locationId), 10);
});

test("'reservation' then 'release' round-trips available back to where it started", async () => {
  const productId = await seedProduct(`RESRELEASE-${randomUUID().slice(0, 8)}`);
  const inventoryService = new InventoryService(pool);

  await inventoryService.recordInventoryEvent({
    tenantId,
    productId,
    locationId,
    eventType: "receipt",
    quantityDelta: 5,
    idempotencyKey: `receipt:${productId}`,
  });

  await inventoryService.recordInventoryEvent({
    tenantId,
    productId,
    locationId,
    eventType: "reservation",
    quantityDelta: -3,
    referenceType: "order",
    idempotencyKey: `reservation:${productId}`,
  });
  assert.deepEqual(await levelsFor(productId), { on_hand: 5, reserved: 3, available: 2 });

  await inventoryService.recordInventoryEvent({
    tenantId,
    productId,
    locationId,
    eventType: "release",
    quantityDelta: 3,
    referenceType: "order",
    idempotencyKey: `release:${productId}`,
  });
  assert.deepEqual(await levelsFor(productId), { on_hand: 5, reserved: 0, available: 5 });
});

test("a 'sale' event consumes on_hand and the reservation covering it together", async () => {
  const productId = await seedProduct(`SALE-${randomUUID().slice(0, 8)}`);
  const inventoryService = new InventoryService(pool);

  await inventoryService.recordInventoryEvent({
    tenantId,
    productId,
    locationId,
    eventType: "receipt",
    quantityDelta: 4,
    idempotencyKey: `receipt:${productId}`,
  });
  await inventoryService.recordInventoryEvent({
    tenantId,
    productId,
    locationId,
    eventType: "reservation",
    quantityDelta: -4,
    referenceType: "order",
    idempotencyKey: `reservation:${productId}`,
  });

  await inventoryService.recordInventoryEvent({
    tenantId,
    productId,
    locationId,
    eventType: "sale",
    quantityDelta: -4,
    referenceType: "order",
    idempotencyKey: `sale:${productId}`,
  });

  assert.deepEqual(await levelsFor(productId), { on_hand: 0, reserved: 0, available: 0 });
});

test("a repeated call with the same idempotency key is a no-op the second time", async () => {
  const productId = await seedProduct(`IDEMPOTENT-${randomUUID().slice(0, 8)}`);
  const inventoryService = new InventoryService(pool);
  const idempotencyKey = `receipt:${productId}`;

  const first = await inventoryService.recordInventoryEvent({
    tenantId,
    productId,
    locationId,
    eventType: "receipt",
    quantityDelta: 7,
    idempotencyKey,
  });
  const second = await inventoryService.recordInventoryEvent({
    tenantId,
    productId,
    locationId,
    eventType: "receipt",
    quantityDelta: 7,
    idempotencyKey,
  });

  assert.equal(first.applied, true);
  assert.equal(second.applied, false);
  assert.equal(second.eventId, null);
  // Not 14 -- the second call must not double-apply.
  assert.deepEqual(await levelsFor(productId), { on_hand: 7, reserved: 0, available: 7 });
});

test("getAvailableToSell returns 0 for a product/location with no inventory_levels row yet", async () => {
  const productId = await seedProduct(`NOROW-${randomUUID().slice(0, 8)}`);
  const inventoryService = new InventoryService(pool);

  assert.equal(await inventoryService.getAvailableToSell(tenantId, productId, locationId), 0);
});

test("an applied event publishes inventory.changed on the injected eventBus, with the resulting (not delta) levels", async () => {
  const productId = await seedProduct(`PUBLISH-${randomUUID().slice(0, 8)}`);
  const eventBus = new InProcessEventBus();
  const published: InventoryChangedPayload[] = [];
  eventBus.subscribe<InventoryChangedPayload>(DomainEvent.InventoryChanged, (event) => {
    published.push(event.payload);
  });
  const inventoryService = new InventoryService(pool, eventBus);

  await inventoryService.recordInventoryEvent({
    tenantId,
    productId,
    locationId,
    eventType: "receipt",
    quantityDelta: 10,
    idempotencyKey: `receipt:${productId}`,
  });
  await inventoryService.recordInventoryEvent({
    tenantId,
    productId,
    locationId,
    eventType: "reservation",
    quantityDelta: -4,
    referenceType: "order",
    idempotencyKey: `reservation:${productId}`,
  });

  assert.equal(published.length, 2, "one inventory.changed per applied call");
  assert.deepEqual(published[0], { productId, locationId, eventType: "receipt", onHand: 10, reserved: 0, available: 10 });
  assert.deepEqual(published[1], { productId, locationId, eventType: "reservation", onHand: 10, reserved: 4, available: 6 });
});

test("a no-op idempotent replay does not publish inventory.changed a second time", async () => {
  const productId = await seedProduct(`PUBLISH-IDEMPOTENT-${randomUUID().slice(0, 8)}`);
  const eventBus = new InProcessEventBus();
  let publishCount = 0;
  eventBus.subscribe(DomainEvent.InventoryChanged, () => {
    publishCount++;
  });
  const inventoryService = new InventoryService(pool, eventBus);
  const idempotencyKey = `receipt:${productId}`;

  await inventoryService.recordInventoryEvent({ tenantId, productId, locationId, eventType: "receipt", quantityDelta: 7, idempotencyKey });
  await inventoryService.recordInventoryEvent({ tenantId, productId, locationId, eventType: "receipt", quantityDelta: 7, idempotencyKey });

  assert.equal(publishCount, 1, "the second, no-op call must not publish -- nothing about inventory_levels actually changed");
});

test("with no eventBus passed, recordInventoryEvent still behaves exactly as before (defaults to a private, harmless bus)", async () => {
  const productId = await seedProduct(`NO-BUS-${randomUUID().slice(0, 8)}`);
  const inventoryService = new InventoryService(pool);

  const result = await inventoryService.recordInventoryEvent({
    tenantId,
    productId,
    locationId,
    eventType: "receipt",
    quantityDelta: 3,
    idempotencyKey: `receipt:${productId}`,
  });

  assert.equal(result.applied, true);
  assert.deepEqual(await levelsFor(productId), { on_hand: 3, reserved: 0, available: 3 });
});

test("'transfer' is rejected outright rather than silently mishandled", async () => {
  const productId = await seedProduct(`TRANSFER-${randomUUID().slice(0, 8)}`);
  const inventoryService = new InventoryService(pool);

  await assert.rejects(
    () =>
      inventoryService.recordInventoryEvent({
        tenantId,
        productId,
        locationId,
        eventType: "transfer",
        quantityDelta: 1,
        idempotencyKey: `transfer:${productId}`,
      }),
    /not implemented/,
  );
});
