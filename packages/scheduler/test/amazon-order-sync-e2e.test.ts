// The real, end-to-end proof for the scheduled Amazon order-sync job:
// a real sandbox tenant, discovered by syncAmazonOrders()'s cross-tenant
// enumeration query (not handed to it directly, the way every other test
// this session constructs its tenant), synced through the actual job path
// -- pullOrders() against live SP-API, persistPulledOrders(), a real
// order.received publish on a real EventBus, RulesEngine evaluating and
// applying a route_to_warehouse action through that same bus, and
// allocateOrder() honoring the routing decision. Same "prove it against
// something real, not a mock" discipline as every other pass this session.
//
// The routed location is deliberately NOT the default (oldest) warehouse
// -- exactly like order-received-integration.test.ts's proof -- so success
// can only mean the rule genuinely fired through the real job path, not
// that the default happened to be right anyway.
//
// Requires a live Postgres (npm run db:migrate) and real Amazon sandbox
// credentials in .env, same as the other Amazon-sandbox tests.
//
// Run with: npm run test --workspace=@alltix/scheduler -- amazon-order-sync-e2e

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { Client, type Pool } from "pg";
import { createAppPool, withTenant } from "@alltix/db";
import { InProcessEventBus } from "@alltix/shared";
import { syncAmazonOrders } from "../src/index.js";
import { seedTestChannelConnection } from "../../../scripts/seed-test-channel-connection.js";
import {
  SANDBOX_ORDER_ITEM_ASIN,
  SANDBOX_ORDER_ITEM_EXTERNAL_SKU,
} from "../../../scripts/seed-test-product-catalog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

loadEnv({ path: join(REPO_ROOT, ".env") });

let appPool: Pool;
let adminPool: Pool;
let tenantId: string;
let defaultLocationId: string;
let routedLocationId: string;
let productId: string;
const ROUTED_LOCATION_NAME = "Amazon Sync Job Test Warehouse 2 (Routed)";

before(async () => {
  const appConnectionString = process.env.APP_DATABASE_URL;
  const adminConnectionString = process.env.DATABASE_URL;
  if (!appConnectionString) throw new Error("APP_DATABASE_URL is not set (see .env.example)");
  if (!adminConnectionString) throw new Error("DATABASE_URL is not set (see .env.example)");

  appPool = createAppPool({ connectionString: appConnectionString });
  adminPool = createAppPool({ connectionString: adminConnectionString });

  // A real `tenants` row, seeded first via a fresh tenantId and the admin
  // connection (app_user has no INSERT grant on tenants -- migration 0010's
  // own comment) -- needed now that syncAmazonOrders()'s discovery query
  // joins `tenants` and requires 'amazon' = ANY(enabled_channels), part of
  // closing CLAUDE.md §12's "channel feature flags don't gate ongoing sync"
  // gap. seedTestChannelConnection() itself stays unchanged (its own
  // default-tenantId path is also used by scripts/amazon-pull-orders-
  // smoke-test.ts, which never goes through that discovery query at all --
  // see that script's own doc comment) -- its optional tenantId parameter
  // already exists for exactly this "attach to a tenant that already
  // exists" case.
  const testTenantId = randomUUID();
  const seedAdmin = new Client({ connectionString: process.env.DATABASE_URL });
  await seedAdmin.connect();
  await seedAdmin.query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, [
    testTenantId,
    `amazon-sync-e2e-test-${testTenantId.slice(0, 8)}`,
  ]);
  await seedAdmin.end();

  const seeded = await seedTestChannelConnection(appPool, testTenantId);
  tenantId = seeded.tenantId;

  await withTenant(appPool, tenantId, async (client) => {
    // Created first (the default allocateOrder() would pick), deliberately
    // given no stock -- see this file's header comment.
    const defaultLocation = await client.query<{ id: string }>(
      `INSERT INTO locations (tenant_id, name, type) VALUES ($1, 'Amazon Sync Job Test Warehouse 1 (Default)', 'warehouse') RETURNING id`,
      [tenantId],
    );
    defaultLocationId = defaultLocation.rows[0]!.id;

    const routedLocation = await client.query<{ id: string }>(
      `INSERT INTO locations (tenant_id, name, type) VALUES ($1, $2, 'warehouse') RETURNING id`,
      [tenantId, ROUTED_LOCATION_NAME],
    );
    routedLocationId = routedLocation.rows[0]!.id;

    const product = await client.query<{ id: string }>(
      `INSERT INTO products (tenant_id, internal_sku, name)
       VALUES ($1, $2, 'Amazon Sync Job Test Product') RETURNING id`,
      [tenantId, `SYNCJOB-${tenantId.slice(0, 8)}`],
    );
    productId = product.rows[0]!.id;

    await client.query(
      `INSERT INTO channel_listings
         (tenant_id, product_id, channel, channel_marketplace, external_id, external_sku, listing_status)
       VALUES ($1, $2, 'amazon', 'US', $3, $4, 'active')`,
      [tenantId, productId, SANDBOX_ORDER_ITEM_ASIN, SANDBOX_ORDER_ITEM_EXTERNAL_SKU],
    );

    // Stock only at the routed location -- the sandbox's canned orders
    // pull 1 unit each (confirmed live elsewhere this session), so 10
    // comfortably covers them.
    await client.query(
      `INSERT INTO inventory_levels (tenant_id, product_id, location_id, on_hand, reserved) VALUES ($1, $2, $3, 10, 0)`,
      [tenantId, productId, routedLocationId],
    );

    await client.query(
      `INSERT INTO automation_rules (tenant_id, name, trigger_event, conditions, actions, priority, enabled)
       VALUES ($1, 'Route Amazon orders to WH2', 'order.received', $2, $3, 100, true)`,
      [
        tenantId,
        JSON.stringify([{ field: "channel", op: "eq", value: "amazon" }]),
        JSON.stringify([{ type: "route_to_warehouse", value: ROUTED_LOCATION_NAME }]),
      ],
    );
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
  await admin.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
  await admin.end();

  await withTenant(appPool, tenantId, (client) => client.query("DELETE FROM channel_listings WHERE tenant_id = $1", [tenantId]));
  await withTenant(appPool, tenantId, (client) => client.query("DELETE FROM locations WHERE tenant_id = $1", [tenantId]));
  await withTenant(appPool, tenantId, (client) => client.query("DELETE FROM products WHERE tenant_id = $1", [tenantId]));
  await withTenant(appPool, tenantId, (client) =>
    client.query("DELETE FROM channel_connections WHERE tenant_id = $1", [tenantId]),
  );
  await appPool.end();
  await adminPool.end();
});

test("syncAmazonOrders discovers the sandbox tenant, pulls real orders, and routes+allocates them through the real job path", async () => {
  const eventBus = new InProcessEventBus();

  const results = await syncAmazonOrders({ appPool, adminPool, eventBus });

  const ourResult = results.find((r) => r.tenantId === tenantId);
  assert.ok(ourResult, "syncAmazonOrders must discover our seeded tenant via its cross-tenant enumeration query");
  assert.equal(ourResult.success, true, `sync must succeed: ${ourResult.error}`);
  assert.ok(ourResult.insertedOrderIds.length > 0, "the real sandbox pull must return at least one canned order");

  const orders = await withTenant(appPool, tenantId, (client) =>
    client.query<{ id: string; status: string; preferred_location_id: string | null }>(
      `SELECT id, status, preferred_location_id FROM orders WHERE tenant_id = $1`,
      [tenantId],
    ),
  );
  assert.equal(orders.rows.length, ourResult.insertedOrderIds.length);
  for (const order of orders.rows) {
    assert.equal(order.status, "allocated", "must allocate, not backorder -- proves it used the routed location's stock");
    assert.equal(order.preferred_location_id, routedLocationId, "the routing rule must have set preferred_location_id");
  }

  const events = await withTenant(appPool, tenantId, (client) =>
    client.query<{ location_id: string }>(
      `SELECT location_id FROM inventory_events WHERE tenant_id = $1 AND event_type = 'reservation'`,
      [tenantId],
    ),
  );
  assert.ok(events.rows.length > 0);
  for (const event of events.rows) {
    assert.equal(event.location_id, routedLocationId, "every reservation must land at the routed location, not the default");
  }

  const executions = await withTenant(appPool, tenantId, (client) =>
    client.query<{ matched: boolean; applied: boolean; error: string | null }>(
      `SELECT matched, applied, error FROM rule_executions WHERE tenant_id = $1`,
      [tenantId],
    ),
  );
  assert.ok(executions.rows.length > 0, "the routing rule must have logged at least one rule_executions row");
  for (const execution of executions.rows) {
    assert.deepEqual(execution, { matched: true, applied: true, error: null });
  }

  const connection = await withTenant(appPool, tenantId, (client) =>
    client.query<{ last_order_sync_at: string | null }>(
      `SELECT last_order_sync_at FROM channel_connections WHERE tenant_id = $1 AND channel = 'amazon'`,
      [tenantId],
    ),
  );
  assert.notEqual(connection.rows[0]?.last_order_sync_at, null, "a successful sync must record last_order_sync_at");

  const defaultLevels = await withTenant(appPool, tenantId, (client) =>
    client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_levels WHERE product_id = $1 AND location_id = $2`,
      [productId, defaultLocationId],
    ),
  );
  assert.equal(defaultLevels.rows[0]?.count, "0", "no inventory_levels row should exist at the default location at all");
});
