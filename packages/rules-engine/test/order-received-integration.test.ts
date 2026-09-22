// The real, end-to-end proof for this whole feature: OrderService + a real
// InProcessEventBus + RulesEngine, wired together and run against real
// Postgres. A route_to_warehouse rule targets a *non-default* warehouse
// location (allocateOrder()'s default is the tenant's oldest warehouse;
// this test's routed location is created second, so "it worked" can only
// mean the routing decision actually took effect, not that the default
// happened to be right anyway). Requires a live Postgres (npm run db:migrate).
//
// Run with: npm run test --workspace=@alltix/rules-engine -- order-received-integration

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { Client, type Pool } from "pg";
import { createAppPool, withTenant } from "@alltix/db";
import { InProcessEventBus } from "@alltix/shared";
import type { NormalizedOrder } from "@alltix/channel-connectors";
import { OrderService } from "@alltix/order-service";
import { RulesEngine } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

loadEnv({ path: join(REPO_ROOT, ".env") });

let pool: Pool;
const tenantId = randomUUID();
let defaultLocationId: string;
let routedLocationId: string;
const ROUTED_LOCATION_NAME = "Routing Test Warehouse 2 (Routed)";

before(async () => {
  const connectionString = process.env.APP_DATABASE_URL;
  if (!connectionString) {
    throw new Error("APP_DATABASE_URL is not set (see .env.example)");
  }
  pool = createAppPool({ connectionString });

  await withTenant(pool, tenantId, async (client) => {
    // Created first -- allocateOrder()'s default (oldest warehouse) without
    // any routing decision. Deliberately given 0 stock: if routing failed
    // silently and allocation fell back to this location, the order would
    // backorder instead of allocate, making a routing failure loud, not a
    // false positive.
    const defaultLocation = await client.query<{ id: string }>(
      `INSERT INTO locations (tenant_id, name, type) VALUES ($1, 'Routing Test Warehouse 1 (Default)', 'warehouse') RETURNING id`,
      [tenantId],
    );
    defaultLocationId = defaultLocation.rows[0]!.id;

    // Created second -- only reachable via the route_to_warehouse action.
    const routedLocation = await client.query<{ id: string }>(
      `INSERT INTO locations (tenant_id, name, type) VALUES ($1, $2, 'warehouse') RETURNING id`,
      [tenantId, ROUTED_LOCATION_NAME],
    );
    routedLocationId = routedLocation.rows[0]!.id;
  });
});

after(async () => {
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query("DELETE FROM audit_log WHERE tenant_id = $1", [tenantId]);
  await admin.query("DELETE FROM rule_executions WHERE tenant_id = $1", [tenantId]);
  await admin.query("DELETE FROM automation_rules WHERE tenant_id = $1", [tenantId]);
  await admin.query("DELETE FROM inventory_events WHERE tenant_id = $1", [tenantId]);
  await admin.query("DELETE FROM orders WHERE tenant_id = $1", [tenantId]); // cascades order_lines
  await admin.query("DELETE FROM inventory_levels WHERE tenant_id = $1", [tenantId]);
  await admin.end();

  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM channel_listings WHERE tenant_id = $1", [tenantId]));
  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM locations WHERE tenant_id = $1", [tenantId]));
  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM products WHERE tenant_id = $1", [tenantId]));
  await pool.end();
});

/** Seeds a fresh product + channel_listings mapping, with stock only at
 *  routedLocationId -- mirrors persist-and-allocate.test.ts's seedProduct,
 *  minus the on-hand-at-default case since this test's whole point is that
 *  the default location must NOT be where allocation happens. */
async function seedProductWithStockAtRoutedLocation(onHand: number, externalSku: string): Promise<string> {
  return withTenant(pool, tenantId, async (client) => {
    const product = await client.query<{ id: string }>(
      `INSERT INTO products (tenant_id, internal_sku, name) VALUES ($1, $2, 'Routing Test Product') RETURNING id`,
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
      [tenantId, productId, routedLocationId, onHand],
    );

    return productId;
  });
}

async function seedRouteToWarehouseRule(conditions: unknown, priority = 100): Promise<string> {
  return withTenant(pool, tenantId, async (client) => {
    const rule = await client.query<{ id: string }>(
      `INSERT INTO automation_rules (tenant_id, name, trigger_event, conditions, actions, priority, enabled)
       VALUES ($1, 'Route Amazon orders to WH2', 'order.received', $2, $3, $4, true) RETURNING id`,
      [
        tenantId,
        JSON.stringify(conditions),
        JSON.stringify([{ type: "route_to_warehouse", value: ROUTED_LOCATION_NAME }]),
        priority,
      ],
    );
    return rule.rows[0]!.id;
  });
}

function makeSyntheticOrder(externalOrderId: string, externalSku: string, quantity: number, channel = "amazon"): NormalizedOrder {
  return {
    externalOrderId,
    channel,
    channelMarketplace: "US",
    placedAt: new Date().toISOString(),
    channelStatus: "Unshipped",
    customer: {},
    shippingAddress: {},
    lines: [
      { externalLineId: `${externalOrderId}-line-1`, externalSku, quantity, unitPrice: "9.99", fulfillmentType: "seller_fulfilled" },
    ],
    rawPayload: { synthetic: true, note: "hand-built for this test, not a real SP-API response" },
  };
}

test("an order.received routing rule sends allocation to the non-default warehouse it names", async () => {
  const externalSku = `SKU-${randomUUID().slice(0, 8)}`;
  const productId = await seedProductWithStockAtRoutedLocation(5, externalSku);
  const ruleId = await seedRouteToWarehouseRule([{ field: "channel", op: "eq", value: "amazon" }]);

  const eventBus = new InProcessEventBus();
  const orderService = new OrderService(pool, eventBus);
  const rulesEngine = new RulesEngine(pool);
  rulesEngine.attach(eventBus);

  const result = await orderService.persistPulledOrders(tenantId, [
    makeSyntheticOrder("ROUTING-TEST-ORDER", externalSku, 2),
  ]);
  assert.equal(result.insertedOrderIds.length, 1);
  const orderId = result.insertedOrderIds[0]!;

  const orderRow = await withTenant(pool, tenantId, (client) =>
    client.query<{ status: string; preferred_location_id: string }>(
      "SELECT status, preferred_location_id FROM orders WHERE id = $1",
      [orderId],
    ),
  );
  assert.equal(orderRow.rows[0]?.status, "allocated", "must allocate, not backorder -- proves it used the routed location's stock");
  assert.equal(orderRow.rows[0]?.preferred_location_id, routedLocationId);

  const events = await withTenant(pool, tenantId, (client) =>
    client.query<{ location_id: string; quantity_delta: number }>(
      `SELECT location_id, quantity_delta FROM inventory_events WHERE tenant_id = $1 AND event_type = 'reservation'`,
      [tenantId],
    ),
  );
  assert.equal(events.rows.length, 1);
  assert.equal(events.rows[0]?.location_id, routedLocationId, "the reservation must be at the routed location, not the default");
  assert.equal(events.rows[0]?.quantity_delta, -2);

  const routedLevels = await withTenant(pool, tenantId, (client) =>
    client.query<{ reserved: number }>(
      `SELECT reserved FROM inventory_levels WHERE product_id = $1 AND location_id = $2`,
      [productId, routedLocationId],
    ),
  );
  assert.equal(routedLevels.rows[0]?.reserved, 2);

  const defaultLevels = await withTenant(pool, tenantId, (client) =>
    client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_levels WHERE product_id = $1 AND location_id = $2`,
      [productId, defaultLocationId],
    ),
  );
  assert.equal(defaultLevels.rows[0]?.count, "0", "no inventory_levels row should exist at the default location at all");

  const executions = await withTenant(pool, tenantId, (client) =>
    client.query<{ automation_rule_id: string; matched: boolean; applied: boolean; error: string | null }>(
      `SELECT automation_rule_id, matched, applied, error FROM rule_executions WHERE tenant_id = $1 AND order_id = $2`,
      [tenantId, orderId],
    ),
  );
  assert.equal(executions.rows.length, 1);
  assert.deepEqual(executions.rows[0], { automation_rule_id: ruleId, matched: true, applied: true, error: null });
});

test("an order.received event that doesn't match any rule's conditions allocates at the default location, untouched", async () => {
  const externalSku = `SKU-${randomUUID().slice(0, 8)}`;
  // Stock at the DEFAULT location this time -- proves the non-matching
  // order never got a preferred_location_id at all.
  await withTenant(pool, tenantId, async (client) => {
    const product = await client.query<{ id: string }>(
      `INSERT INTO products (tenant_id, internal_sku, name) VALUES ($1, $2, 'Routing Test Product (non-matching)') RETURNING id`,
      [tenantId, `INTERNAL-${externalSku}`],
    );
    const id = product.rows[0]!.id;
    await client.query(
      `INSERT INTO channel_listings (tenant_id, product_id, channel, channel_marketplace, external_sku, listing_status)
       VALUES ($1, $2, 'walmart', 'US', $3, 'active')`,
      [tenantId, id, externalSku],
    );
    await client.query(
      `INSERT INTO inventory_levels (tenant_id, product_id, location_id, on_hand, reserved) VALUES ($1, $2, $3, 5, 0)`,
      [tenantId, id, defaultLocationId],
    );
    return id;
  });
  // The rule seeded in the previous test only matches channel='amazon';
  // this order is 'walmart', so it must not match.
  await seedRouteToWarehouseRule([{ field: "channel", op: "eq", value: "amazon" }]);

  const eventBus = new InProcessEventBus();
  const orderService = new OrderService(pool, eventBus);
  const rulesEngine = new RulesEngine(pool);
  rulesEngine.attach(eventBus);

  const result = await orderService.persistPulledOrders(tenantId, [
    makeSyntheticOrder("NON-MATCHING-ROUTING-TEST-ORDER", externalSku, 1, "walmart"),
  ]);
  const orderId = result.insertedOrderIds[0]!;

  const orderRow = await withTenant(pool, tenantId, (client) =>
    client.query<{ status: string; preferred_location_id: string | null }>(
      "SELECT status, preferred_location_id FROM orders WHERE id = $1",
      [orderId],
    ),
  );
  assert.equal(orderRow.rows[0]?.status, "allocated");
  assert.equal(orderRow.rows[0]?.preferred_location_id, null);

  const executions = await withTenant(pool, tenantId, (client) =>
    client.query<{ count: string }>(`SELECT count(*)::text AS count FROM rule_executions WHERE tenant_id = $1 AND order_id = $2`, [
      tenantId,
      orderId,
    ]),
  );
  assert.equal(executions.rows[0]?.count, "0", "a non-matching rule leaves no rule_executions row at all");
});
