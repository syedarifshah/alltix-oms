// Proves RulesEngine's 'hold_order' action end to end: OrderService + a real
// InProcessEventBus + RulesEngine, wired together and run against real
// Postgres, same pattern as order-received-integration.test.ts. A matching
// order must land on 'on_hold' -- never reaching allocateOrder() at all, so
// no reservation is created -- and persistPulledOrders() must still finish
// the rest of its batch normally for a second, non-matching order in the
// same call (proving the currentStatus() re-check in persistPulledOrders
// doesn't abort the batch -- see that method's doc comment).
//
// Requires a live Postgres (npm run db:migrate).
//
// Run with: npm run test --workspace=@alltix/rules-engine -- hold-order-integration

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
let locationId: string;

before(async () => {
  const connectionString = process.env.APP_DATABASE_URL;
  if (!connectionString) {
    throw new Error("APP_DATABASE_URL is not set (see .env.example)");
  }
  pool = createAppPool({ connectionString });

  locationId = await withTenant(pool, tenantId, async (client) => {
    const location = await client.query<{ id: string }>(
      `INSERT INTO locations (tenant_id, name, type) VALUES ($1, 'Hold Order Test Warehouse', 'warehouse') RETURNING id`,
      [tenantId],
    );
    return location.rows[0]!.id;
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

async function seedProduct(onHand: number, externalSku: string): Promise<string> {
  return withTenant(pool, tenantId, async (client) => {
    const product = await client.query<{ id: string }>(
      `INSERT INTO products (tenant_id, internal_sku, name) VALUES ($1, $2, 'Hold Order Test Product') RETURNING id`,
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

async function seedHoldRule(conditions: unknown, priority = 100): Promise<string> {
  return withTenant(pool, tenantId, async (client) => {
    const rule = await client.query<{ id: string }>(
      `INSERT INTO automation_rules (tenant_id, name, trigger_event, conditions, actions, priority, enabled)
       VALUES ($1, 'Hold high-value orders for review', 'order.received', $2, $3, $4, true) RETURNING id`,
      [tenantId, JSON.stringify(conditions), JSON.stringify([{ type: "hold_order", value: null }]), priority],
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

test("a hold_order rule parks a matching order on_hold, never reaching allocation", async () => {
  const externalSku = `SKU-${randomUUID().slice(0, 8)}`;
  await seedProduct(5, externalSku);
  await seedHoldRule([{ field: "channel", op: "eq", value: "amazon" }]);

  const eventBus = new InProcessEventBus();
  const orderService = new OrderService(pool, eventBus);
  const rulesEngine = new RulesEngine(pool);
  rulesEngine.attach(eventBus);

  const result = await orderService.persistPulledOrders(tenantId, [makeSyntheticOrder("HOLD-TEST-ORDER", externalSku, 2)]);
  assert.equal(result.insertedOrderIds.length, 1);
  const orderId = result.insertedOrderIds[0]!;

  const orderRow = await withTenant(pool, tenantId, (client) =>
    client.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [orderId]),
  );
  assert.equal(orderRow.rows[0]?.status, "on_hold", "must be held, not allocated or backordered");

  const reservations = await withTenant(pool, tenantId, (client) =>
    client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_events WHERE tenant_id = $1 AND reference_id = $2`,
      [tenantId, orderId],
    ),
  );
  assert.equal(reservations.rows[0]?.count, "0", "allocateOrder() must never have run for a held order");

  const executions = await withTenant(pool, tenantId, (client) =>
    client.query<{ matched: boolean; applied: boolean; error: string | null }>(
      `SELECT matched, applied, error FROM rule_executions WHERE tenant_id = $1 AND order_id = $2`,
      [tenantId, orderId],
    ),
  );
  assert.equal(executions.rows.length, 1);
  assert.deepEqual(executions.rows[0], { matched: true, applied: true, error: null });
});

test("a hold_order rule holding one order doesn't stop the rest of the same ingestion batch", async () => {
  // Isolated from the previous test's rule: same tenant, so its
  // channel='amazon' hold rule is still enabled and would otherwise also
  // match every order.received event below (both of this test's orders are
  // 'amazon' channel too), turning this into an unintended two-rules
  // tie-break case instead of the single-rule scenario this test means to
  // check.
  // app_user (withTenant/pool) has no DELETE grant on rule_executions --
  // only the schema-owning admin connection can clean these up, same as
  // this file's own after() hook.
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query("DELETE FROM rule_executions WHERE tenant_id = $1", [tenantId]);
  await admin.query("DELETE FROM automation_rules WHERE tenant_id = $1", [tenantId]);
  await admin.end();

  const heldSku = `SKU-${randomUUID().slice(0, 8)}`;
  const normalSku = `SKU-${randomUUID().slice(0, 8)}`;
  await seedProduct(5, heldSku);
  const normalProductId = await seedProduct(5, normalSku);
  // Only matches the held SKU's order (condition keys off external_order_id).
  await seedHoldRule([{ field: "externalOrderId", op: "eq", value: "BATCH-HELD-ORDER" }]);

  const eventBus = new InProcessEventBus();
  const orderService = new OrderService(pool, eventBus);
  const rulesEngine = new RulesEngine(pool);
  rulesEngine.attach(eventBus);

  const result = await orderService.persistPulledOrders(tenantId, [
    makeSyntheticOrder("BATCH-HELD-ORDER", heldSku, 1),
    makeSyntheticOrder("BATCH-NORMAL-ORDER", normalSku, 1),
  ]);
  assert.equal(result.insertedOrderIds.length, 2);

  const rows = await withTenant(pool, tenantId, (client) =>
    client.query<{ external_order_id: string; status: string }>(
      `SELECT external_order_id, status FROM orders WHERE id = ANY($1::uuid[]) ORDER BY external_order_id`,
      [result.insertedOrderIds],
    ),
  );
  assert.deepEqual(
    rows.rows,
    [
      { external_order_id: "BATCH-HELD-ORDER", status: "on_hold" },
      { external_order_id: "BATCH-NORMAL-ORDER", status: "allocated" },
    ],
    "the held order stops early, but the other order in the same batch still runs its full auto-chain",
  );

  const normalReservation = await withTenant(pool, tenantId, (client) =>
    client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_events WHERE tenant_id = $1 AND product_id = $2 AND event_type = 'reservation'`,
      [tenantId, normalProductId],
    ),
  );
  assert.equal(normalReservation.rows[0]?.count, "1");
});
