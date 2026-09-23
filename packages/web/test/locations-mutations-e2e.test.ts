// End-to-end proof, through the real HTTP layer, for the 3 /locations
// mutation routes (create, [id]/rename, [id]/set-postal-code). Same real
// gap hr-mutations-e2e.test.ts closed for the HR module: no page-level/
// route-level test suite existed for these routes at all -- packages/db/
// test/hr-rls.test.ts's own header comment explicitly names /locations as
// carrying this same gap. Reuses tenant-isolation.e2e.test.ts's exact real
// HTTP -> Next.js route handler pattern rather than inventing a second one.
//
// Run with: npm run test:locations-mutations-e2e --workspace=@alltix/web
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

// Distinct from tenant-isolation.e2e.test.ts's 4173 and
// hr-mutations-e2e.test.ts's 4174 -- node:test runs files concurrently by
// default, and two `next dev` instances racing for the same port would
// make one of them fail to start rather than test anything.
const PORT = 4175;
const BASE_URL = `http://localhost:${PORT}`;

let pool: Pool;
let serverProcess: ChildProcessWithoutNullStreams;

const tenant = {
  tenantId: randomUUID(),
  clerkUserId: `test-clerk-user-${randomUUID()}`,
  email: "locations-e2e@tenant.example.com",
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
 *  with the right query string", same pattern hr-mutations-e2e.test.ts's
 *  own postForm() already established. */
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
  await withTenant(pool, tenant.tenantId, (client) => client.query("DELETE FROM locations WHERE tenant_id = $1", [tenant.tenantId]));
  const { Client } = await import("pg");
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query("DELETE FROM users WHERE tenant_id = $1", [tenant.tenantId]);
  await admin.query("DELETE FROM tenants WHERE id = $1", [tenant.tenantId]);
  await admin.end();
  await pool.end();
});

test("an unauthenticated request to /api/locations/create is rejected, not applied", async () => {
  const result = await postForm("/api/locations/create", { name: "Should Not Exist", type: "warehouse" }, null);
  assert.notEqual(result.status, 303, "an unauthenticated request must not reach the redirectTo success path");

  const rows = await withTenant(pool, tenant.tenantId, (client) =>
    client.query("SELECT id FROM locations WHERE tenant_id = $1 AND name = $2", [tenant.tenantId, "Should Not Exist"]),
  );
  assert.equal(rows.rowCount, 0, "no location row should exist from an unauthenticated request");
});

test("create rejects missing fields and an invalid type before ever reaching the database", async () => {
  const missingFields = await postForm("/api/locations/create", { name: "", type: "" });
  assert.equal(missingFields.status, 303);
  assert.ok(
    missingFields.location?.includes("error=location_missing_fields"),
    `expected error=location_missing_fields in Location, got ${missingFields.location}`,
  );

  const invalidType = await postForm("/api/locations/create", { name: "Bad Type Location", type: "spaceship" });
  assert.equal(invalidType.status, 303);
  assert.ok(
    invalidType.location?.includes("error=location_invalid_type"),
    `expected error=location_invalid_type in Location, got ${invalidType.location}`,
  );

  const rows = await withTenant(pool, tenant.tenantId, (client) =>
    client.query("SELECT id FROM locations WHERE tenant_id = $1", [tenant.tenantId]),
  );
  assert.equal(rows.rowCount, 0, "neither rejected submission should have created a row");
});

test("create -> rename -> set-postal-code, end to end, including the not-found and clear-to-null branches", async () => {
  const created = await postForm("/api/locations/create", { name: "Main Warehouse E2E", type: "warehouse", postalCode: "10001" });
  assert.equal(created.status, 303);
  assert.ok(created.location?.includes("location_created=1"), `expected location_created=1 in Location, got ${created.location}`);

  const locationRow = await withTenant(pool, tenant.tenantId, (client) =>
    client.query<{ id: string; name: string; type: string; postal_code: string | null }>(
      "SELECT id, name, type, postal_code FROM locations WHERE tenant_id = $1 AND name = $2",
      [tenant.tenantId, "Main Warehouse E2E"],
    ),
  );
  assert.equal(locationRow.rowCount, 1);
  assert.equal(locationRow.rows[0]?.type, "warehouse");
  assert.equal(locationRow.rows[0]?.postal_code, "10001");
  const locationId = locationRow.rows[0]!.id;

  const renamed = await postForm(`/api/locations/${locationId}/rename`, { name: "Main Warehouse (Renamed)" });
  assert.equal(renamed.status, 303);
  assert.ok(renamed.location?.includes("location_renamed=1"), `expected location_renamed=1 in Location, got ${renamed.location}`);

  const afterRename = await withTenant(pool, tenant.tenantId, (client) =>
    client.query<{ name: string; type: string }>("SELECT name, type FROM locations WHERE id = $1", [locationId]),
  );
  assert.equal(afterRename.rows[0]?.name, "Main Warehouse (Renamed)");
  assert.equal(afterRename.rows[0]?.type, "warehouse", "rename must never touch type -- see that route's own doc comment");

  // A bogus id must redirect with an error, not silently succeed.
  const bogusId = randomUUID();
  const bogusRename = await postForm(`/api/locations/${bogusId}/rename`, { name: "Ghost Warehouse" });
  assert.equal(bogusRename.status, 303);
  assert.ok(
    bogusRename.location?.includes("error=location_not_found"),
    `expected error=location_not_found in Location, got ${bogusRename.location}`,
  );

  const setPostalCode = await postForm(`/api/locations/${locationId}/set-postal-code`, { postalCode: "94105" });
  assert.equal(setPostalCode.status, 303);
  assert.ok(
    setPostalCode.location?.includes("location_postal_code_set=1"),
    `expected location_postal_code_set=1 in Location, got ${setPostalCode.location}`,
  );
  const afterSetPostalCode = await withTenant(pool, tenant.tenantId, (client) =>
    client.query<{ postal_code: string | null }>("SELECT postal_code FROM locations WHERE id = $1", [locationId]),
  );
  assert.equal(afterSetPostalCode.rows[0]?.postal_code, "94105");

  // An empty submission clears it back to NULL rather than being rejected --
  // that route's own doc comment on why a blank value is meaningful, not invalid.
  const clearedPostalCode = await postForm(`/api/locations/${locationId}/set-postal-code`, { postalCode: "" });
  assert.equal(clearedPostalCode.status, 303);
  assert.ok(clearedPostalCode.location?.includes("location_postal_code_set=1"));
  const afterClear = await withTenant(pool, tenant.tenantId, (client) =>
    client.query<{ postal_code: string | null }>("SELECT postal_code FROM locations WHERE id = $1", [locationId]),
  );
  assert.equal(afterClear.rows[0]?.postal_code, null, "an empty postalCode submission must clear it to NULL, not reject or no-op");

  const bogusSetPostalCode = await postForm(`/api/locations/${bogusId}/set-postal-code`, { postalCode: "00000" });
  assert.equal(bogusSetPostalCode.status, 303);
  assert.ok(
    bogusSetPostalCode.location?.includes("error=location_not_found"),
    `expected error=location_not_found in Location, got ${bogusSetPostalCode.location}`,
  );
});
