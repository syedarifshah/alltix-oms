// Proves RulesEngine's second trigger event (order.backordered, added
// alongside the new 'send_notification' action -- see index.ts's own doc
// comments on both) end to end: OrderService + a real InProcessEventBus +
// RulesEngine, wired together and run against real Postgres, same pattern
// as order-received-integration.test.ts/hold-order-integration.test.ts.
//
// Needs a REAL `tenants` row + `users` row(s), not just a synthetic
// tenantId (unlike this package's other integration tests, which never
// touch `users` at all) -- send_notification's whole point is emailing the
// tenant's own users, and `users.tenant_id` is the one table in this schema
// with a real FK to `tenants(id)` (migration 0010's own comment). Also
// depends on migration 0030_users_tenant_scoped_select_policy.sql's
// tenant-scoped SELECT policy on `users` -- without it this file's
// send_notification assertions would silently see zero recipients, the
// exact real bug that migration's own doc comment describes finding while
// testing the scheduler's parallel notifyTenantUsers().
//
// Requires a live Postgres (npm run db:migrate) and no real Resend account
// -- global.fetch is stubbed, same save/restore-in-`finally` discipline
// packages/shared/test/email.test.ts already established.
//
// Run with: npm run test --workspace=@alltix/rules-engine -- order-backordered-integration

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { Client, type Pool } from "pg";
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
const SEEDED_EMAILS = ["owner@example.test", "teammate@example.test"];

before(async () => {
  const appConnectionString = process.env.APP_DATABASE_URL;
  const adminConnectionString = process.env.DATABASE_URL;
  if (!appConnectionString) throw new Error("APP_DATABASE_URL is not set (see .env.example)");
  if (!adminConnectionString) throw new Error("DATABASE_URL is not set (see .env.example)");
  pool = createAppPool({ connectionString: appConnectionString });
  adminPool = createAppPool({ connectionString: adminConnectionString });

  // A real `tenants` row (app_user has no INSERT grant there -- migration
  // 0010's own GRANT statements -- so this goes through adminPool, same
  // reasoning as SyncAmazonOrdersParams.adminPool's own doc comment), then
  // real `users` rows under it (withTenantAndUser sets both
  // app.tenant_id/app.clerk_user_id so the self_lookup_users RLS policy's
  // own WITH CHECK is satisfied, exactly like provisionTenantForNewUser()
  // does for a real signup).
  await adminPool.query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, [tenantId, `rules-backorder-test-${tenantId.slice(0, 8)}`]);
  for (const email of SEEDED_EMAILS) {
    const clerkUserId = `test-clerk-${randomUUID()}`;
    await withTenantAndUser(pool, { tenantId, clerkUserId }, (client) =>
      client.query(`INSERT INTO users (tenant_id, clerk_user_id, email) VALUES ($1, $2, $3)`, [tenantId, clerkUserId, email]),
    );
  }

  // One warehouse, deliberately never given any stock in these tests --
  // every order below is guaranteed to backorder, which is the whole point.
  locationId = await withTenant(pool, tenantId, async (client) => {
    const location = await client.query<{ id: string }>(
      `INSERT INTO locations (tenant_id, name, type) VALUES ($1, 'Backorder Test Warehouse', 'warehouse') RETURNING id`,
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
  // app_user has no DELETE grant on users/tenants either (migration 0010) --
  // same adminPool-for-cleanup pattern sync-failure-tracking.test.ts's own
  // cleanupTenantWithUsers() uses, users first to respect the FK.
  await adminPool.query("DELETE FROM users WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);

  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM channel_listings WHERE tenant_id = $1", [tenantId]));
  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM locations WHERE tenant_id = $1", [tenantId]));
  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM products WHERE tenant_id = $1", [tenantId]));
  await pool.end();
  await adminPool.end();
});

/** Product with NO inventory_levels row at all -- allocateOrder() treats a
 *  missing row the same as on_hand=0 (its own `?? 0` fallback), so any
 *  quantity ordered is guaranteed insufficient. */
async function seedZeroStockProduct(externalSku: string): Promise<string> {
  return withTenant(pool, tenantId, async (client) => {
    const product = await client.query<{ id: string }>(
      `INSERT INTO products (tenant_id, internal_sku, name) VALUES ($1, $2, 'Backorder Test Product') RETURNING id`,
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

async function seedRule(
  name: string,
  triggerEvent: string,
  conditions: unknown,
  actions: unknown,
  priority = 100,
): Promise<string> {
  return withTenant(pool, tenantId, async (client) => {
    const rule = await client.query<{ id: string }>(
      `INSERT INTO automation_rules (tenant_id, name, trigger_event, conditions, actions, priority, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING id`,
      [tenantId, name, triggerEvent, JSON.stringify(conditions), JSON.stringify(actions), priority],
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

test("a send_notification rule scoped to order.backordered fires (with the default message) exactly when an order can't be allocated", async () => {
  await cleanRulesAndExecutions();
  const externalSku = `SKU-${randomUUID().slice(0, 8)}`;
  await seedZeroStockProduct(externalSku);
  const ruleId = await seedRule("Notify on backorder", "order.backordered", [], [{ type: "send_notification", value: null }]);

  const originalApiKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = "re_test_key";
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    callCount++;
    capturedInit = init;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    const eventBus = new InProcessEventBus();
    const orderService = new OrderService(pool, eventBus);
    const rulesEngine = new RulesEngine(pool);
    rulesEngine.attach(eventBus);

    const result = await orderService.persistPulledOrders(tenantId, [makeSyntheticOrder("BACKORDER-NOTIFY-1", externalSku)]);
    assert.equal(result.insertedOrderIds.length, 1);
    const orderId = result.insertedOrderIds[0]!;

    const orderRow = await withTenant(pool, tenantId, (client) =>
      client.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [orderId]),
    );
    assert.equal(orderRow.rows[0]?.status, "backordered", "sanity check: this order must actually have backordered");

    assert.equal(callCount, 1, "must email exactly once -- no order.received rule is seeded in this test, only the backorder one");

    const body = JSON.parse(capturedInit?.body as string) as { to: string[]; subject: string; text: string };
    assert.deepEqual([...body.to].sort(), [...SEEDED_EMAILS].sort());
    assert.match(body.subject, /Notify on backorder/);
    assert.match(body.text, /order\.backordered/);
    assert.match(body.text, new RegExp(orderId));

    const executions = await withTenant(pool, tenantId, (client) =>
      client.query<{ matched: boolean; applied: boolean; error: string | null; trigger_event: string }>(
        `SELECT matched, applied, error, trigger_event FROM rule_executions WHERE tenant_id = $1 AND order_id = $2 AND automation_rule_id = $3`,
        [tenantId, orderId, ruleId],
      ),
    );
    assert.equal(executions.rows.length, 1);
    assert.deepEqual(executions.rows[0], { matched: true, applied: true, error: null, trigger_event: "order.backordered" });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.RESEND_API_KEY;
    } else {
      process.env.RESEND_API_KEY = originalApiKey;
    }
  }
});

test("order.received- and order.backordered-scoped send_notification rules on the same order fire independently, once each, with their own custom messages", async () => {
  await cleanRulesAndExecutions();
  const externalSku = `SKU-${randomUUID().slice(0, 8)}`;
  await seedZeroStockProduct(externalSku);
  await seedRule("Notify on receipt", "order.received", [], [{ type: "send_notification", value: "Received custom message" }]);
  await seedRule("Notify on backorder", "order.backordered", [], [{ type: "send_notification", value: "Backordered custom message" }]);

  const originalApiKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = "re_test_key";
  const originalFetch = globalThis.fetch;
  const capturedBodies: string[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    capturedBodies.push(init?.body as string);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    const eventBus = new InProcessEventBus();
    const orderService = new OrderService(pool, eventBus);
    const rulesEngine = new RulesEngine(pool);
    rulesEngine.attach(eventBus);

    const result = await orderService.persistPulledOrders(tenantId, [makeSyntheticOrder("BACKORDER-NOTIFY-2", externalSku)]);
    assert.equal(result.insertedOrderIds.length, 1);

    assert.equal(capturedBodies.length, 2, "one email per matching trigger event, not a combined/deduped single email");
    const texts = capturedBodies.map((b) => (JSON.parse(b) as { text: string }).text);
    assert.ok(texts.some((t) => t.includes("Received custom message")), "the order.received rule's own custom message must have gone out");
    assert.ok(
      texts.some((t) => t.includes("Backordered custom message")),
      "the order.backordered rule's own custom message must have gone out too",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.RESEND_API_KEY;
    } else {
      process.env.RESEND_API_KEY = originalApiKey;
    }
  }
});

test("a hold_order rule scoped to order.backordered fails loud (order is already 'backordered', not 'received') and is recorded as this row's error", async () => {
  await cleanRulesAndExecutions();
  const externalSku = `SKU-${randomUUID().slice(0, 8)}`;
  await seedZeroStockProduct(externalSku);
  const ruleId = await seedRule("Misconfigured hold on backorder", "order.backordered", [], [{ type: "hold_order", value: null }]);

  const eventBus = new InProcessEventBus();
  const orderService = new OrderService(pool, eventBus);
  const rulesEngine = new RulesEngine(pool);
  rulesEngine.attach(eventBus);

  const result = await orderService.persistPulledOrders(tenantId, [makeSyntheticOrder("BACKORDER-BAD-HOLD", externalSku)]);
  const orderId = result.insertedOrderIds[0]!;

  const orderRow = await withTenant(pool, tenantId, (client) =>
    client.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [orderId]),
  );
  assert.equal(orderRow.rows[0]?.status, "backordered", "the failed hold_order action must not have changed the order's real status");

  const executions = await withTenant(pool, tenantId, (client) =>
    client.query<{ matched: boolean; applied: boolean; error: string | null }>(
      `SELECT matched, applied, error FROM rule_executions WHERE tenant_id = $1 AND order_id = $2 AND automation_rule_id = $3`,
      [tenantId, orderId, ruleId],
    ),
  );
  assert.equal(executions.rows.length, 1);
  assert.equal(executions.rows[0]?.matched, true);
  assert.equal(executions.rows[0]?.applied, false, "must be recorded as NOT applied -- the action itself threw");
  assert.match(executions.rows[0]?.error ?? "", /not in status 'received'/);
});
