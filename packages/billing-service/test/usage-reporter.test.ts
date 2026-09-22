// Coverage for real usage-based billing (packages/billing-service/src/index.ts's
// UsageReporter, buildOrderUsageMeterEventParams, buildCheckoutSessionLineItems,
// and getBillingSummary's usageBasedBillingConfigured field).
//
// What this file deliberately does NOT do: make a real network call to
// Stripe. UsageReporter.handleOrderReceived only ever reaches
// getStripeClient().billing.meterEvents.create(...) when both
// STRIPE_SECRET_KEY is set AND the tenant already has a stripe_customer_id
// -- every scenario below stays on one side or the other of that guard, so
// no test here ever constructs a real Stripe client against a real (or
// fake) key and fires an HTTP request. This is the same reasoning
// scripts/run-tests.sh's AMAZON_SANDBOX_TESTS carve-out documents for
// Amazon: there's no stripe-mock server wired into this repo, and this SDK
// version's default HTTP client is Node's own http/https modules (not
// `fetch`), so it can't be intercepted the lightweight way
// packages/shared/test/email.test.ts and
// send-notification-integration.test.ts override `globalThis.fetch` for
// Resend. Genuinely verifying a live Stripe Meter Event lands (Stripe
// Dashboard -> Meters) is a manual step: run
// `npm run stripe:setup-usage-metered-price` with a real test-mode
// STRIPE_SECRET_KEY, then trigger a real sync.
//
// Same real-tenant-and-users requirement as
// order-backordered-integration.test.ts for the parts of this file that do
// touch Postgres (RulesEngine's own migration-0030 dependency doesn't apply
// here -- UsageReporter never queries `users` -- but the seeding pattern is
// reused for consistency).
//
// Run with: npm run test --workspace=@alltix/billing-service

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import type { Pool } from "pg";
import { createAppPool, withTenant } from "@alltix/db";
import { InProcessEventBus } from "@alltix/shared";
import type { NormalizedOrder } from "@alltix/channel-connectors";
import { OrderService } from "@alltix/order-service";
import {
  UsageReporter,
  buildOrderUsageMeterEventParams,
  buildCheckoutSessionLineItems,
  getBillingSummary,
  ORDERS_PROCESSED_METER_EVENT_NAME,
} from "../src/index.js";

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

  await adminPool.query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, [tenantId, `usage-reporter-test-${tenantId.slice(0, 8)}`]);

  locationId = await withTenant(pool, tenantId, async (client) => {
    const location = await client.query<{ id: string }>(
      `INSERT INTO locations (tenant_id, name, type) VALUES ($1, 'Usage Reporter Test Warehouse', 'warehouse') RETURNING id`,
      [tenantId],
    );
    return location.rows[0]!.id;
  });
});

after(async () => {
  await adminPool.query("DELETE FROM inventory_events WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM orders WHERE tenant_id = $1", [tenantId]); // cascades order_lines
  await adminPool.query("DELETE FROM inventory_levels WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tenant_usage WHERE tenant_id = $1", [tenantId]);
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
      `INSERT INTO products (tenant_id, internal_sku, name) VALUES ($1, $2, 'Usage Reporter Test Product') RETURNING id`,
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

test("buildOrderUsageMeterEventParams: pure, matches the Meter's default customer_mapping/value_settings keys and derives an idempotent identifier from orderId alone", () => {
  const params = buildOrderUsageMeterEventParams("cus_test_123", "order-abc");
  assert.deepEqual(params, {
    event_name: ORDERS_PROCESSED_METER_EVENT_NAME,
    identifier: "order-usage:order-abc",
    payload: { stripe_customer_id: "cus_test_123", value: "1" },
  });

  // Same orderId -> same identifier, every time -- this is what makes it
  // usable as Stripe's own idempotency key for a redelivered event.
  const again = buildOrderUsageMeterEventParams("cus_test_123", "order-abc");
  assert.equal(again.identifier, params.identifier);
});

test("buildCheckoutSessionLineItems: one flat line item when no metered price is configured", () => {
  const lineItems = buildCheckoutSessionLineItems("price_flat_123");
  assert.deepEqual(lineItems, [{ price: "price_flat_123", quantity: 1 }]);
});

test("buildCheckoutSessionLineItems: adds a second, quantity-less metered line item when STRIPE_METERED_ORDERS_PRICE_ID-equivalent is passed", () => {
  const lineItems = buildCheckoutSessionLineItems("price_flat_123", "price_metered_456");
  assert.deepEqual(lineItems, [
    { price: "price_flat_123", quantity: 1 },
    { price: "price_metered_456" },
  ]);
  assert.ok(!("quantity" in lineItems[1]!), "a metered price's line item must not carry a quantity field");
});

test("UsageReporter never calls Stripe (and never throws) when STRIPE_SECRET_KEY is unset -- same as every other optional integration in this codebase", async () => {
  const externalSku = `SKU-${randomUUID().slice(0, 8)}`;
  await seedProductWithStock(5, externalSku);

  const originalKey = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;

  try {
    const eventBus = new InProcessEventBus();
    const orderService = new OrderService(pool, eventBus);
    const usageReporter = new UsageReporter(pool);
    usageReporter.attach(eventBus);

    const result = await orderService.persistPulledOrders(tenantId, [makeSyntheticOrder("USAGE-NO-KEY", externalSku)]);
    assert.equal(result.insertedOrderIds.length, 1, "UsageReporter being attached must never block order ingestion");

    // tenant_usage still increments exactly as it did before UsageReporter
    // existed (packages/order-service/src/index.ts's own
    // incrementOrdersProcessedUsage, inside persistPulledOrders' own
    // transaction) -- this subscriber only adds a Stripe report on top,
    // it doesn't change what already worked.
    const month = new Date().toISOString().slice(0, 7);
    const usage = await withTenant(pool, tenantId, (client) =>
      client.query<{ orders_processed: number }>(`SELECT orders_processed FROM tenant_usage WHERE tenant_id = $1 AND month = $2`, [
        tenantId,
        month,
      ]),
    );
    assert.equal(usage.rows[0]?.orders_processed, 1);
  } finally {
    if (originalKey !== undefined) process.env.STRIPE_SECRET_KEY = originalKey;
  }
});

test("UsageReporter never reaches Stripe when the tenant has no stripe_customer_id yet, even with STRIPE_SECRET_KEY set", async () => {
  const externalSku = `SKU-${randomUUID().slice(0, 8)}`;
  await seedProductWithStock(5, externalSku);

  // Confirm this tenant genuinely has no Stripe customer (never visited
  // /settings/billing in this test) before relying on that being the
  // reason the early-return fires.
  const existing = await withTenant(pool, tenantId, (client) =>
    client.query<{ stripe_customer_id: string | null }>(`SELECT stripe_customer_id FROM tenants WHERE id = $1`, [tenantId]),
  );
  assert.equal(existing.rows[0]?.stripe_customer_id, null);

  const originalKey = process.env.STRIPE_SECRET_KEY;
  // A syntactically-plausible but fake key -- if UsageReporter's
  // no-stripe-customer guard didn't fire before the Stripe call, this
  // would hang/fail against a real request, not silently succeed, so a
  // passing test here is real evidence the guard worked.
  process.env.STRIPE_SECRET_KEY = "sk_test_fake_never_actually_used";

  try {
    const eventBus = new InProcessEventBus();
    const orderService = new OrderService(pool, eventBus);
    const usageReporter = new UsageReporter(pool);
    usageReporter.attach(eventBus);

    const result = await orderService.persistPulledOrders(tenantId, [makeSyntheticOrder("USAGE-NO-CUSTOMER", externalSku)]);
    assert.equal(result.insertedOrderIds.length, 1);
  } finally {
    if (originalKey === undefined) {
      delete process.env.STRIPE_SECRET_KEY;
    } else {
      process.env.STRIPE_SECRET_KEY = originalKey;
    }
  }
});

test("getBillingSummary's usageBasedBillingConfigured reflects STRIPE_METERED_ORDERS_PRICE_ID being set, independent of everything else on the summary", async () => {
  const originalPriceId = process.env.STRIPE_METERED_ORDERS_PRICE_ID;

  try {
    delete process.env.STRIPE_METERED_ORDERS_PRICE_ID;
    const unconfigured = await getBillingSummary(pool, tenantId);
    assert.equal(unconfigured.usageBasedBillingConfigured, false);

    process.env.STRIPE_METERED_ORDERS_PRICE_ID = "price_metered_test";
    const configured = await getBillingSummary(pool, tenantId);
    assert.equal(configured.usageBasedBillingConfigured, true);
  } finally {
    if (originalPriceId === undefined) {
      delete process.env.STRIPE_METERED_ORDERS_PRICE_ID;
    } else {
      process.env.STRIPE_METERED_ORDERS_PRICE_ID = originalPriceId;
    }
  }
});
