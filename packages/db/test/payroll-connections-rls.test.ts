// Direct SQL-level proof for migration 0047's own fix: payroll_connections
// (migration 0038_payroll_connections.sql, CLAUDE.md §14.1) shipped with the
// exact unguarded `current_setting('app.tenant_id', true)::uuid` RLS cast
// that migrations 0018 and 0035 each already fixed once -- a bug class
// CLAUDE.md §18 documents causing two real production incidents. 0038 was
// missed by both prior sweeps (it postdates 0018, and didn't exist yet when
// 0035's own audit ran) and was only caught by a fresh, direct grep of every
// migration file for the bare cast pattern.
//
// This reproduces the real-world trigger deterministically: a single pooled
// connection (max: 1, so every call below is forced onto the SAME physical
// backend) first serves an ordinary withTenant() call -- which is what
// actually sets app.tenant_id on that backend via SET LOCAL, and poisons it
// to '' (not NULL) once that transaction commits -- then a later
// withClerkUser()-style call against payroll_connections, which deliberately
// never re-sets app.tenant_id and so hits the poisoned ''. On the unfixed
// policy this throws `invalid input syntax for type uuid: ""`; on the fixed
// policy it behaves exactly as a normal, correctly-scoped query with an
// unset tenant should.
//
// Run with: npm run test --workspace=@alltix/db
// Requires: Postgres reachable via the .env at the repo root, with
// migrations applied (npm run db:migrate), including 0047.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { config as loadEnv } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAppPool, withTenant, withClerkUser } from "../src/index.js";
import type { Pool } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

loadEnv({ path: join(REPO_ROOT, ".env") });

let pool: Pool;
let singleConnPool: Pool;

const tenantA = { tenantId: randomUUID() };
const tenantB = { tenantId: randomUUID() };

before(async () => {
  const connectionString = process.env.APP_DATABASE_URL;
  if (!connectionString) {
    throw new Error("APP_DATABASE_URL is not set (see .env.example)");
  }
  pool = createAppPool({ connectionString });
  // Forces every query in the poisoned-connection test onto one physical
  // backend, the same reproduction technique migration 0035's own
  // verification note describes using.
  singleConnPool = createAppPool({ connectionString, max: 1 });
  // No tenants row seeding needed -- payroll_connections.tenant_id carries
  // no FK to tenants (confirmed by reading migration 0038 directly), same
  // as employees/time_entries in hr-rls.test.ts, which seeds none either.
});

after(async () => {
  try {
    for (const tenantId of [tenantA.tenantId, tenantB.tenantId]) {
      await withTenant(pool, tenantId, (client) =>
        client.query("DELETE FROM payroll_connections WHERE tenant_id = $1", [tenantId]),
      );
    }
  } finally {
    await singleConnPool.end();
    await pool.end();
  }
});

test("a connection poisoned by a prior withTenant() call no longer crashes a payroll_connections query", async () => {
  // Step 1: an ordinary withTenant() call, on the SAME (max: 1) connection --
  // this is what first sets app.tenant_id on this physical backend via
  // `SET LOCAL`. Once this transaction commits, Postgres reverts the
  // now-touched custom GUC to '' (empty string), not NULL -- the exact
  // mechanism 0018's/0035's own doc comments describe.
  await withTenant(singleConnPool, tenantA.tenantId, (client) => client.query("SELECT 1"));

  // Step 2: a withClerkUser()-style call on the SAME connection -- the real
  // production trigger (resolveTenantId()'s own pre-tenant-resolution
  // lookup) that deliberately never re-sets app.tenant_id. A query against
  // payroll_connections here now hits the poisoned '' left behind by step 1.
  // Before migration 0047 this throws `invalid input syntax for type uuid:
  // ""`; after it, `NULLIF('', '')` becomes a real NULL, and the policy
  // simply matches no rows, exactly as a normal, correctly-scoped query with
  // an unset tenant would.
  await withClerkUser(singleConnPool, "test-clerk-user-id", async (client) => {
    const result = await client.query("SELECT * FROM payroll_connections");
    assert.equal(result.rows.length, 0);
  });
});

test("payroll_connections RLS still isolates real rows cross-tenant after the fix", async () => {
  await withTenant(pool, tenantA.tenantId, (client) =>
    client.query(
      `INSERT INTO payroll_connections (tenant_id, encrypted_api_key) VALUES ($1, pgp_sym_encrypt('test-key', 'test-key'))`,
      [tenantA.tenantId],
    ),
  );

  const ownRows = await withTenant(pool, tenantA.tenantId, (client) =>
    client.query("SELECT tenant_id FROM payroll_connections WHERE tenant_id = $1", [tenantA.tenantId]),
  );
  assert.equal(ownRows.rows.length, 1);

  const crossTenantRows = await withTenant(pool, tenantB.tenantId, (client) =>
    client.query("SELECT tenant_id FROM payroll_connections"),
  );
  assert.equal(crossTenantRows.rows.length, 0);
});
