// Proves the order-lifecycle gaps closed alongside order cancellation:
// on_hold's resume path, backordered's manual retry, and the
// shipped -> delivered/returned/refunded flips (CLAUDE.md §3). See
// packages/shared/src/order-state-machine.ts's ON_HOLD / BACKORDERED
// RESOLUTION comment and OrderService.transition's doc comment for the
// decisions these encode.
//
// Run with: npm run test --workspace=@alltix/order-service -- lifecycle-transitions

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
      `INSERT INTO locations (tenant_id, name, type) VALUES ($1, 'Lifecycle Test Warehouse', 'warehouse') RETURNING id`,
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
  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM locations WHERE tenant_id = $1", [tenantId]));
  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM products WHERE tenant_id = $1", [tenantId]));
  await pool.end();
});

/** Seeds a fresh product + channel_listings mapping + inventory_levels row, isolated per test. */
async function seedProduct(onHand: number, externalSku: string): Promise<string> {
  return withTenant(pool, tenantId, async (client) => {
    const product = await client.query<{ id: string }>(
      `INSERT INTO products (tenant_id, internal_sku, name) VALUES ($1, $2, 'Lifecycle Test Product') RETURNING id`,
      [tenantId, `INTERNAL-${externalSku}`],
    );
    const productId = product.rows[0]!.id;

    await client.query(
      `INSERT INTO channel_listings (tenant_id, product_id, channel, channel_marketplace, external_sku, listing_status)
       VALUES ($1, $2, 'amazon', 'US', $3, 'active')`,
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
    channel: "amazon",
    channelMarketplace: "US",
    placedAt: new Date().toISOString(),
    channelStatus: "Unshipped",
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
    rawPayload: { synthetic: true, note: "hand-built for this test, not a real SP-API response" },
  };
}

async function insertOrderAtStatus(status: string, externalOrderId: string): Promise<string> {
  return withTenant(pool, tenantId, async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO orders (tenant_id, channel, external_order_id, status, customer, shipping_address, placed_at, raw_payload)
       VALUES ($1, 'amazon', $2, $3, '{}', '{}', now(), '{}')
       RETURNING id`,
      [tenantId, externalOrderId, status],
    );
    return inserted.rows[0]!.id;
  });
}

async function statusOf(orderId: string): Promise<string> {
  const result = await withTenant(pool, tenantId, (client) =>
    client.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [orderId]),
  );
  return result.rows[0]!.status;
}

test("resuming an on-hold order returns it to 'validated', then a manual allocate succeeds", async () => {
  const externalSku = `SKU-${randomUUID().slice(0, 8)}`;
  const productId = await seedProduct(5, externalSku);
  const orderService = new OrderService(pool);

  // on_hold only ever branches off 'validated', *before* allocation happens
  // (CLAUDE.md §3's diagram) -- and there's genuinely no way to reach it via
  // the service layer yet (no UI/action places a hold, see order-status.ts's
  // doc comment on manualOrderActions). So this test seeds the order
  // straight at 'on_hold' with a real order_line, modeling the only
  // scenario the diagram actually describes, rather than routing a
  // real order through persistPulledOrders (which auto-allocates) and
  // hopping it to on_hold afterwards -- that would model an order on hold
  // *after* already having a live reservation, which isn't a reachable
  // state today (allocated -> on_hold isn't a state-machine edge).
  const orderId = await withTenant(pool, tenantId, async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO orders (tenant_id, channel, external_order_id, status, customer, shipping_address, placed_at, raw_payload)
       VALUES ($1, 'amazon', 'RESUME-ORDER', 'on_hold', '{}', '{}', now(), '{}')
       RETURNING id`,
      [tenantId],
    );
    const id = inserted.rows[0]!.id;
    await client.query(
      `INSERT INTO order_lines (tenant_id, order_id, product_id, quantity, unit_price, fulfillment_type)
       VALUES ($1, $2, $3, 2, '9.99', 'seller_fulfilled')`,
      [tenantId, id, productId],
    );
    return id;
  });

  const resumed = await orderService.transition(tenantId, orderId, "on_hold", "validated");
  assert.equal(resumed, "validated");
  assert.equal(await statusOf(orderId), "validated");

  const allocated = await orderService.transition(tenantId, orderId, "validated", "allocated");
  assert.equal(allocated, "allocated", "manual allocate action closes the loop after a resume");
});

test("retrying a backordered order stays backordered if still short, then succeeds once stock arrives", async () => {
  const externalSku = `SKU-${randomUUID().slice(0, 8)}`;
  const productId = await seedProduct(1, externalSku);
  const orderService = new OrderService(pool);

  const result = await orderService.persistPulledOrders(tenantId, [makeSyntheticOrder("RETRY-ORDER", externalSku, 5)]);
  const orderId = result.insertedOrderIds[0]!;
  assert.equal(await statusOf(orderId), "backordered", "sanity check: insufficient stock at ingestion time");

  const stillShort = await orderService.transition(tenantId, orderId, "backordered", "allocated");
  assert.equal(stillShort, "backordered", "retrying without more stock lands back on backordered, not an error");

  // Stock arrives.
  await withTenant(pool, tenantId, (client) =>
    client.query(`UPDATE inventory_levels SET on_hand = on_hand + 10 WHERE product_id = $1 AND location_id = $2`, [
      productId,
      locationId,
    ]),
  );

  const nowAllocated = await orderService.transition(tenantId, orderId, "backordered", "allocated");
  assert.equal(nowAllocated, "allocated");

  const events = await withTenant(pool, tenantId, (client) =>
    client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_events WHERE tenant_id = $1 AND reference_id = $2 AND event_type = 'reservation'`,
      [tenantId, orderId],
    ),
  );
  assert.equal(events.rows[0]?.count, "1", "exactly one reservation from the successful retry");
});

test("shipped -> delivered / refunded are plain status flips with no inventory side effects", async () => {
  const orderService = new OrderService(pool);

  const deliveredId = await insertOrderAtStatus("shipped", "DELIVERED-ORDER");
  assert.equal(await orderService.transition(tenantId, deliveredId, "shipped", "delivered"), "delivered");
  assert.equal(await statusOf(deliveredId), "delivered");

  const refundedId = await insertOrderAtStatus("shipped", "REFUNDED-ORDER");
  assert.equal(await orderService.transition(tenantId, refundedId, "shipped", "refunded"), "refunded");
  assert.equal(await statusOf(refundedId), "refunded");

  const anyInventoryEvents = await withTenant(pool, tenantId, (client) =>
    client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_events WHERE tenant_id = $1 AND reference_id = ANY($2::uuid[])`,
      [tenantId, [deliveredId, refundedId]],
    ),
  );
  assert.equal(anyInventoryEvents.rows[0]?.count, "0");
});

test("shipped -> returned requires an explicit disposition -- no silent default either way", async () => {
  const orderId = await insertOrderAtStatus("shipped", "NO-DISPOSITION-ORDER");
  const orderService = new OrderService(pool);

  await assert.rejects(() => orderService.transition(tenantId, orderId, "shipped", "returned"), /requires options\.disposition/);
  assert.equal(await statusOf(orderId), "shipped", "a rejected return must not have changed the order's status");
});

test("a 'damaged' return flips status but restocks nothing, even though the order has a real sale event", async () => {
  const externalSku = `SKU-${randomUUID().slice(0, 8)}`;
  const productId = await seedProduct(0, externalSku);
  const orderId = await insertOrderAtStatus("shipped", "DAMAGED-RETURN-ORDER");
  const orderService = new OrderService(pool);

  await withTenant(pool, tenantId, (client) =>
    client.query(
      `INSERT INTO inventory_events (tenant_id, product_id, location_id, event_type, quantity_delta, reference_type, reference_id, idempotency_key)
       VALUES ($1, $2, $3, 'sale', -3, 'order', $4, $5)`,
      [tenantId, productId, locationId, orderId, `order-sale:${orderId}:synthetic-line`],
    ),
  );

  const result = await orderService.transition(tenantId, orderId, "shipped", "returned", { disposition: "damaged" });
  assert.equal(result, "returned");
  assert.equal(await statusOf(orderId), "returned");

  const level = await withTenant(pool, tenantId, (client) =>
    client.query<{ on_hand: number }>(`SELECT on_hand FROM inventory_levels WHERE product_id = $1 AND location_id = $2`, [
      productId,
      locationId,
    ]),
  );
  assert.equal(level.rows[0]?.on_hand, 0, "a damaged return must not restock anything");
});

test("a 'sellable' return restocks exactly what the order's own sale events consumed", async () => {
  const externalSku = `SKU-${randomUUID().slice(0, 8)}`;
  // Seeded at 4 on_hand, then immediately "sold" down to 0 below -- models
  // a real shipment (4 arrived, all 4 shipped), so the return's restock can
  // be asserted back up to the original 4, not into negative territory.
  const productId = await seedProduct(4, externalSku);
  const orderId = await insertOrderAtStatus("shipped", "SELLABLE-RETURN-ORDER");
  const orderService = new OrderService(pool);

  // Models what WarehouseService.recordShipmentSaleEvents() would have
  // written at real shipment time -- a 'sale' event consuming 4 units, plus
  // its matching inventory_levels effect (on_hand and reserved both -4).
  await withTenant(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO inventory_events (tenant_id, product_id, location_id, event_type, quantity_delta, reference_type, reference_id, idempotency_key)
       VALUES ($1, $2, $3, 'sale', -4, 'order', $4, $5)`,
      [tenantId, productId, locationId, orderId, `order-sale:${orderId}:synthetic-line`],
    );
    await client.query(
      `UPDATE inventory_levels SET on_hand = on_hand - 4, reserved = reserved - 4 WHERE product_id = $1 AND location_id = $2`,
      [productId, locationId],
    );
  });

  const result = await orderService.transition(tenantId, orderId, "shipped", "returned", { disposition: "sellable" });
  assert.equal(result, "returned");
  assert.equal(await statusOf(orderId), "returned");

  const level = await withTenant(pool, tenantId, (client) =>
    client.query<{ on_hand: number }>(`SELECT on_hand FROM inventory_levels WHERE product_id = $1 AND location_id = $2`, [
      productId,
      locationId,
    ]),
  );
  assert.equal(level.rows[0]?.on_hand, 4, "restocked back to exactly what was sold");

  const returnEvent = await withTenant(pool, tenantId, (client) =>
    client.query<{ event_type: string; reference_type: string; quantity_delta: number }>(
      `SELECT event_type, reference_type, quantity_delta FROM inventory_events WHERE reference_type = 'return' AND reference_id = $1`,
      [orderId],
    ),
  );
  assert.equal(returnEvent.rows.length, 1);
  assert.equal(returnEvent.rows[0]?.event_type, "receipt");
  assert.equal(returnEvent.rows[0]?.quantity_delta, 4);

  // Calling it again (e.g. a retried request) must not double-restock --
  // same idempotency-via-idempotency_key contract as everywhere else in
  // this ledger.
  await assert.rejects(
    () => orderService.transition(tenantId, orderId, "shipped", "returned", { disposition: "sellable" }),
    /not in status 'shipped'/,
    "a second return attempt fails at the guarded status flip, not a double-restock",
  );
  const levelAfterRetry = await withTenant(pool, tenantId, (client) =>
    client.query<{ on_hand: number }>(`SELECT on_hand FROM inventory_levels WHERE product_id = $1 AND location_id = $2`, [
      productId,
      locationId,
    ]),
  );
  assert.equal(levelAfterRetry.rows[0]?.on_hand, 4, "no double-restock on a rejected retry");
});

test("a 'sellable' return with no matching sale events restocks nothing rather than throwing", async () => {
  const orderId = await insertOrderAtStatus("shipped", "NO-SALE-EVENT-ORDER");
  const orderService = new OrderService(pool);

  const result = await orderService.transition(tenantId, orderId, "shipped", "returned", { disposition: "sellable" });
  assert.equal(result, "returned");
  assert.equal(await statusOf(orderId), "returned");
});

test("an on-hold order cannot jump straight to allocated, skipping the resume step", async () => {
  const orderId = await insertOrderAtStatus("on_hold", "SKIP-RESUME-ORDER");
  const orderService = new OrderService(pool);

  await assert.rejects(
    () => orderService.transition(tenantId, orderId, "on_hold", "allocated"),
    /Invalid order transition: on_hold -> allocated/,
  );
});
