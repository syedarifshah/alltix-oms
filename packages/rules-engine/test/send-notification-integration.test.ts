// Edge-case coverage for the 'send_notification' action
// (packages/rules-engine/src/index.ts's executeAction()/buildRuleNotification())
// triggered off order.received -- order-backordered-integration.test.ts
// already proves the happy path (default message, custom message, firing
// independently per trigger event) using the order.backordered trigger;
// this file covers the parts that don't depend on which trigger fired:
// RESEND_API_KEY left unset, an invalid (non-string) action.value, and an
// empty/whitespace-only string falling back to the default message.
//
// Same real-tenant-and-users requirement (and migration
// 0030_users_tenant_scoped_select_policy.sql dependency) as
// order-backordered-integration.test.ts -- see that file's own header
// comment for why.
//
// Run with: npm run test --workspace=@alltix/rules-engine -- send-notification-integration

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import type { Pool } from "pg";
import { createAppPool, withTenant, withTenantAndUser } from "@alltix/db";
import { InProcessEventBus } from "@alltix/shared";
import type { NormalizedOrder } from "@alltix/channel-connectors";
import { OrderService } from "@alltix/order-service";
import { RulesEngine } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
loadEnv({ path: join(REPO_ROOT, ".env") });

let pool: Pool;
let adminPool: Pool;
const tenantId = randomUUID();
let locationId: string;
const SEEDED_EMAIL = "owner@example.test";

before(async () => {
  const appConnectionString = process.env.APP_DATABASE_URL;
  const adminConnectionString = process.env.DATABASE_URL;
  if (!appConnectionString) throw new Error("APP_DATABASE_URL is not set (see .env.example)");
  if (!adminConnectionString) throw new Error("DATABASE_URL is not set (see .env.example)");
  pool = createAppPool({ connectionString: appConnectionString });
  adminPool = createAppPool({ connectionString: adminConnectionString });

  await adminPool.query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, [tenantId, `send-notify-test-${tenantId.slice(0, 8)}`]);
  const clerkUserId = `test-clerk-${randomUUID()}`;
  await withTenantAndUser(pool, { tenantId, clerkUserId }, (client) =>
    client.query(`INSERT INTO users (tenant_id, clerk_user_id, email) VALUES ($1, $2, $3)`, [tenantId, clerkUserId, SEEDED_EMAIL]),
  );

  locationId = await withTenant(pool, tenantId, async (client) => {
    const location = await client.query<{ id: string }>(
      `INSERT INTO locations (tenant_id, name, type) VALUES ($1, 'Send Notification Test Warehouse', 'warehouse') RETURNING id`,
      [tenantId],
    );
    return location.rows[0]!.id;
  });
});

after(async () => {
  await adminPool.query("DELETE FROM audit_log WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM rule_executions WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM automation_rules WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM inventory_events WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM orders WHERE tenant_id = $1", [tenantId]); // cascades order_lines
  await adminPool.query("DELETE FROM inventory_levels WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM users WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);

  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM channel_listings WHERE tenant_id = $1", [tenantId]));
  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM locations WHERE tenant_id = $1", [tenantId]));
  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM products WHERE tenant_id = $1", [tenantId]));
  await pool.end();
  await adminPool.end();
});

async function seedProductWithStock(onHand: number, externalSku: string): Promise<string> {
  return withTenant(pool, tenantId, async (client) => {
    const product = await client.query<{ id: string }>(
      `INSERT INTO products (tenant_id, internal_sku, name) VALUES ($1, $2, 'Send Notification Test Product') RETURNING id`,
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

async function seedRule(name: string, actions: unknown, priority = 100): Promise<string> {
  return withTenant(pool, tenantId, async (client) => {
    const rule = await client.query<{ id: string }>(
      `INSERT INTO automation_rules (tenant_id, name, trigger_event, conditions, actions, priority, enabled)
       VALUES ($1, $2, 'order.received', '[]', $3, $4, true) RETURNING id`,
      [tenantId, name, JSON.stringify(actions), priority],
    );
    return rule.rows[0]!.id;
  });
}

function makeSyntheticOrder(externalOrderId: string, externalSku: string): NormalizedOrder {
  return {
    externalOrderId,
    channel: "amazon",
    channelMarketplace: "US",
    placedAt: new Date().toISOString(),
    channelStatus: "Unshipped",
    customer: {},
    shippingAddress: {},
    lines: [{ externalLineId: `${externalOrderId}-line-1`, externalSku, quantity: 1, unitPrice: "9.99", fulfillmentType: "seller_fulfilled" }],
    rawPayload: { synthetic: true, note: "hand-built for this test, not a real SP-API response" },
  };
}

async function cleanRulesAndExecutions(): Promise<void> {
  await adminPool.query("DELETE FROM rule_executions WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM automation_rules WHERE tenant_id = $1", [tenantId]);
}

test("a send_notification action never calls fetch when RESEND_API_KEY is unset, but the rule_executions row still records applied:true", async () => {
  await cleanRulesAndExecutions();
  const externalSku = `SKU-${randomUUID().slice(0, 8)}`;
  await seedProductWithStock(5, externalSku);
  const ruleId = await seedRule("No key configured", [{ type: "send_notification", value: null }]);

  const originalApiKey = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount++;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    const eventBus = new InProcessEventBus();
    const orderService = new OrderService(pool, eventBus);
    const rulesEngine = new RulesEngine(pool);
    rulesEngine.attach(eventBus);

    const result = await orderService.persistPulledOrders(tenantId, [makeSyntheticOrder("SEND-NOTIF-NO-KEY", externalSku)]);
    const orderId = result.insertedOrderIds[0]!;

    assert.equal(callCount, 0, "sendEmail() itself must stay inert with no RESEND_API_KEY -- same as everywhere else it's used");

    const executions = await withTenant(pool, tenantId, (client) =>
      client.query<{ applied: boolean; error: string | null }>(
        `SELECT applied, error FROM rule_executions WHERE tenant_id = $1 AND order_id = $2 AND automation_rule_id = $3`,
        [tenantId, orderId, ruleId],
      ),
    );
    assert.deepEqual(
      executions.rows[0],
      { applied: true, error: null },
      "building the notification (and attempting to send it) never fails, even when the send itself is a no-op",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey !== undefined) process.env.RESEND_API_KEY = originalApiKey;
  }
});

test("a send_notification action with a non-string value throws and is recorded as this row's error, not applied", async () => {
  await cleanRulesAndExecutions();
  const externalSku = `SKU-${randomUUID().slice(0, 8)}`;
  await seedProductWithStock(5, externalSku);
  const ruleId = await seedRule("Misconfigured value", [{ type: "send_notification", value: 12345 }]);

  const eventBus = new InProcessEventBus();
  const orderService = new OrderService(pool, eventBus);
  const rulesEngine = new RulesEngine(pool);
  rulesEngine.attach(eventBus);

  const result = await orderService.persistPulledOrders(tenantId, [makeSyntheticOrder("SEND-NOTIF-BAD-VALUE", externalSku)]);
  const orderId = result.insertedOrderIds[0]!;

  const executions = await withTenant(pool, tenantId, (client) =>
    client.query<{ applied: boolean; error: string | null }>(
      `SELECT applied, error FROM rule_executions WHERE tenant_id = $1 AND order_id = $2 AND automation_rule_id = $3`,
      [tenantId, orderId, ruleId],
    ),
  );
  assert.equal(executions.rows[0]?.applied, false);
  assert.match(executions.rows[0]?.error ?? "", /send_notification's value must be a string message or omitted/);
});

test("a send_notification action with an empty/whitespace-only string value falls back to the default message, same as omitting it", async () => {
  await cleanRulesAndExecutions();
  const externalSku = `SKU-${randomUUID().slice(0, 8)}`;
  await seedProductWithStock(5, externalSku);
  await seedRule("Blank value", [{ type: "send_notification", value: "   " }]);

  const originalApiKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = "re_test_key";
  const originalFetch = globalThis.fetch;
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    capturedInit = init;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    const eventBus = new InProcessEventBus();
    const orderService = new OrderService(pool, eventBus);
    const rulesEngine = new RulesEngine(pool);
    rulesEngine.attach(eventBus);

    await orderService.persistPulledOrders(tenantId, [makeSyntheticOrder("SEND-NOTIF-BLANK-VALUE", externalSku)]);

    const body = JSON.parse(capturedInit?.body as string) as { text: string; to: string[] };
    assert.deepEqual(body.to, [SEEDED_EMAIL]);
    assert.match(body.text, /matched a order\.received event/, "a whitespace-only value must behave exactly like omitting value entirely");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.RESEND_API_KEY;
    } else {
      process.env.RESEND_API_KEY = originalApiKey;
    }
  }
});
