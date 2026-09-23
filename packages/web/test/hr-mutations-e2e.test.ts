// End-to-end proof, through the real HTTP layer, for the 5 HR mutation
// routes (employees/create, employees/[id]/update, time-entries/clock-in,
// time-entries/[id]/clock-out, time-entries/manual): CLAUDE.md's own "Audit
// Log" §14 notes "No page-level/route-level test suite exists for
// /hr/payroll yet ... same gap /locations already has" -- packages/db/
// test/hr-rls.test.ts already proves tenant isolation at the DB layer, but
// nothing exercises these routes' own request handling: auth, form parsing,
// the guarded "only when a row actually matched" update/clock-out branches,
// or the redirect-with-error shape a plain HTML form relies on (no client
// JS to show an inline error otherwise). Same real HTTP -> Next.js route
// handler chain as tenant-isolation.e2e.test.ts, reused for a different
// module rather than inventing a second pattern.
//
// Run with: npm run test:e2e --workspace=@alltix/web
// Requires: Postgres reachable via the .env at the repo root, with
// migrations applied (npm run db:migrate).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { createAppPool, withTenant, withTenantAndUser } from "@alltix/db";
import type { Pool } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..");
const REPO_ROOT = join(__dirname, "..", "..", "..");

loadEnv({ path: join(REPO_ROOT, ".env") });

// A different port than tenant-isolation.e2e.test.ts's 4173 -- node:test
// can run files concurrently, and two `next dev` instances racing for the
// same port would make one of them fail to start rather than test anything.
const PORT = 4174;
const BASE_URL = `http://localhost:${PORT}`;

let pool: Pool;
let serverProcess: ChildProcessWithoutNullStreams;

const tenant = {
  tenantId: randomUUID(),
  clerkUserId: `test-clerk-user-${randomUUID()}`,
  email: "hr-e2e@tenant.example.com",
};

async function waitForServerReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Server did not become ready within ${timeoutMs}ms: ${String(lastError)}`);
}

/** POSTs a plain HTML form (the shape every one of these routes expects --
 *  none of them read JSON), as the seeded test user, without following the
 *  303 redirect -- the assertion is "did it redirect to the right place
 *  with the right query string", not the destination page's own render. */
function postForm(
  path: string,
  fields: Record<string, string>,
  clerkUserId: string | null = tenant.clerkUserId,
): Promise<{ status: number; location: string | null }> {
  const body = new URLSearchParams(fields);
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (clerkUserId) {
    headers["x-test-clerk-user-id"] = clerkUserId;
  }
  return fetch(`${BASE_URL}${path}`, { method: "POST", headers, body, redirect: "manual" }).then((res) => ({
    status: res.status,
    location: res.headers.get("location"),
  }));
}

before(async () => {
  const connectionString = process.env.APP_DATABASE_URL;
  if (!connectionString) {
    throw new Error("APP_DATABASE_URL is not set (see .env.example)");
  }
  pool = createAppPool({ connectionString });

  await withTenantAndUser(pool, { tenantId: tenant.tenantId, clerkUserId: tenant.clerkUserId }, async (client) => {
    await client.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [tenant.tenantId, `${tenant.email}'s workspace`]);
    await client.query("INSERT INTO users (tenant_id, clerk_user_id, email) VALUES ($1, $2, $3)", [
      tenant.tenantId,
      tenant.clerkUserId,
      tenant.email,
    ]);
  });

  serverProcess = spawn("npx", ["next", "dev", "-p", String(PORT)], {
    cwd: WEB_DIR,
    env: { ...process.env, ALLTIX_TEST_AUTH_BYPASS: "true" },
    stdio: "pipe",
    shell: true,
    // Same process-group-leader trick as tenant-isolation.e2e.test.ts's own
    // spawn -- see that file's comment for why this matters for teardown.
    detached: process.platform !== "win32",
  });
  serverProcess.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(`[next dev :${PORT}] ${chunk.toString()}`);
  });

  await waitForServerReady(120_000);
});

function killServerTree(): void {
  if (!serverProcess?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(serverProcess.pid), "/T", "/F"]);
  } else {
    try {
      process.kill(-serverProcess.pid, "SIGKILL");
    } catch {
      // Already exited -- nothing to clean up.
    }
  }
}

after(async () => {
  killServerTree();
  const { Client } = await import("pg");
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query("DELETE FROM audit_log WHERE tenant_id = $1", [tenant.tenantId]);
  await admin.query("DELETE FROM time_entries WHERE tenant_id = $1", [tenant.tenantId]);
  await admin.query("DELETE FROM employees WHERE tenant_id = $1", [tenant.tenantId]);
  await admin.query("DELETE FROM users WHERE tenant_id = $1", [tenant.tenantId]);
  await admin.query("DELETE FROM tenants WHERE id = $1", [tenant.tenantId]);
  await admin.end();
  await pool.end();
});

test("an unauthenticated request to a protected HR route is rejected, not applied", async () => {
  const result = await postForm(
    "/api/hr/employees/create",
    { name: "Should Not Exist", role: "Picker" },
    null, // no x-test-clerk-user-id header -- falls through to real Clerk auth(), which throws/fails in this dev-bypass server with no real session
  );
  // Not pinned to one exact status, same reasoning tenant-isolation.e2e.test.ts's
  // own "unauthenticated" test gives: what matters is nothing got created.
  assert.notEqual(result.status, 303, "an unauthenticated request must not reach the redirectTo success path");

  const rows = await withTenant(pool, tenant.tenantId, (client) =>
    client.query("SELECT id FROM employees WHERE tenant_id = $1 AND name = $2", [tenant.tenantId, "Should Not Exist"]),
  );
  assert.equal(rows.rowCount, 0, "no employee row should exist from an unauthenticated request");
});

test("employees/create -> employees/[id]/update -> a bogus update is rejected without an audit row", async () => {
  const created = await postForm("/api/hr/employees/create", { name: "Jamie E2E", role: "Picker", hourlyRate: "18.50" });
  assert.equal(created.status, 303);
  assert.ok(created.location?.includes("employee_created=1"), `expected employee_created=1 in Location, got ${created.location}`);

  const employeeRow = await withTenant(pool, tenant.tenantId, (client) =>
    client.query<{ id: string; role: string }>("SELECT id, role FROM employees WHERE tenant_id = $1 AND name = $2", [
      tenant.tenantId,
      "Jamie E2E",
    ]),
  );
  assert.equal(employeeRow.rowCount, 1);
  const employeeId = employeeRow.rows[0]!.id;

  const updated = await postForm(`/api/hr/employees/${employeeId}/update`, {
    role: "Lead Picker",
    hourlyRate: "22",
    status: "active",
  });
  assert.equal(updated.status, 303);
  assert.ok(updated.location?.includes("employee_updated=1"), `expected employee_updated=1 in Location, got ${updated.location}`);

  const afterUpdate = await withTenant(pool, tenant.tenantId, (client) =>
    client.query<{ role: string }>("SELECT role FROM employees WHERE id = $1", [employeeId]),
  );
  assert.equal(afterUpdate.rows[0]?.role, "Lead Picker");

  // A bogus id must redirect with an error, not silently succeed -- and
  // must not leave an audit_log row behind (recordAuditEvent is only called
  // when result.rowCount is truthy, inside the same withTenant callback).
  const bogusId = randomUUID();
  const bogusUpdate = await postForm(`/api/hr/employees/${bogusId}/update`, { role: "Ghost", status: "active" });
  assert.equal(bogusUpdate.status, 303);
  assert.ok(
    bogusUpdate.location?.includes("error=employee_not_found"),
    `expected error=employee_not_found in Location, got ${bogusUpdate.location}`,
  );

  const auditForBogus = await withTenant(pool, tenant.tenantId, (client) =>
    client.query("SELECT id FROM audit_log WHERE tenant_id = $1 AND entity_id = $2", [tenant.tenantId, bogusId]),
  );
  assert.equal(auditForBogus.rowCount, 0, "a not-found update must not record an audit_log row");

  const auditForReal = await withTenant(pool, tenant.tenantId, (client) =>
    client.query("SELECT action FROM audit_log WHERE tenant_id = $1 AND entity_id = $2 ORDER BY created_at", [
      tenant.tenantId,
      employeeId,
    ]),
  );
  assert.deepEqual(
    auditForReal.rows.map((r: { action: string }) => r.action),
    ["employee.created", "employee.updated"],
    "the real employee should have both its audit rows, in order",
  );
});

test("time-entries: clock-in -> a second clock-in is rejected -> clock-out -> a second clock-out is rejected -> manual entry", async () => {
  const employee = await withTenant(pool, tenant.tenantId, (client) =>
    client.query<{ id: string }>(
      "INSERT INTO employees (tenant_id, name, role) VALUES ($1, 'Riley E2E', 'Picker') RETURNING id",
      [tenant.tenantId],
    ),
  );
  const employeeId = employee.rows[0]!.id;

  const clockedIn = await postForm("/api/hr/time-entries/clock-in", { employeeId });
  assert.equal(clockedIn.status, 303);
  assert.ok(clockedIn.location?.includes("clocked_in=1"), `expected clocked_in=1 in Location, got ${clockedIn.location}`);

  const openEntry = await withTenant(pool, tenant.tenantId, (client) =>
    client.query<{ id: string }>(
      "SELECT id FROM time_entries WHERE tenant_id = $1 AND employee_id = $2 AND clock_out IS NULL",
      [tenant.tenantId, employeeId],
    ),
  );
  assert.equal(openEntry.rowCount, 1);
  const timeEntryId = openEntry.rows[0]!.id;

  // A second clock-in for the same employee, while the first is still open,
  // must be rejected -- the already-clocked-in guard covered by
  // time-entries/clock-in/route.ts's own doc comment (SELECT ... FOR UPDATE
  // + the migration 0029 partial-unique-index fallback).
  const secondClockIn = await postForm("/api/hr/time-entries/clock-in", { employeeId });
  assert.equal(secondClockIn.status, 303);
  assert.ok(
    secondClockIn.location?.includes("error=time_entry_already_clocked_in"),
    `expected error=time_entry_already_clocked_in in Location, got ${secondClockIn.location}`,
  );

  const stillOneOpen = await withTenant(pool, tenant.tenantId, (client) =>
    client.query("SELECT count(*)::text AS count FROM time_entries WHERE tenant_id = $1 AND employee_id = $2 AND clock_out IS NULL", [
      tenant.tenantId,
      employeeId,
    ]),
  );
  assert.equal((stillOneOpen.rows[0] as { count: string }).count, "1", "the rejected second clock-in must not create a row");

  const clockedOut = await postForm(`/api/hr/time-entries/${timeEntryId}/clock-out`, {});
  assert.equal(clockedOut.status, 303);
  assert.ok(clockedOut.location?.includes("clocked_out=1"), `expected clocked_out=1 in Location, got ${clockedOut.location}`);

  // A second clock-out on the same, now-closed entry must be rejected, not
  // silently overwrite clock_out with a later timestamp.
  const secondClockOut = await postForm(`/api/hr/time-entries/${timeEntryId}/clock-out`, {});
  assert.equal(secondClockOut.status, 303);
  assert.ok(
    secondClockOut.location?.includes("error=time_entry_not_open"),
    `expected error=time_entry_not_open in Location, got ${secondClockOut.location}`,
  );

  const manualAdded = await postForm("/api/hr/time-entries/manual", {
    employeeId,
    clockIn: "2026-01-15T09:00",
    hours: "8",
    notes: "e2e manual entry",
  });
  assert.equal(manualAdded.status, 303);
  assert.ok(manualAdded.location?.includes("time_entry_added=1"), `expected time_entry_added=1 in Location, got ${manualAdded.location}`);

  const manualRow = await withTenant(pool, tenant.tenantId, (client) =>
    client.query<{ entry_source: string; notes: string | null }>(
      "SELECT entry_source, notes FROM time_entries WHERE tenant_id = $1 AND employee_id = $2 AND entry_source = 'manual'",
      [tenant.tenantId, employeeId],
    ),
  );
  assert.equal(manualRow.rowCount, 1);
  assert.equal(manualRow.rows[0]?.notes, "e2e manual entry");

  // Full audit trail for this employee: clocked_in, clocked_out, manual_entry_added
  // -- the rejected second clock-in/clock-out must have added nothing.
  const audit = await withTenant(pool, tenant.tenantId, (client) =>
    client.query<{ action: string }>("SELECT action FROM audit_log WHERE tenant_id = $1 AND entity_type = 'time_entry' ORDER BY created_at", [
      tenant.tenantId,
    ]),
  );
  assert.deepEqual(
    audit.rows.map((r) => r.action),
    ["time_entry.clocked_in", "time_entry.clocked_out", "time_entry.manual_entry_added"],
  );
});
