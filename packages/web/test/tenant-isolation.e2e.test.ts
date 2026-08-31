// End-to-end proof that tenant isolation holds through the real HTTP layer:
// two concurrently-running "signed in" users from two different tenants hit
// the same running Next.js server and never see each other's data. This
// exercises the actual chain the production request path uses -- HTTP ->
// Next.js route handler -> withTenantAuth -> withClerkUser (tenant lookup) ->
// withTenant (SET LOCAL app.tenant_id inside a transaction) -> the products
// RLS policy -- not just a direct SQL-level check.
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

const PORT = 4173;
const BASE_URL = `http://localhost:${PORT}`;

let pool: Pool;
let serverProcess: ChildProcessWithoutNullStreams;

const tenantA = {
  tenantId: randomUUID(),
  clerkUserId: `test-clerk-user-${randomUUID()}`,
  email: "a@tenant-a.example.com",
  productSku: `SKU-A-${randomUUID().slice(0, 8)}`,
  productName: "Tenant A Widget",
};
const tenantB = {
  tenantId: randomUUID(),
  clerkUserId: `test-clerk-user-${randomUUID()}`,
  email: "b@tenant-b.example.com",
  productSku: `SKU-B-${randomUUID().slice(0, 8)}`,
  productName: "Tenant B Widget",
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

function fetchProductsAs(clerkUserId: string): Promise<{ status: number; products: { internal_sku: string; name: string; tenant_id: string }[] }> {
  return fetch(`${BASE_URL}/api/products`, {
    headers: { "x-test-clerk-user-id": clerkUserId },
  }).then(async (res) => ({
    status: res.status,
    products: res.ok ? ((await res.json()) as { products: { internal_sku: string; name: string; tenant_id: string }[] }).products : [],
  }));
}

function createProductAs(
  clerkUserId: string,
  body: { internalSku: string; name: string },
): Promise<{ status: number }> {
  return fetch(`${BASE_URL}/api/products`, {
    method: "POST",
    headers: { "x-test-clerk-user-id": clerkUserId, "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((res) => ({ status: res.status }));
}

before(async () => {
  const connectionString = process.env.APP_DATABASE_URL;
  if (!connectionString) {
    throw new Error("APP_DATABASE_URL is not set (see .env.example)");
  }
  pool = createAppPool({ connectionString });

  // Seed two tenants + their owning users, exactly as provision-tenant.ts
  // does for a real Clerk signup.
  for (const t of [tenantA, tenantB]) {
    await withTenantAndUser(pool, { tenantId: t.tenantId, clerkUserId: t.clerkUserId }, async (client) => {
      await client.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [t.tenantId, `${t.email}'s workspace`]);
      await client.query("INSERT INTO users (tenant_id, clerk_user_id, email) VALUES ($1, $2, $3)", [
        t.tenantId,
        t.clerkUserId,
        t.email,
      ]);
    });
    await withTenant(pool, t.tenantId, (client) =>
      client.query("INSERT INTO products (tenant_id, internal_sku, name) VALUES ($1, $2, $3)", [
        t.tenantId,
        t.productSku,
        t.productName,
      ]),
    );
  }

  serverProcess = spawn("npx", ["next", "dev", "-p", String(PORT)], {
    cwd: WEB_DIR,
    env: {
      ...process.env,
      ALLTIX_TEST_AUTH_BYPASS: "true",
    },
    stdio: "pipe",
    shell: true,
  });
  serverProcess.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(`[next dev] ${chunk.toString()}`);
  });

  await waitForServerReady(120_000);
});

function killServerTree(): void {
  if (!serverProcess?.pid) return;
  // spawn() used shell:true (npx.cmd needs it on Windows), so serverProcess
  // is the shell, not the actual next-server process it launched --
  // child.kill() would leave next-server running and holding PORT open.
  // taskkill /T kills the whole process tree instead.
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(serverProcess.pid), "/T", "/F"]);
  } else {
    serverProcess.kill();
  }
}

after(async () => {
  killServerTree();
  await withTenant(pool, tenantA.tenantId, (client) =>
    client.query("DELETE FROM products WHERE tenant_id = $1", [tenantA.tenantId]),
  );
  await withTenant(pool, tenantB.tenantId, (client) =>
    client.query("DELETE FROM products WHERE tenant_id = $1", [tenantB.tenantId]),
  );
  // users/tenants have no DELETE grant for app_user by design (see
  // migrations/0010) -- clean those up via the schema-owning connection.
  const { Client } = await import("pg");
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query("DELETE FROM users WHERE tenant_id IN ($1, $2)", [tenantA.tenantId, tenantB.tenantId]);
  await admin.query("DELETE FROM tenants WHERE id IN ($1, $2)", [tenantA.tenantId, tenantB.tenantId]);
  await admin.end();
  await pool.end();
});

test("a single authenticated request only sees its own tenant's products", async () => {
  const resultA = await fetchProductsAs(tenantA.clerkUserId);
  assert.equal(resultA.status, 200);
  assert.equal(resultA.products.length, 1);
  assert.equal(resultA.products[0]?.internal_sku, tenantA.productSku);

  const resultB = await fetchProductsAs(tenantB.clerkUserId);
  assert.equal(resultB.status, 200);
  assert.equal(resultB.products.length, 1);
  assert.equal(resultB.products[0]?.internal_sku, tenantB.productSku);
});

test("an unauthenticated request never sees product data", async () => {
  // Not pinned to exactly 401: this app's fake Clerk publishable key (no
  // live Clerk credentials in this environment -- see .env.example) makes a
  // real dev-instance Clerk deployment respond to an unauthenticated request
  // with its own dev-browser handshake redirect rather than a flat 401 --
  // that's Clerk's behavior for an uninitialized dev instance, not a
  // property of this app's tenant isolation. What actually matters here,
  // and is asserted, is that no product data is ever returned without
  // authentication, regardless of which non-success status Clerk chooses.
  const res = await fetch(`${BASE_URL}/api/products`, { redirect: "manual" });
  assert.notEqual(res.status, 200);
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await res.json()) as { products?: unknown[] };
    assert.ok(!body.products, "an unauthenticated response must never include a products array");
  }
});

test("many concurrent, interleaved requests from two tenants never cross-contaminate", async () => {
  // Fire well more requests than the pool's default max connections (10) so
  // the same underlying TCP connection is very likely reused across both
  // tenant A and tenant B requests within this burst. If tenant context were
  // set with plain SET instead of SET LOCAL, a reused connection could still
  // be carrying the previous request's tenant_id when the next one queries.
  const ROUNDS = 30;
  const requests: Promise<{ tenant: "A" | "B"; status: number; products: { internal_sku: string }[] }>[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    requests.push(fetchProductsAs(tenantA.clerkUserId).then((r) => ({ tenant: "A" as const, ...r })));
    requests.push(fetchProductsAs(tenantB.clerkUserId).then((r) => ({ tenant: "B" as const, ...r })));
  }

  const results = await Promise.all(requests);
  assert.equal(results.length, ROUNDS * 2);

  for (const result of results) {
    assert.equal(result.status, 200);
    assert.equal(result.products.length, 1, `expected exactly 1 product, got ${result.products.length}`);
    const expectedSku = result.tenant === "A" ? tenantA.productSku : tenantB.productSku;
    const forbiddenSku = result.tenant === "A" ? tenantB.productSku : tenantA.productSku;
    assert.equal(result.products[0]?.internal_sku, expectedSku);
    assert.notEqual(result.products[0]?.internal_sku, forbiddenSku);
  }
});

test("concurrent writes from two tenants are isolated end-to-end", async () => {
  const newSkuA = `SKU-A-CONCURRENT-${randomUUID().slice(0, 8)}`;
  const newSkuB = `SKU-B-CONCURRENT-${randomUUID().slice(0, 8)}`;

  const [createA, createB] = await Promise.all([
    createProductAs(tenantA.clerkUserId, { internalSku: newSkuA, name: "Concurrent A" }),
    createProductAs(tenantB.clerkUserId, { internalSku: newSkuB, name: "Concurrent B" }),
  ]);
  assert.equal(createA.status, 201);
  assert.equal(createB.status, 201);

  const [afterA, afterB] = await Promise.all([
    fetchProductsAs(tenantA.clerkUserId),
    fetchProductsAs(tenantB.clerkUserId),
  ]);

  const skusA = afterA.products.map((p) => p.internal_sku);
  const skusB = afterB.products.map((p) => p.internal_sku);
  assert.ok(skusA.includes(newSkuA), "tenant A should see its own new product");
  assert.ok(!skusA.includes(newSkuB), "tenant A must never see tenant B's new product");
  assert.ok(skusB.includes(newSkuB), "tenant B should see its own new product");
  assert.ok(!skusB.includes(newSkuA), "tenant B must never see tenant A's new product");
});
