// Proves the concurrency case this workflow needs: two (or more) pickers
// claiming the same open picklist at once must leave exactly one of them
// assigned -- never both, never neither, and never an inconsistent
// intermediate state. Same shape as order-service's
// allocation-concurrency.test.ts, applied to assignPicklist() instead of
// allocateOrder(). Requires a live Postgres (npm run db:migrate).
//
// Run with: npm run test --workspace=@alltix/warehouse-service -- assign-picklist-concurrency

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { Client, type Pool } from "pg";
import { createAppPool, withTenant, withTenantAndUser } from "@alltix/db";
import { OrderService } from "@alltix/order-service";
import { WarehouseService } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

loadEnv({ path: join(REPO_ROOT, ".env") });

const PICKER_COUNT = 10;

let pool: Pool;
const tenantId = randomUUID();
let warehouseService: WarehouseService;
let picklistId: string;
let pickerUserIds: string[];

before(async () => {
  const connectionString = process.env.APP_DATABASE_URL;
  if (!connectionString) {
    throw new Error("APP_DATABASE_URL is not set (see .env.example)");
  }
  // Headroom above pg's default max=10, same reasoning as
  // allocation-concurrency.test.ts: every picker's assignment attempt needs
  // its own connection to genuinely race.
  pool = createAppPool({ connectionString, max: PICKER_COUNT + 5 });
  const orderService = new OrderService(pool);
  warehouseService = new WarehouseService(pool, orderService);

  picklistId = await withTenant(pool, tenantId, async (client) => {
    const location = await client.query<{ id: string }>(
      `INSERT INTO locations (tenant_id, name, type) VALUES ($1, 'Assign Concurrency Test Warehouse', 'warehouse') RETURNING id`,
      [tenantId],
    );
    const picklist = await client.query<{ id: string }>(
      `INSERT INTO picklists (tenant_id, location_id, status) VALUES ($1, $2, 'open') RETURNING id`,
      [tenantId, location.rows[0]!.id],
    );
    return picklist.rows[0]!.id;
  });

  // picklists.assigned_to is a real FK to users.id (migration 0013) -- seed
  // a genuine tenant + one user per contending picker, same pattern as
  // packages/web/test/tenant-isolation.e2e.test.ts, rather than pointing
  // the FK at an arbitrary string.
  pickerUserIds = [];
  for (let i = 0; i < PICKER_COUNT; i++) {
    const clerkUserId = `picker-${i}-${randomUUID()}`;
    const userId = await withTenantAndUser(pool, { tenantId, clerkUserId }, async (client) => {
      await client.query(
        `INSERT INTO tenants (id, name) VALUES ($1, 'Assign Concurrency Test Tenant') ON CONFLICT (id) DO NOTHING`,
        [tenantId],
      );
      const user = await client.query<{ id: string }>(
        `INSERT INTO users (tenant_id, clerk_user_id, email) VALUES ($1, $2, $3) RETURNING id`,
        [tenantId, clerkUserId, `${clerkUserId}@example.com`],
      );
      return user.rows[0]!.id;
    });
    pickerUserIds.push(userId);
  }
});

after(async () => {
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query("DELETE FROM picklists WHERE tenant_id = $1", [tenantId]);
  await admin.query("DELETE FROM users WHERE tenant_id = $1", [tenantId]);
  await admin.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
  await admin.end();

  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM locations WHERE tenant_id = $1", [tenantId]));
  await pool.end();
});

test(`exactly 1 of ${PICKER_COUNT} concurrent assignment attempts against one open picklist succeeds`, async () => {
  const results = await Promise.allSettled(
    pickerUserIds.map((pickerId) => warehouseService.assignPicklist(tenantId, picklistId, pickerId)),
  );

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one assignment attempt must succeed");
  assert.equal(rejected.length, PICKER_COUNT - 1, "every other attempt must fail");

  const picklistRow = await withTenant(pool, tenantId, (client) =>
    client.query<{ status: string; assigned_to: string }>(
      "SELECT status, assigned_to FROM picklists WHERE id = $1",
      [picklistId],
    ),
  );
  assert.equal(picklistRow.rows[0]?.status, "assigned");
  assert.ok(
    pickerUserIds.includes(picklistRow.rows[0]!.assigned_to),
    "assigned_to must be one of the real contending pickers",
  );
});
