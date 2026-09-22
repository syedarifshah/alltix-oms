// Coverage for the 'webhook' action (packages/rules-engine/src/index.ts's
// executeAction()/buildRuleWebhookCall()/dispatchWebhook()) -- the fourth
// action type, alongside route_to_warehouse, hold_order, and
// send_notification. Intercepts globalThis.fetch the same way
// send-notification-integration.test.ts does for Resend -- this action's
// own outbound call is implemented with fetch() specifically so it can be
// tested this way (unlike e.g. Stripe's SDK, which defaults to Node's own
// http/https client and can't be intercepted this lightly -- see
// packages/billing-service/test/usage-reporter.test.ts's own header
// comment).
//
// Run with: npm run test --workspace=@alltix/rules-engine -- webhook-integration

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
import { RulesEngine, isBlockedWebhookHost } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
loadEnv({ path: join(REPO_ROOT, ".env") });

let pool: Pool;
let adminPool: Pool;
const tenantId = randomUUID();
let locationId: string;

before(async () => {
  const appConnectionString = process.env.APP_DATABASE_URL;
  const adminConnectionString = process.env.DATABASE_URL;
  if (!appConnectionString) throw new Error("APP_DATABASE_URL is not set (see .env.example)");
  if (!adminConnectionString) throw new Error("DATABASE_URL is not set (see .env.example)");
  pool = createAppPool({ connectionString: appConnectionString });
  adminPool = createAppPool({ connectionString: adminConnectionString });

  await adminPool.query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, [tenantId, `webhook-test-${tenantId.slice(0, 8)}`]);
  const clerkUserId = `test-clerk-${randomUUID()}`;
  await withTenantAndUser(pool, { tenantId, clerkUserId }, (client) =>
    client.query(`INSERT INTO users (tenant_id, clerk_user_id, email) VALUES ($1, $2, $3)`, [tenantId, clerkUserId, "owner@example.test"]),
  );

  locationId = await withTenant(pool, tenantId, async (client) => {
    const location = await client.query<{ id: string }>(
      `INSERT INTO locations (tenant_id, name, type) VALUES ($1, 'Webhook Test Warehouse', 'warehouse') RETURNING id`,
      [tenantId],
    );
    return location.rows[0]!.id;
  });
});

after(async () => {
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
      `INSERT INTO products (tenant_id, internal_sku, name) VALUES ($1, $2, 'Webhook Test Product') RETURNING id`,
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

/** Product with NO inventory_levels row at all -- allocateOrder() treats a
 *  missing row the same as on_hand=0 (its own `?? 0` fallback), so any
 *  quantity ordered is guaranteed insufficient and backorders during
 *  persistPulledOrders()'s own auto-chain -- same helper/reasoning as
 *  order-backordered-integration.test.ts's own seedZeroStockProduct(). */
async function seedZeroStockProduct(externalSku: string): Promise<string> {
  return withTenant(pool, tenantId, async (client) => {
    const product = await client.query<{ id: string }>(
      `INSERT INTO products (tenant_id, internal_sku, name) VALUES ($1, $2, 'Webhook Test Product (zero stock)') RETURNING id`,
      [tenantId, `INTERNAL-${externalSku}`],
    );
    const productId = product.rows[0]!.id;
    await client.query(
      `INSERT INTO channel_listings (tenant_id, product_id, channel, channel_marketplace, external_sku, listing_status)
       VALUES ($1, $2, 'amazon', 'US', $3, 'active')`,
      [tenantId, productId, externalSku],
    );
    return productId;
  });
}

async function seedRule(name: string, actions: unknown, triggerEvent = "order.received", priority = 100): Promise<string> {
  return withTenant(pool, tenantId, async (client) => {
    const rule = await client.query<{ id: string }>(
      `INSERT INTO automation_rules (tenant_id, name, trigger_event, conditions, actions, priority, enabled)
       VALUES ($1, $2, $3, '[]', $4, $5, true) RETURNING id`,
      [tenantId, name, triggerEvent, JSON.stringify(actions), priority],
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

async function readExecution(orderId: string, ruleId: string): Promise<{ applied: boolean; error: string | null }> {
  const executions = await withTenant(pool, tenantId, (client) =>
    client.query<{ applied: boolean; error: string | null }>(
      `SELECT applied, error FROM rule_executions WHERE tenant_id = $1 AND order_id = $2 AND automation_rule_id = $3`,
      [tenantId, orderId, ruleId],
    ),
  );
  return executions.rows[0]!;
}

test("isBlockedWebhookHost: pure -- blocks loopback/private/link-local/localhost, allows ordinary public hostnames", () => {
  assert.equal(isBlockedWebhookHost("127.0.0.1"), true);
  assert.equal(isBlockedWebhookHost("localhost"), true);
  assert.equal(isBlockedWebhookHost("printer.local"), true);
  assert.equal(isBlockedWebhookHost("10.0.0.5"), true);
  assert.equal(isBlockedWebhookHost("172.16.0.1"), true);
  assert.equal(isBlockedWebhookHost("172.31.255.255"), true);
  assert.equal(isBlockedWebhookHost("172.32.0.1"), false); // just outside the RFC1918 172.16/12 range
  assert.equal(isBlockedWebhookHost("192.168.1.1"), true);
  assert.equal(isBlockedWebhookHost("169.254.169.254"), true); // cloud metadata endpoint
  assert.equal(isBlockedWebhookHost("::1"), true);
  assert.equal(isBlockedWebhookHost("example.com"), false);
  assert.equal(isBlockedWebhookHost("api.mycompany.io"), false);
  assert.equal(isBlockedWebhookHost("8.8.8.8"), false);
});

test("a webhook action POSTs the expected JSON body to the tenant's configured URL, and rule_executions records applied:true", async () => {
  await cleanRulesAndExecutions();
  const externalSku = `SKU-${randomUUID().slice(0, 8)}`;
  await seedProductWithStock(5, externalSku);
  const ruleId = await seedRule("Notify our own system", [{ type: "webhook", value: "https://hooks.example.test/alltix" }]);

  const originalFetch = globalThis.fetch;
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    const eventBus = new InProcessEventBus();
    const orderService = new OrderService(pool, eventBus);
    const rulesEngine = new RulesEngine(pool);
    rulesEngine.attach(eventBus);

    const result = await orderService.persistPulledOrders(tenantId, [makeSyntheticOrder("WEBHOOK-HAPPY-PATH", externalSku)]);
    const orderId = result.insertedOrderIds[0]!;

    assert.equal(capturedUrl, "https://hooks.example.test/alltix");
    assert.equal(capturedInit?.method, "POST");
    assert.equal((capturedInit?.headers as Record<string, string>)["content-type"], "application/json");
    const body = JSON.parse(capturedInit?.body as string) as {
      event: string;
      orderId: string;
      ruleId: string;
      ruleName: string;
      occurredAt: string;
    };
    assert.equal(body.event, "order.received");
    assert.equal(body.orderId, orderId);
    assert.equal(body.ruleId, ruleId);
    assert.equal(body.ruleName, "Notify our own system");
    assert.ok(typeof body.occurredAt === "string" && !Number.isNaN(Date.parse(body.occurredAt)));

    const execution = await readExecution(orderId, ruleId);
    assert.deepEqual(execution, { applied: true, error: null });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a webhook action fires on the order.backordered trigger too, same as send_notification does", async () => {
  await cleanRulesAndExecutions();
  const externalSku = `SKU-${randomUUID().slice(0, 8)}`;
  await seedZeroStockProduct(externalSku);
  const ruleId = await seedRule(
    "Notify on backorder",
    [{ type: "webhook", value: "https://hooks.example.test/backorder" }],
    "order.backordered",
  );

  const originalFetch = globalThis.fetch;
  let callCount = 0;
  let capturedBody: string | undefined;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    callCount++;
    capturedBody = init?.body as string;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    const eventBus = new InProcessEventBus();
    const orderService = new OrderService(pool, eventBus);
    const rulesEngine = new RulesEngine(pool);
    rulesEngine.attach(eventBus);

    const result = await orderService.persistPulledOrders(tenantId, [makeSyntheticOrder("WEBHOOK-BACKORDER", externalSku)]);
    const orderId = result.insertedOrderIds[0]!;

    const orderRow = await withTenant(pool, tenantId, (client) =>
      client.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [orderId]),
    );
    assert.equal(orderRow.rows[0]?.status, "backordered", "sanity check: this order must actually have backordered");

    assert.equal(callCount, 1);
    const body = JSON.parse(capturedBody!) as { event: string };
    assert.equal(body.event, "order.backordered");

    const execution = await readExecution(orderId, ruleId);
    assert.deepEqual(execution, { applied: true, error: null });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a webhook action with a non-https URL throws and is recorded as this row's error", async () => {
  await cleanRulesAndExecutions();
  const externalSku = `SKU-${randomUUID().slice(0, 8)}`;
  await seedProductWithStock(5, externalSku);
  const ruleId = await seedRule("Plaintext target", [{ type: "webhook", value: "http://hooks.example.test/insecure" }]);

  const eventBus = new InProcessEventBus();
  const orderService = new OrderService(pool, eventBus);
  const rulesEngine = new RulesEngine(pool);
  rulesEngine.attach(eventBus);

  const result = await orderService.persistPulledOrders(tenantId, [makeSyntheticOrder("WEBHOOK-NON-HTTPS", externalSku)]);
  const orderId = result.insertedOrderIds[0]!;

  const execution = await readExecution(orderId, ruleId);
  assert.equal(execution.applied, false);
  assert.match(execution.error ?? "", /must use https:/);
});

test("a webhook action targeting a private/internal address throws and is recorded as this row's error, and never calls fetch", async () => {
  await cleanRulesAndExecutions();
  const externalSku = `SKU-${randomUUID().slice(0, 8)}`;
  await seedProductWithStock(5, externalSku);
  const ruleId = await seedRule("SSRF attempt", [{ type: "webhook", value: "https://169.254.169.254/latest/meta-data" }]);

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

    const result = await orderService.persistPulledOrders(tenantId, [makeSyntheticOrder("WEBHOOK-SSRF", externalSku)]);
    const orderId = result.insertedOrderIds[0]!;

    assert.equal(callCount, 0, "a blocked target must never reach fetch() at all");
    const execution = await readExecution(orderId, ruleId);
    assert.equal(execution.applied, false);
    assert.match(execution.error ?? "", /private\/internal address/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a webhook action with a missing/empty value throws and is recorded as this row's error", async () => {
  await cleanRulesAndExecutions();
  const externalSku = `SKU-${randomUUID().slice(0, 8)}`;
  await seedProductWithStock(5, externalSku);
  const ruleId = await seedRule("No URL configured", [{ type: "webhook", value: "" }]);

  const eventBus = new InProcessEventBus();
  const orderService = new OrderService(pool, eventBus);
  const rulesEngine = new RulesEngine(pool);
  rulesEngine.attach(eventBus);

  const result = await orderService.persistPulledOrders(tenantId, [makeSyntheticOrder("WEBHOOK-EMPTY-VALUE", externalSku)]);
  const orderId = result.insertedOrderIds[0]!;

  const execution = await readExecution(orderId, ruleId);
  assert.equal(execution.applied, false);
  assert.match(execution.error ?? "", /requires a non-empty string URL/);
});

test("a webhook POST that fails (non-2xx) never throws back into rule execution -- delivery is best-effort", async () => {
  await cleanRulesAndExecutions();
  const externalSku = `SKU-${randomUUID().slice(0, 8)}`;
  await seedProductWithStock(5, externalSku);
  const ruleId = await seedRule("Flaky endpoint", [{ type: "webhook", value: "https://hooks.example.test/flaky" }]);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("internal error", { status: 500 })) as typeof fetch;

  try {
    const eventBus = new InProcessEventBus();
    const orderService = new OrderService(pool, eventBus);
    const rulesEngine = new RulesEngine(pool);
    rulesEngine.attach(eventBus);

    const result = await orderService.persistPulledOrders(tenantId, [makeSyntheticOrder("WEBHOOK-500", externalSku)]);
    const orderId = result.insertedOrderIds[0]!;

    // Building/validating the webhook call succeeded, so this row still
    // shows applied:true -- the same "delivery outcome isn't tracked here"
    // contract send_notification already has (see this file's own header
    // comment and buildRuleWebhookCall's doc comment).
    const execution = await readExecution(orderId, ruleId);
    assert.deepEqual(execution, { applied: true, error: null });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
