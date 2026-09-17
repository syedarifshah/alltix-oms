// End-to-end proof for per-SKU rule-based routing (CLAUDE.md §8 Phase 4's
// "per-SKU rule-based routing" gap -- OrderReceivedPayload.lineSkus, and the
// rules engine's new "contains" operator). Same shape as
// order-received-integration.test.ts's channel-based routing proof, but the
// condition here targets which PRODUCT is in the order rather than which
// channel it came from -- and specifically proves the rule fires the same
// way for two DIFFERENT channels' own SKU spellings of the same product,
// since lineSkus reports the platform-canonical products.internal_sku, not
// each channel's external_sku. Requires a live Postgres (npm run db:migrate).
//
// Run with: npm run test --workspace=@alltix/rules-engine -- sku-routing-integration

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
const ROUTED_LOCATION_NAME = "SKU Routing Test Warehouse 2 (Routed)";

before(async () => {
  const connectionString = process.env.APP_DATABASE_URL;
  if (!connectionString) {
    throw new Error("APP_DATABASE_URL is not set (see .env.example)");
  }
  pool = createAppPool({ connectionString });

  await withTenant(pool, tenantId, async (client) => {
    const defaultLocation = await client.query<{ id: string }>(
      `INSERT INTO locations (tenant_id, name, type) VALUES ($1, 'SKU Routing Test Warehouse 1 (Default)', 'warehouse') RETURNING id`,
      [tenantId],
    );
    defaultLocationId = defaultLocation.rows[0]!.id;

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

/** Seeds one product mapped under TWO different channels' own SKU spellings
 *  -- the whole point of this test is that a rule keyed on the shared
 *  internal_sku fires identically for either channel's order, not just the
 *  one whose external_sku happens to match some literal string. */
async function seedProductWithTwoChannelSkus(
  internalSku: string,
  amazonSku: string,
  walmartSku: string,
  onHand: number,
): Promise<string> {
  return withTenant(pool, tenantId, async (client) => {
    const product = await client.query<{ id: string }>(
      `INSERT INTO products (tenant_id, internal_sku, name) VALUES ($1, $2, 'SKU Routing Test Product') RETURNING id`,
      [tenantId, internalSku],
    );
    const productId = product.rows[0]!.id;

    await client.query(
      `INSERT INTO channel_listings (tenant_id, product_id, channel, channel_marketplace, external_sku, listing_status)
       VALUES ($1, $2, 'amazon', 'US', $3, 'active'), ($1, $2, 'walmart', 'US', $4, 'active')`,
      [tenantId, productId, amazonSku, walmartSku],
    );

    await client.query(
      `INSERT INTO inventory_levels (tenant_id, product_id, location_id, on_hand, reserved) VALUES ($1, $2, $3, $4, 0)`,
      [tenantId, productId, routedLocationId, onHand],
    );

    return productId;
  });
}

async function seedSkuRoutingRule(internalSku: string, priority = 100): Promise<string> {
  return withTenant(pool, tenantId, async (client) => {
    const rule = await client.query<{ id: string }>(
      `INSERT INTO automation_rules (tenant_id, name, trigger_event, conditions, actions, priority, enabled)
       VALUES ($1, 'Route hot SKU to WH2', 'order.received', $2, $3, $4, true) RETURNING id`,
      [
        tenantId,
        JSON.stringify([{ field: "lineSkus", op: "contains", value: internalSku }]),
        JSON.stringify([{ type: "route_to_warehouse", value: ROUTED_LOCATION_NAME }]),
        priority,
      ],
    );
    return rule.rows[0]!.id;
  });
}

function makeSyntheticOrder(externalOrderId: string, externalSku: string, quantity: number, channel: string): NormalizedOrder {
  return {
    externalOrderId,
    channel,
    channelMarketplace: "US",
    placedAt: new Date().toISOString(),
    channelStatus: channel === "amazon" ? "Unshipped" : "Created",
    customer: {},
    shippingAddress: {},
    lines: [
      { externalLineId: `${externalOrderId}-line-1`, externalSku, quantity, unitPrice: "9.99", fulfillmentType: "seller_fulfilled" },
    ],
    rawPayload: { synthetic: true, note: "hand-built for this test, not a real channel payload" },
  };
}

test("a lineSkus 'contains' rule routes an order by product, regardless of which channel's own SKU spelling it arrived under", async () => {
  const internalSku = `INTERNAL-HOT-${randomUUID().slice(0, 8)}`;
  const amazonSku = `AMZ-${randomUUID().slice(0, 8)}`;
  const walmartSku = `WMT-${randomUUID().slice(0, 8)}`;
  await seedProductWithTwoChannelSkus(internalSku, amazonSku, walmartSku, 10);
  const ruleId = await seedSkuRoutingRule(internalSku);

  const eventBus = new InProcessEventBus();
  const orderService = new OrderService(pool, eventBus);
  const rulesEngine = new RulesEngine(pool);
  rulesEngine.attach(eventBus);

  // Two orders for the SAME product, arriving from two DIFFERENT channels
  // under two DIFFERENT external SKUs -- both must route.
  const amazonResult = await orderService.persistPulledOrders(tenantId, [
    makeSyntheticOrder("SKU-ROUTE-AMAZON-ORDER", amazonSku, 1, "amazon"),
  ]);
  const walmartResult = await orderService.persistPulledOrders(tenantId, [
    makeSyntheticOrder("SKU-ROUTE-WALMART-ORDER", walmartSku, 1, "walmart"),
  ]);

  for (const orderId of [amazonResult.insertedOrderIds[0]!, walmartResult.insertedOrderIds[0]!]) {
    const orderRow = await withTenant(pool, tenantId, (client) =>
      client.query<{ status: string; preferred_location_id: string }>(
        "SELECT status, preferred_location_id FROM orders WHERE id = $1",
        [orderId],
      ),
    );
    assert.equal(orderRow.rows[0]?.status, "allocated", "must allocate at the routed location's stock");
    assert.equal(orderRow.rows[0]?.preferred_location_id, routedLocationId);

    const executions = await withTenant(pool, tenantId, (client) =>
      client.query<{ automation_rule_id: string; matched: boolean; applied: boolean }>(
        `SELECT automation_rule_id, matched, applied FROM rule_executions WHERE tenant_id = $1 AND order_id = $2`,
        [tenantId, orderId],
      ),
    );
    assert.deepEqual(executions.rows[0], { automation_rule_id: ruleId, matched: true, applied: true });
  }
});

test("a lineSkus rule for a DIFFERENT SKU does not fire -- the order allocates at the default location untouched", async () => {
  const internalSku = `INTERNAL-HOT-${randomUUID().slice(0, 8)}`;
  const unrelatedInternalSku = `INTERNAL-COLD-${randomUUID().slice(0, 8)}`;
  const amazonSku = `AMZ-${randomUUID().slice(0, 8)}`;
  const walmartSku = `WMT-${randomUUID().slice(0, 8)}`;
  await seedProductWithTwoChannelSkus(internalSku, amazonSku, walmartSku, 10);
  // Rule targets a SKU that is NOT on the product this order is for.
  await seedSkuRoutingRule(unrelatedInternalSku);

  // Seed a second product with stock at the default location so the order
  // can allocate there when routing correctly does NOT fire.
  const otherAmazonSku = `AMZ-OTHER-${randomUUID().slice(0, 8)}`;
  await withTenant(pool, tenantId, async (client) => {
    const product = await client.query<{ id: string }>(
      `INSERT INTO products (tenant_id, internal_sku, name) VALUES ($1, $2, 'SKU Routing Test Product (unrelated rule)') RETURNING id`,
      [tenantId, `INTERNAL-DEFAULT-${randomUUID().slice(0, 8)}`],
    );
    const id = product.rows[0]!.id;
    await client.query(
      `INSERT INTO channel_listings (tenant_id, product_id, channel, channel_marketplace, external_sku, listing_status)
       VALUES ($1, $2, 'amazon', 'US', $3, 'active')`,
      [tenantId, id, otherAmazonSku],
    );
    await client.query(
      `INSERT INTO inventory_levels (tenant_id, product_id, location_id, on_hand, reserved) VALUES ($1, $2, $3, 5, 0)`,
      [tenantId, id, defaultLocationId],
    );
  });

  const eventBus = new InProcessEventBus();
  const orderService = new OrderService(pool, eventBus);
  const rulesEngine = new RulesEngine(pool);
  rulesEngine.attach(eventBus);

  const result = await orderService.persistPulledOrders(tenantId, [
    makeSyntheticOrder("SKU-ROUTE-NON-MATCHING-ORDER", otherAmazonSku, 1, "amazon"),
  ]);
  const orderId = result.insertedOrderIds[0]!;

  const orderRow = await withTenant(pool, tenantId, (client) =>
    client.query<{ status: string; preferred_location_id: string | null }>(
      "SELECT status, preferred_location_id FROM orders WHERE id = $1",
      [orderId],
    ),
  );
  assert.equal(orderRow.rows[0]?.status, "allocated");
  assert.equal(orderRow.rows[0]?.preferred_location_id, null, "no routing rule matched, so no preferred location was ever set");

  const executions = await withTenant(pool, tenantId, (client) =>
    client.query<{ count: string }>(`SELECT count(*)::text AS count FROM rule_executions WHERE tenant_id = $1 AND order_id = $2`, [
      tenantId,
      orderId,
    ]),
  );
  assert.equal(executions.rows[0]?.count, "0");
});
