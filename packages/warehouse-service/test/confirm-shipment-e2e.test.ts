// Proves the full chain from a real Amazon sandbox pull through to a real
// confirmShipment call against live SP-API infrastructure -- no mock,
// same "prove it against something real" discipline as
// order-service/test/pull-and-allocate-e2e.test.ts, which this test
// continues past 'allocated' through picking/packing into shipment
// confirmation.
//
// AmazonConnector.confirmShipment() is verified live here, but its own doc
// comment documents a real, confirmed sandbox limitation: the SP-API
// static sandbox has no matching test scenario for shipmentConfirmation on
// this account (every request shape tried -- including Amazon's own
// documented example values -- gets the generic
// "400 InvalidInput: Could not match input arguments" no-scenario-matched
// response, not an auth or malformed-request error). So this test asserts
// exactly that documented failure, not a synthetic success -- and asserts
// the order stays 'packed' rather than silently flipping to 'shipped',
// proving confirmShipment() only transitions the order once the channel
// genuinely confirms it.
//
// Requires a live Postgres (npm run db:migrate) and real Amazon sandbox
// credentials in .env, same as the other Amazon-sandbox tests.
//
// Run with: npm run test --workspace=@alltix/warehouse-service -- confirm-shipment-e2e

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { Client, type Pool } from "pg";
import { createAppPool, withTenant, withTenantAndUser } from "@alltix/db";
import {
  createAmazonConnectorFromChannelConnection,
  SP_API_SANDBOX_TEST_CASE_CREATED_AFTER,
} from "@alltix/channel-connectors";
import { OrderService } from "@alltix/order-service";
import { WarehouseService } from "../src/index.js";
import { seedTestChannelConnection } from "../../../scripts/seed-test-channel-connection.js";
import { seedTestProductCatalog } from "../../../scripts/seed-test-product-catalog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

loadEnv({ path: join(REPO_ROOT, ".env") });

let pool: Pool;
let tenantId: string;
let pickerUserId: string;
let orderService: OrderService;
let warehouseService: WarehouseService;

before(async () => {
  const connectionString = process.env.APP_DATABASE_URL;
  if (!connectionString) {
    throw new Error("APP_DATABASE_URL is not set (see .env.example)");
  }
  pool = createAppPool({ connectionString });
  orderService = new OrderService(pool);
  warehouseService = new WarehouseService(pool, orderService);

  const seeded = await seedTestChannelConnection(pool);
  tenantId = seeded.tenantId;

  // 10 on hand comfortably covers the sandbox's canned orders x 1 unit
  // each, same headroom pull-and-allocate-e2e.test.ts uses.
  await seedTestProductCatalog(pool, tenantId, 10);

  // users.tenant_id is a real FK to tenants(id) -- seedTestChannelConnection
  // mints a fresh tenantId without a backing tenants row (every other
  // Amazon-sandbox test only needs RLS-scoped tenant_id, no real row), so
  // one has to be created here before a user can reference it.
  const clerkUserId = `picker-${tenantId}`;
  pickerUserId = await withTenantAndUser(pool, { tenantId, clerkUserId }, async (client) => {
    await client.query(`INSERT INTO tenants (id, name) VALUES ($1, 'Confirm Shipment E2E Test Tenant')`, [tenantId]);
    const user = await client.query<{ id: string }>(
      `INSERT INTO users (tenant_id, clerk_user_id, email) VALUES ($1, $2, $3) RETURNING id`,
      [tenantId, clerkUserId, `${clerkUserId}@example.com`],
    );
    return user.rows[0]!.id;
  });
});

after(async () => {
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query("DELETE FROM picklist_lines WHERE tenant_id = $1", [tenantId]);
  await admin.query("DELETE FROM picklists WHERE tenant_id = $1", [tenantId]);
  await admin.query("DELETE FROM inventory_events WHERE tenant_id = $1", [tenantId]);
  await admin.query("DELETE FROM orders WHERE tenant_id = $1", [tenantId]); // cascades order_lines
  await admin.query("DELETE FROM inventory_levels WHERE tenant_id = $1", [tenantId]);
  await admin.query("DELETE FROM users WHERE tenant_id = $1", [tenantId]);
  await admin.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
  await admin.end();

  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM channel_listings WHERE tenant_id = $1", [tenantId]));
  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM locations WHERE tenant_id = $1", [tenantId]));
  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM products WHERE tenant_id = $1", [tenantId]));
  await withTenant(pool, tenantId, (client) =>
    client.query("DELETE FROM channel_connections WHERE tenant_id = $1", [tenantId]),
  );
  await pool.end();
});

test("a real sandbox order goes allocated -> picking -> packed, then a real confirmShipment call hits live SP-API and (per its documented sandbox limitation) fails without shipping the order", async () => {
  const connector = await createAmazonConnectorFromChannelConnection(pool, tenantId);
  const pulled = await connector.pullOrders(SP_API_SANDBOX_TEST_CASE_CREATED_AFTER);
  assert.ok(pulled.length > 0, "sandbox should return at least one canned order");

  const persisted = await orderService.persistPulledOrders(tenantId, pulled);
  assert.equal(persisted.insertedOrderIds.length, pulled.length);

  const allocatedOrders = await withTenant(pool, tenantId, (client) =>
    client.query<{ id: string }>(`SELECT id FROM orders WHERE tenant_id = $1 AND status = 'allocated'`, [tenantId]),
  );
  assert.ok(allocatedOrders.rows.length > 0, "at least one real sandbox order must have allocated");
  const orderId = allocatedOrders.rows[0]!.id;

  const [picklist] = await warehouseService.generatePicklist(tenantId, [orderId]);
  assert.ok(picklist, "generatePicklist must produce a picklist for a real allocated order");

  await warehouseService.assignPicklist(tenantId, picklist!.id, pickerUserId);
  for (const line of picklist!.lines) {
    await warehouseService.recordPick(tenantId, line.id, line.quantityRequested);
  }

  await warehouseService.packOrder(tenantId, orderId);

  const packedRow = await withTenant(pool, tenantId, (client) =>
    client.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [orderId]),
  );
  assert.equal(packedRow.rows[0]?.status, "packed");

  await assert.rejects(
    () =>
      warehouseService.confirmShipment(tenantId, orderId, {
        carrier: "UPS",
        trackingNumber: "1Z999AA10123456784",
        shippedAt: new Date().toISOString(),
      }),
    /Could not match input arguments/,
    "expected the documented sandbox no-matching-scenario response, not a different failure",
  );

  const afterFailedShipRow = await withTenant(pool, tenantId, (client) =>
    client.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [orderId]),
  );
  assert.equal(
    afterFailedShipRow.rows[0]?.status,
    "packed",
    "the order must stay 'packed' -- confirmShipment must not transition it locally when the real channel call fails",
  );
});
