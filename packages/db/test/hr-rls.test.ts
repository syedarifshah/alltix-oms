// Direct SQL-level cross-tenant proof for employees/time_entries (migration
// 0028_hr_payroll_employees_and_time_entries.sql, CLAUDE.md §14), mirroring
// channel-connections-rls.test.ts's own rigor and reasoning -- there's no
// HTTP API test suite for these routes yet (same gap /locations has), so
// this is the DB-layer proof that RLS actually isolates them, plus the two
// schema-level invariants the HR module design leans on: an employee
// existing without wage data, and a time_entries CHECK constraint that
// keeps clock_out from ever preceding clock_in.
//
// Run with: npm run test --workspace=@alltix/db
// Requires: Postgres reachable via the .env at the repo root, with
// migrations applied (npm run db:migrate).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { config as loadEnv } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAppPool, withTenant } from "../src/index.js";
import type { Pool } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

loadEnv({ path: join(REPO_ROOT, ".env") });

let pool: Pool;

const tenantA = { tenantId: randomUUID() };
const tenantB = { tenantId: randomUUID() };

async function insertEmployee(tenantId: string, overrides: Partial<{ hourlyRate: number | null }> = {}): Promise<string> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO employees (tenant_id, name, role, hourly_rate) VALUES ($1, $2, 'Picker', $3) RETURNING id`,
      [tenantId, `Employee ${randomUUID().slice(0, 8)}`, overrides.hourlyRate ?? null],
    );
    return result.rows[0]!.id;
  });
}

before(async () => {
  const connectionString = process.env.APP_DATABASE_URL;
  if (!connectionString) {
    throw new Error("APP_DATABASE_URL is not set (see .env.example)");
  }
  pool = createAppPool({ connectionString });
});

after(async () => {
  for (const tenantId of [tenantA.tenantId, tenantB.tenantId]) {
    await withTenant(pool, tenantId, (client) =>
      client.query("DELETE FROM time_entries WHERE tenant_id = $1", [tenantId]),
    );
    await withTenant(pool, tenantId, (client) =>
      client.query("DELETE FROM employees WHERE tenant_id = $1", [tenantId]),
    );
  }
  await pool.end();
});

test("employees: SELECT never returns another tenant's employee", async () => {
  const idB = await insertEmployee(tenantB.tenantId);

  const asA = await withTenant(pool, tenantA.tenantId, (client) => client.query("SELECT id FROM employees"));
  assert.ok(!asA.rows.some((r) => (r as { id: string }).id === idB), "tenant A must never see tenant B's employee");
});

test("employees: UPDATE from the wrong tenant context affects zero rows", async () => {
  const idB = await insertEmployee(tenantB.tenantId);

  const result = await withTenant(pool, tenantA.tenantId, (client) =>
    client.query("UPDATE employees SET status = 'inactive' WHERE id = $1", [idB]),
  );
  assert.equal(result.rowCount, 0);

  const check = await withTenant(pool, tenantB.tenantId, (client) =>
    client.query<{ status: string }>("SELECT status FROM employees WHERE id = $1", [idB]),
  );
  assert.equal(check.rows[0]?.status, "active", "tenant B's row must be unaffected by tenant A's UPDATE");
});

test("employees: INSERT with a mismatched tenant_id is rejected by the WITH CHECK policy", async () => {
  await assert.rejects(
    withTenant(pool, tenantA.tenantId, (client) =>
      client.query(`INSERT INTO employees (tenant_id, name, role) VALUES ($1, 'Forged', 'Picker')`, [
        tenantB.tenantId,
      ]),
    ),
    /row-level security/i,
  );
});

test("employees: hourly_rate is nullable -- an employee can exist for time tracking alone", async () => {
  const id = await insertEmployee(tenantA.tenantId, { hourlyRate: null });

  const stored = await withTenant(pool, tenantA.tenantId, (client) =>
    client.query<{ hourly_rate: string | null }>("SELECT hourly_rate FROM employees WHERE id = $1", [id]),
  );
  assert.equal(stored.rows[0]?.hourly_rate, null);
});

test("time_entries: SELECT never returns another tenant's shift", async () => {
  const employeeB = await insertEmployee(tenantB.tenantId);
  const entryB = await withTenant(pool, tenantB.tenantId, async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO time_entries (tenant_id, employee_id, clock_in) VALUES ($1, $2, now()) RETURNING id`,
      [tenantB.tenantId, employeeB],
    );
    return result.rows[0]!.id;
  });

  const asA = await withTenant(pool, tenantA.tenantId, (client) => client.query("SELECT id FROM time_entries"));
  assert.ok(
    !asA.rows.some((r) => (r as { id: string }).id === entryB),
    "tenant A must never see tenant B's time entry",
  );
});

test("time_entries: INSERT with a mismatched tenant_id is rejected by the WITH CHECK policy", async () => {
  const employeeA = await insertEmployee(tenantA.tenantId);
  await assert.rejects(
    withTenant(pool, tenantA.tenantId, (client) =>
      client.query(`INSERT INTO time_entries (tenant_id, employee_id, clock_in) VALUES ($1, $2, now())`, [
        tenantB.tenantId,
        employeeA,
      ]),
    ),
    /row-level security/i,
  );
});

test("time_entries: clock_out IS NULL means still clocked in, not a zero-length shift", async () => {
  const employeeA = await insertEmployee(tenantA.tenantId);
  const id = await withTenant(pool, tenantA.tenantId, async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO time_entries (tenant_id, employee_id, clock_in) VALUES ($1, $2, now()) RETURNING id`,
      [tenantA.tenantId, employeeA],
    );
    return result.rows[0]!.id;
  });

  const stored = await withTenant(pool, tenantA.tenantId, (client) =>
    client.query<{ clock_out: string | null }>("SELECT clock_out FROM time_entries WHERE id = $1", [id]),
  );
  assert.equal(stored.rows[0]?.clock_out, null);
});

test("time_entries: CHECK constraint rejects clock_out at or before clock_in", async () => {
  const employeeA = await insertEmployee(tenantA.tenantId);
  await assert.rejects(
    withTenant(pool, tenantA.tenantId, (client) =>
      client.query(
        `INSERT INTO time_entries (tenant_id, employee_id, clock_in, clock_out)
         VALUES ($1, $2, now(), now() - interval '1 hour')`,
        [tenantA.tenantId, employeeA],
      ),
    ),
    /violates check constraint/i,
  );
});
