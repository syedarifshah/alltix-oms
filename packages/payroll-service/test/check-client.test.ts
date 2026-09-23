// Coverage for packages/payroll-service/src/index.ts (CLAUDE.md §14.1,
// task #34's "wired but unverified" pass).
//
// What this file deliberately does NOT do: make a real network call to
// sandbox.checkhq.com -- same reasoning packages/shared/test/email.test.ts's
// own header comment gives for Resend, and WalmartConnector's own tests
// give for Walmart: no Check credentials of any kind exist anywhere in this
// codebase (CLAUDE.md §14.1), so every CheckClient-touching test here stubs
// global.fetch (restored in a `finally`), never constructs a client against
// a real key, and never asserts anything about how sandbox.checkhq.com
// actually behaves -- only that this codebase's own request-building,
// response-parsing, and DB-service logic does what it says.
//
// Run with: npm run test --workspace=@alltix/payroll-service

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import type { Pool } from "pg";
import { createAppPool, withTenant } from "@alltix/db";
import {
  CheckClient,
  CheckApiError,
  connectPayrollProcessor,
  linkEmployeeToCheck,
  getPayrollConnection,
} from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
loadEnv({ path: join(REPO_ROOT, ".env") });

function stubFetch(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => handler(String(url), init)) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("CheckClient sends the confirmed Authorization/Content-Type headers and hits the sandbox host by default", async () => {
  let seenUrl = "";
  let seenHeaders: Record<string, string> = {};
  const restore = stubFetch((url, init) => {
    seenUrl = url;
    seenHeaders = (init?.headers as Record<string, string>) ?? {};
    return new Response(JSON.stringify({ id: "co_123" }), { status: 201 });
  });

  try {
    const client = new CheckClient("sk_sandbox_test_key");
    const company = await client.createCompany({ legalName: "Alltix Test Co", businessType: "llc" });
    assert.equal(company.id, "co_123");
    assert.equal(seenUrl, "https://sandbox.checkhq.com/companies");
    assert.equal(seenHeaders.Authorization, "Bearer sk_sandbox_test_key");
    assert.equal(seenHeaders["Content-Type"], "application/json");
  } finally {
    restore();
  }
});

test("CheckClient.createCompany sends snake_case fields matching the confirmed create-company request shape", async () => {
  let sentBody: unknown = null;
  const restore = stubFetch((_url, init) => {
    sentBody = JSON.parse(String(init?.body ?? "{}"));
    return new Response(JSON.stringify({ id: "co_456" }), { status: 201 });
  });

  try {
    const client = new CheckClient("sk_sandbox_test_key");
    await client.createCompany({
      legalName: "Alltix Test Co",
      businessType: "llc",
      tradeName: "Alltix",
      payFrequency: "biweekly",
    });
    // JSON.stringify drops undefined-valued keys, so only the fields this
    // call actually set survive the wire round trip -- industry_type/
    // email/phone/start_date were left unset above and must not appear at
    // all, not appear as explicit nulls.
    assert.deepEqual(sentBody, {
      legal_name: "Alltix Test Co",
      business_type: "llc",
      trade_name: "Alltix",
      pay_frequency: "biweekly",
    });
  } finally {
    restore();
  }
});

test("CheckClient throws CheckApiError with the real HTTP status on a non-2xx response, never swallows it", async () => {
  const restore = stubFetch(() => new Response("invalid api key", { status: 401 }));

  try {
    const client = new CheckClient("sk_bad_key");
    await assert.rejects(
      () => client.verifyApiKey(),
      (err: unknown) => {
        assert.ok(err instanceof CheckApiError);
        assert.equal(err.status, 401);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("CheckClient.createComponentLink scopes company_onboard/run_payroll under /companies and employee_onboard under /employees", async () => {
  const seenUrls: string[] = [];
  const restore = stubFetch((url) => {
    seenUrls.push(url);
    return new Response(JSON.stringify({ link: "https://link.checkhq.com/abc" }), { status: 200 });
  });

  try {
    const client = new CheckClient("sk_sandbox_test_key");
    await client.createComponentLink("company_onboard", "co_123", { signerName: "A", signerTitle: "CEO", signerEmail: "a@example.test" });
    await client.createComponentLink("run_payroll", "co_123");
    await client.createComponentLink("employee_onboard", "emp_789");

    assert.equal(seenUrls[0], "https://sandbox.checkhq.com/companies/co_123/components/company_onboard");
    assert.equal(seenUrls[1], "https://sandbox.checkhq.com/companies/co_123/components/run_payroll");
    assert.equal(seenUrls[2], "https://sandbox.checkhq.com/employees/emp_789/components/employee_onboard");
  } finally {
    restore();
  }
});

test("CheckClient.createComponentLink appends ?payroll= only for run_payroll with a payrollId, and parses component_link/url as fallbacks for link", async () => {
  const seenUrls: string[] = [];
  let call = 0;
  const restore = stubFetch((url) => {
    seenUrls.push(url);
    call++;
    // Exercises every fallback field name parseComponentLinkResponse checks
    // -- this codebase never fetched a confirmed example response, so all
    // three must work.
    const bodies = [{ link: "https://link.checkhq.com/1" }, { component_link: "https://link.checkhq.com/2" }, { url: "https://link.checkhq.com/3" }];
    return new Response(JSON.stringify(bodies[call - 1]), { status: 200 });
  });

  try {
    const client = new CheckClient("sk_sandbox_test_key");
    const first = await client.createComponentLink("run_payroll", "co_1", { payrollId: "pay_1" });
    const second = await client.createComponentLink("run_payroll", "co_1");
    const third = await client.createComponentLink("company_onboard", "co_1");

    assert.equal(seenUrls[0], "https://sandbox.checkhq.com/companies/co_1/components/run_payroll?payroll=pay_1");
    assert.equal(seenUrls[1], "https://sandbox.checkhq.com/companies/co_1/components/run_payroll");
    assert.equal(first.link, "https://link.checkhq.com/1");
    assert.equal(second.link, "https://link.checkhq.com/2");
    assert.equal(third.link, "https://link.checkhq.com/3");
  } finally {
    restore();
  }
});

test("CheckClient.createComponentLink throws a clear error when the response has no recognizable link field", async () => {
  const restore = stubFetch(() => new Response(JSON.stringify({ something_else: "nope" }), { status: 200 }));

  try {
    const client = new CheckClient("sk_sandbox_test_key");
    await assert.rejects(() => client.createComponentLink("run_payroll", "co_1"), /did not contain a recognizable link field/);
  } finally {
    restore();
  }
});

// -----------------------------------------------------------------------
// DB-touching tests -- real Postgres (npm run db:migrate), same
// seed/cleanup shape as tiktok-multi-shop.test.ts. Every real network call
// (verifyApiKey, createEmployee) is stubbed via global.fetch, never live.

let pool: Pool;
let adminPool: Pool;
const tenantId = randomUUID();
let employeeId: string;

before(async () => {
  const appConnectionString = process.env.APP_DATABASE_URL;
  const adminConnectionString = process.env.DATABASE_URL;
  if (!appConnectionString) throw new Error("APP_DATABASE_URL is not set (see .env.example)");
  if (!adminConnectionString) throw new Error("DATABASE_URL is not set (see .env.example)");
  pool = createAppPool({ connectionString: appConnectionString });
  adminPool = createAppPool({ connectionString: adminConnectionString });

  await adminPool.query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, [tenantId, `payroll-service-test-${tenantId.slice(0, 8)}`]);

  employeeId = await withTenant(pool, tenantId, async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO employees (tenant_id, name, role) VALUES ($1, 'Jamie Rivera', 'Picker') RETURNING id`,
      [tenantId],
    );
    return result.rows[0]!.id;
  });
});

after(async () => {
  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM employees WHERE tenant_id = $1", [tenantId]));
  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM payroll_connections WHERE tenant_id = $1", [tenantId]));
  await adminPool.query("DELETE FROM audit_log WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
  await pool.end();
  await adminPool.end();
});

test("connectPayrollProcessor verifies the key against Check before persisting anything, then upserts one row per tenant", async () => {
  let verifyCalls = 0;
  const restore = stubFetch((url) => {
    verifyCalls++;
    assert.equal(url, "https://sandbox.checkhq.com/companies?page_size=1");
    return new Response(JSON.stringify([]), { status: 200 });
  });

  try {
    const first = await connectPayrollProcessor(pool, tenantId, "sk_sandbox_first", null);
    assert.equal(verifyCalls, 1);
    assert.equal(first.status, "active");
    assert.equal(first.checkCompanyId, null);

    // Reconnecting with a new key upserts the SAME row (tenant_id is
    // UNIQUE, migration 0038) rather than inserting a second one.
    const second = await connectPayrollProcessor(pool, tenantId, "sk_sandbox_rotated", null);
    assert.equal(second.id, first.id);
    assert.equal(verifyCalls, 2);

    const stored = await getPayrollConnection(pool, tenantId);
    assert.equal(stored?.id, first.id);
  } finally {
    restore();
  }
});

test("connectPayrollProcessor never persists anything when Check rejects the key", async () => {
  const otherTenantId = randomUUID();
  await adminPool.query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, [otherTenantId, `payroll-reject-test-${otherTenantId.slice(0, 8)}`]);

  const restore = stubFetch(() => new Response("invalid key", { status: 401 }));
  try {
    await assert.rejects(() => connectPayrollProcessor(pool, otherTenantId, "sk_bad", null));
    const stored = await getPayrollConnection(pool, otherTenantId);
    assert.equal(stored, null, "a rejected key must never reach payroll_connections");
  } finally {
    restore();
    await adminPool.query("DELETE FROM tenants WHERE id = $1", [otherTenantId]);
  }
});

test("linkEmployeeToCheck is expand-only: a second call for an already-linked employee is refused, not silently overwritten", async () => {
  const restoreConnect = stubFetch(() => new Response(JSON.stringify([]), { status: 200 }));
  try {
    await connectPayrollProcessor(pool, tenantId, "sk_sandbox_for_linking", null);
  } finally {
    restoreConnect();
  }

  // createCheckCompanyForTenant isn't exercised directly here (it's a thin
  // wrapper already covered by the createCompany request-shape test above)
  // -- set check_company_id directly so linkEmployeeToCheck has a company
  // to attach the employee to.
  await withTenant(pool, tenantId, (client) =>
    client.query(`UPDATE payroll_connections SET check_company_id = 'co_test_123' WHERE tenant_id = $1`, [tenantId]),
  );

  let createEmployeeCalls = 0;
  const restore = stubFetch((url) => {
    createEmployeeCalls++;
    assert.equal(url, "https://sandbox.checkhq.com/employees");
    return new Response(JSON.stringify({ id: "emp_123" }), { status: 201 });
  });

  try {
    const checkEmployeeId = await linkEmployeeToCheck(pool, tenantId, employeeId, ["wp_123"], null);
    assert.equal(checkEmployeeId, "emp_123");
    assert.equal(createEmployeeCalls, 1);

    await assert.rejects(
      () => linkEmployeeToCheck(pool, tenantId, employeeId, ["wp_123"], null),
      /already linked to Check employee emp_123/,
    );
    // The refused second call must not have made a second createEmployee
    // request either -- the guard fires before any network call.
    assert.equal(createEmployeeCalls, 1);

    const employee = await withTenant(pool, tenantId, (client) =>
      client.query<{ check_employee_id: string | null }>(`SELECT check_employee_id FROM employees WHERE id = $1`, [employeeId]),
    );
    assert.equal(employee.rows[0]?.check_employee_id, "emp_123");
  } finally {
    restore();
  }
});
