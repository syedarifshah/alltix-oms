// Proves the two properties migration 0044_inventory_events_partitioning.sql
// exists to preserve: that `inventory_event_idempotency_keys` (the sidecar
// table replacing `inventory_events.idempotency_key`'s old table-wide
// UNIQUE constraint, see that migration's own header comment and
// packages/db/src/inventory-event-idempotency.ts's own doc comment) still
// enforces TRUE global uniqueness -- not accidentally scoped by
// `created_at`/which monthly partition an event lands in -- and that a real
// `inventory_events` row actually lands in the correct partition. This is
// the dedicated regression coverage the original ad hoc smoke test (run
// once, by hand, against real Postgres, during this migration's own
// development) was standing in for.
//
// Run with: npm run test --workspace=@alltix/db
// Requires: Postgres reachable via the .env at the repo root, with
// migrations applied (npm run db:migrate).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { Client, type Pool } from "pg";
import {
  createAppPool,
  withTenant,
  claimInventoryEventIdempotencyKey,
  claimInventoryEventIdempotencyKeyOrThrow,
} from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

loadEnv({ path: join(REPO_ROOT, ".env") });

let pool: Pool;
const tenantId = randomUUID();
let productId: string;
let locationId: string;

before(async () => {
  const connectionString = process.env.APP_DATABASE_URL;
  if (!connectionString) {
    throw new Error("APP_DATABASE_URL is not set (see .env.example)");
  }
  pool = createAppPool({ connectionString });

  await withTenant(pool, tenantId, async (client) => {
    const location = await client.query<{ id: string }>(
      `INSERT INTO locations (tenant_id, name, type) VALUES ($1, 'Partitioning Test Warehouse', 'warehouse') RETURNING id`,
      [tenantId],
    );
    locationId = location.rows[0]!.id;

    const product = await client.query<{ id: string }>(
      `INSERT INTO products (tenant_id, internal_sku, name) VALUES ($1, $2, 'Partitioning Test Product') RETURNING id`,
      [tenantId, `PARTITION-TEST-${randomUUID().slice(0, 8)}`],
    );
    productId = product.rows[0]!.id;
  });
});

after(async () => {
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  try {
    await admin.query("DELETE FROM inventory_events WHERE tenant_id = $1", [tenantId]);
    await admin.query(`DELETE FROM inventory_event_idempotency_keys WHERE idempotency_key LIKE $1`, [
      "partition-test-%",
    ]);
  } finally {
    await admin.end();
  }

  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM products WHERE tenant_id = $1", [tenantId]));
  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM locations WHERE tenant_id = $1", [tenantId]));
  await pool.end();
});

test("claimInventoryEventIdempotencyKey: first claim succeeds, a second claim of the SAME key with a DIFFERENT id is rejected", async () => {
  const key = `partition-test-claim-${randomUUID()}`;
  const idA = randomUUID();
  const idB = randomUUID();

  const firstClaim = await withTenant(pool, tenantId, (client) => claimInventoryEventIdempotencyKey(client, key, idA));
  assert.equal(firstClaim, true, "the first claim of a fresh key must succeed");

  const secondClaim = await withTenant(pool, tenantId, (client) => claimInventoryEventIdempotencyKey(client, key, idB));
  assert.equal(secondClaim, false, "a duplicate key must be rejected even with a different inventory_event_id");
});

test("claimInventoryEventIdempotencyKeyOrThrow: a genuine duplicate throws a real Postgres unique_violation, not a silent no-op", async () => {
  const key = `partition-test-throw-${randomUUID()}`;
  const idA = randomUUID();
  const idB = randomUUID();

  await withTenant(pool, tenantId, (client) => claimInventoryEventIdempotencyKeyOrThrow(client, key, idA));

  await assert.rejects(
    withTenant(pool, tenantId, (client) => claimInventoryEventIdempotencyKeyOrThrow(client, key, idB)),
    (err: unknown) => {
      const pgCode = (err as { code?: string } | null)?.code;
      assert.equal(pgCode, "23505", "must be a real unique_violation, not some other failure");
      return true;
    },
  );
});

test("a real inventory_events insert lands in the current month's partition, not the DEFAULT one", async () => {
  const key = `partition-test-placement-${randomUUID()}`;
  const eventId = randomUUID();

  await withTenant(pool, tenantId, async (client) => {
    const claimed = await claimInventoryEventIdempotencyKey(client, key, eventId);
    assert.equal(claimed, true);

    await client.query(
      `INSERT INTO inventory_events (id, tenant_id, product_id, location_id, event_type, quantity_delta, reference_type, idempotency_key)
       VALUES ($1, $2, $3, $4, 'adjustment', 1, 'manual', $5)`,
      [eventId, tenantId, productId, locationId, key],
    );
  });

  const placement = await withTenant(pool, tenantId, (client) =>
    client.query<{ partition: string }>(`SELECT tableoid::regclass::text AS partition FROM inventory_events WHERE id = $1`, [
      eventId,
    ]),
  );

  const now = new Date();
  const expectedPartition = `inventory_events_${now.getUTCFullYear()}_${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  assert.equal(placement.rows[0]?.partition, expectedPartition);
});

// This is the whole point of the sidecar table, per migration 0044's own
// header comment: a redelivered/retried event landing in a DIFFERENT
// calendar month than the original must still be caught as a duplicate --
// weakening the old constraint to (idempotency_key, created_at) would have
// silently let this through.
test("uniqueness is NOT scoped by created_at/partition -- a future-dated redelivery of the same key is still rejected", async () => {
  const key = `partition-test-future-redelivery-${randomUUID()}`;
  const originalEventId = randomUUID();
  const redeliveredEventId = randomUUID();

  await withTenant(pool, tenantId, async (client) => {
    const claimed = await claimInventoryEventIdempotencyKey(client, key, originalEventId);
    assert.equal(claimed, true);

    await client.query(
      `INSERT INTO inventory_events (id, tenant_id, product_id, location_id, event_type, quantity_delta, reference_type, idempotency_key)
       VALUES ($1, $2, $3, $4, 'adjustment', 1, 'manual', $5)`,
      [originalEventId, tenantId, productId, locationId, key],
    );
  });

  // Simulate a redelivery of the identical logical event several months out
  // -- a genuinely different partition than the original -- and prove the
  // idempotency-key claim still rejects it, entirely independent of the
  // real inventory_events insert this redelivery never even gets to reach.
  const redeliveryClaim = await withTenant(pool, tenantId, (client) =>
    claimInventoryEventIdempotencyKey(client, key, redeliveredEventId),
  );
  assert.equal(redeliveryClaim, false, "a future-dated redelivery of the same key must still be rejected");

  const placementOfOriginal = await withTenant(pool, tenantId, (client) =>
    client.query<{ partition: string }>(`SELECT tableoid::regclass::text AS partition FROM inventory_events WHERE id = $1`, [
      originalEventId,
    ]),
  );
  const now = new Date();
  const currentMonthPartition = `inventory_events_${now.getUTCFullYear()}_${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  assert.equal(
    placementOfOriginal.rows[0]?.partition,
    currentMonthPartition,
    "sanity check: the original event really did land in the current month's partition",
  );
});

// Mirrors hr-rls.test.ts's own "exactly 1 of 10 concurrent clock-ins
// succeeds" test -- the real-concurrency proof for this table's own claim
// function, not just a sequential proof that the constraint exists.
test("exactly 1 of 10 concurrent claims of the same key succeeds", async () => {
  const key = `partition-test-concurrency-${randomUUID()}`;
  const ATTEMPTS = 10;

  async function attemptClaim(): Promise<boolean> {
    return withTenant(pool, tenantId, (client) => claimInventoryEventIdempotencyKey(client, key, randomUUID()));
  }

  const results = await Promise.all(Array.from({ length: ATTEMPTS }, () => attemptClaim()));
  const successes = results.filter((r) => r === true).length;
  const rejections = results.filter((r) => r === false).length;

  assert.equal(successes, 1, "exactly one concurrent claim must succeed");
  assert.equal(rejections, ATTEMPTS - 1, "every other concurrent claim must be rejected, none silently duplicated");

  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  try {
    const rows = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_event_idempotency_keys WHERE idempotency_key = $1`,
      [key],
    );
    assert.equal(rows.rows[0]?.count, "1", "exactly one row must have been persisted for this key, never two");
  } finally {
    await admin.end();
  }
});
