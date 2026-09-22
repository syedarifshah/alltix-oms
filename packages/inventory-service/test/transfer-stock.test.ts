// Proves InventoryService.transferStock() -- the two-location capability
// recordInventoryEvent()'s own doc comment (and record-inventory-event.test.ts's
// own "'transfer' is rejected outright" test) flags as needing a different
// signature. Same "real Postgres, no mocks" discipline as that file.
//
// Requires a live Postgres (npm run db:migrate, which must include
// migrations/0022_inventory_events_transfer_reference_type.sql).
//
// Run with: npm run test --workspace=@alltix/inventory-service -- transfer-stock

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
let locationAId: string;
let locationBId: string;

async function seedProduct(sku: string): Promise<string> {
  return withTenant(pool, tenantId, async (client) => {
    const product = await client.query<{ id: string }>(
      `INSERT INTO products (tenant_id, internal_sku, name) VALUES ($1, $2, $3) RETURNING id`,
      [tenantId, sku, sku],
    );
    return product.rows[0]!.id;
  });
}

async function levelsAt(
  productId: string,
  locationId: string,
): Promise<{ on_hand: number; reserved: number; available: number } | undefined> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query<{ on_hand: number; reserved: number; available: number }>(
      `SELECT on_hand, reserved, available FROM inventory_levels WHERE product_id = $1 AND location_id = $2`,
      [productId, locationId],
    );
    return result.rows[0];
  });
}

async function transferEventsFor(
  productId: string,
): Promise<Array<{ location_id: string; quantity_delta: number; reference_type: string | null; reference_id: string | null }>> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query<{
      location_id: string;
      quantity_delta: number;
      reference_type: string | null;
      reference_id: string | null;
    }>(
      `SELECT location_id, quantity_delta, reference_type, reference_id
         FROM inventory_events WHERE product_id = $1 AND event_type = 'transfer'
        ORDER BY quantity_delta DESC`,
      [productId],
    );
    return result.rows;
  });
}

before(async () => {
  const connectionString = process.env.APP_DATABASE_URL;
  if (!connectionString) {
    throw new Error("APP_DATABASE_URL is not set (see .env.example)");
  }
  pool = createAppPool({ connectionString });

  const locations = await withTenant(pool, tenantId, (client) =>
    client.query<{ id: string }>(
      `INSERT INTO locations (tenant_id, name, type)
       VALUES ($1, 'Transfer Test Warehouse A', 'warehouse'), ($1, 'Transfer Test Warehouse B', 'warehouse')
       RETURNING id`,
      [tenantId],
    ),
  );
  [locationAId, locationBId] = locations.rows.map((r) => r.id) as [string, string];
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

test("transferStock moves on_hand from source to destination, leaving reserved untouched at both", async () => {
  const productId = await seedProduct(`XFER-${randomUUID().slice(0, 8)}`);
  const inventoryService = new InventoryService(pool);

  await inventoryService.recordInventoryEvent({
    tenantId,
    productId,
    locationId: locationAId,
    eventType: "receipt",
    quantityDelta: 10,
    idempotencyKey: `receipt:${productId}`,
  });

  const result = await inventoryService.transferStock({
    tenantId,
    productId,
    fromLocationId: locationAId,
    toLocationId: locationBId,
    quantity: 4,
    idempotencyKey: `xfer:${productId}`,
  });

  assert.equal(result.applied, true);
  assert.ok(result.transferId);

  assert.deepEqual(await levelsAt(productId, locationAId), { on_hand: 6, reserved: 0, available: 6 });
  assert.deepEqual(await levelsAt(productId, locationBId), { on_hand: 4, reserved: 0, available: 4 });

  const events = await transferEventsFor(productId);
  assert.equal(events.length, 2);
  assert.equal(events[0]!.location_id, locationBId);
  assert.equal(events[0]!.quantity_delta, 4);
  assert.equal(events[1]!.location_id, locationAId);
  assert.equal(events[1]!.quantity_delta, -4);
  assert.equal(events[0]!.reference_type, "transfer");
  assert.equal(events[0]!.reference_id, result.transferId, "both legs must share the transfer's reference_id");
  assert.equal(events[1]!.reference_id, result.transferId);
});

test("transferStock publishes one inventory.changed event per leg, with each leg's own resulting levels", async () => {
  const productId = await seedProduct(`XFER-PUBLISH-${randomUUID().slice(0, 8)}`);
  const eventBus = new InProcessEventBus();
  const published: InventoryChangedPayload[] = [];
  eventBus.subscribe<InventoryChangedPayload>(DomainEvent.InventoryChanged, (event) => {
    published.push(event.payload);
  });
  const inventoryService = new InventoryService(pool, eventBus);

  await inventoryService.recordInventoryEvent({
    tenantId,
    productId,
    locationId: locationAId,
    eventType: "receipt",
    quantityDelta: 10,
    idempotencyKey: `receipt:${productId}`,
  });
  published.length = 0; // only care about transferStock's own publishes from here

  await inventoryService.transferStock({
    tenantId,
    productId,
    fromLocationId: locationAId,
    toLocationId: locationBId,
    quantity: 4,
    idempotencyKey: `xfer:${productId}`,
  });

  assert.equal(published.length, 2, "one event per (product, location) leg, not one dual-location event");
  assert.deepEqual(published[0], {
    productId,
    locationId: locationAId,
    eventType: "transfer",
    onHand: 6,
    reserved: 0,
    available: 6,
  });
  assert.deepEqual(published[1], {
    productId,
    locationId: locationBId,
    eventType: "transfer",
    onHand: 4,
    reserved: 0,
    available: 4,
  });
});

test("a no-op idempotent transferStock replay does not publish inventory.changed a second time", async () => {
  const productId = await seedProduct(`XFER-PUBLISH-IDEMPOTENT-${randomUUID().slice(0, 8)}`);
  const eventBus = new InProcessEventBus();
  let publishCount = 0;
  eventBus.subscribe(DomainEvent.InventoryChanged, () => {
    publishCount++;
  });
  const inventoryService = new InventoryService(pool, eventBus);
  const idempotencyKey = `xfer:${productId}`;

  await inventoryService.recordInventoryEvent({
    tenantId,
    productId,
    locationId: locationAId,
    eventType: "receipt",
    quantityDelta: 10,
    idempotencyKey: `receipt:${productId}`,
  });
  publishCount = 0; // only care about transferStock's own publishes from here

  await inventoryService.transferStock({ tenantId, productId, fromLocationId: locationAId, toLocationId: locationBId, quantity: 3, idempotencyKey });
  await inventoryService.transferStock({ tenantId, productId, fromLocationId: locationAId, toLocationId: locationBId, quantity: 3, idempotencyKey });

  assert.equal(publishCount, 2, "exactly the first call's two leg-events -- the second, no-op call must not publish again");
});

test("transferStock creates the destination's inventory_levels row on the fly for a product never stocked there before", async () => {
  const productId = await seedProduct(`XFER-NEWROW-${randomUUID().slice(0, 8)}`);
  const inventoryService = new InventoryService(pool);

  await inventoryService.recordInventoryEvent({
    tenantId,
    productId,
    locationId: locationAId,
    eventType: "receipt",
    quantityDelta: 5,
    idempotencyKey: `receipt:${productId}`,
  });

  assert.equal(await levelsAt(productId, locationBId), undefined, "destination must have no row yet");

  await inventoryService.transferStock({
    tenantId,
    productId,
    fromLocationId: locationAId,
    toLocationId: locationBId,
    quantity: 2,
    idempotencyKey: `xfer:${productId}`,
  });

  assert.deepEqual(await levelsAt(productId, locationBId), { on_hand: 2, reserved: 0, available: 2 });
});

test("transferStock refuses to move reserved stock -- the sufficiency check is against available, not on_hand", async () => {
  const productId = await seedProduct(`XFER-RESERVED-${randomUUID().slice(0, 8)}`);
  const inventoryService = new InventoryService(pool);

  await inventoryService.recordInventoryEvent({
    tenantId,
    productId,
    locationId: locationAId,
    eventType: "receipt",
    quantityDelta: 10,
    idempotencyKey: `receipt:${productId}`,
  });
  await inventoryService.recordInventoryEvent({
    tenantId,
    productId,
    locationId: locationAId,
    eventType: "reservation",
    quantityDelta: -8,
    referenceType: "order",
    idempotencyKey: `reservation:${productId}`,
  });
  // on_hand=10, reserved=8, available=2 -- requesting 5 must fail even
  // though on_hand alone would cover it.

  await assert.rejects(
    () =>
      inventoryService.transferStock({
        tenantId,
        productId,
        fromLocationId: locationAId,
        toLocationId: locationBId,
        quantity: 5,
        idempotencyKey: `xfer:${productId}`,
      }),
    /insufficient available stock/,
  );

  // Nothing should have moved -- the failed attempt must not have
  // partially applied either leg.
  assert.deepEqual(await levelsAt(productId, locationAId), { on_hand: 10, reserved: 8, available: 2 });
  assert.equal(await levelsAt(productId, locationBId), undefined);
  assert.equal((await transferEventsFor(productId)).length, 0);
});

test("a repeated transferStock call with the same idempotency key is a no-op the second time", async () => {
  const productId = await seedProduct(`XFER-IDEMPOTENT-${randomUUID().slice(0, 8)}`);
  const inventoryService = new InventoryService(pool);
  const idempotencyKey = `xfer:${productId}`;

  await inventoryService.recordInventoryEvent({
    tenantId,
    productId,
    locationId: locationAId,
    eventType: "receipt",
    quantityDelta: 10,
    idempotencyKey: `receipt:${productId}`,
  });

  const first = await inventoryService.transferStock({
    tenantId,
    productId,
    fromLocationId: locationAId,
    toLocationId: locationBId,
    quantity: 3,
    idempotencyKey,
  });
  const second = await inventoryService.transferStock({
    tenantId,
    productId,
    fromLocationId: locationAId,
    toLocationId: locationBId,
    quantity: 3,
    idempotencyKey,
  });

  assert.equal(first.applied, true);
  assert.equal(second.applied, false);
  assert.equal(second.transferId, null);
  // Not on_hand=4/6 -- the second call must not double-apply.
  assert.deepEqual(await levelsAt(productId, locationAId), { on_hand: 7, reserved: 0, available: 7 });
  assert.deepEqual(await levelsAt(productId, locationBId), { on_hand: 3, reserved: 0, available: 3 });
});

test("transferStock rejects fromLocationId === toLocationId without writing anything", async () => {
  const productId = await seedProduct(`XFER-SAMELOC-${randomUUID().slice(0, 8)}`);
  const inventoryService = new InventoryService(pool);

  await inventoryService.recordInventoryEvent({
    tenantId,
    productId,
    locationId: locationAId,
    eventType: "receipt",
    quantityDelta: 10,
    idempotencyKey: `receipt:${productId}`,
  });

  await assert.rejects(
    () =>
      inventoryService.transferStock({
        tenantId,
        productId,
        fromLocationId: locationAId,
        toLocationId: locationAId,
        quantity: 1,
        idempotencyKey: `xfer:${productId}`,
      }),
    /must be different locations/,
  );

  assert.deepEqual(await levelsAt(productId, locationAId), { on_hand: 10, reserved: 0, available: 10 });
});

test("transferStock rejects a non-positive or non-integer quantity", async () => {
  const productId = await seedProduct(`XFER-BADQTY-${randomUUID().slice(0, 8)}`);
  const inventoryService = new InventoryService(pool);

  for (const quantity of [0, -1, 1.5]) {
    await assert.rejects(
      () =>
        inventoryService.transferStock({
          tenantId,
          productId,
          fromLocationId: locationAId,
          toLocationId: locationBId,
          quantity,
          idempotencyKey: `xfer:${productId}:${quantity}`,
        }),
      /positive integer/,
      `quantity=${quantity} must be rejected`,
    );
  }
});
