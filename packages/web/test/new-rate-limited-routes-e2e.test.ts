// End-to-end proof, through the real HTTP layer, that the rate-limit gap
// this pass closed is actually wired correctly in each route file -- not
// just that the underlying recordRequestAndCheckRateLimit/checkRateLimit
// primitive works (rate-limit.test.ts already covers that generically).
// CLAUDE.md §16 claimed "every mutation route now protected" before this
// pass; a systematic audit (grepping every POST route.ts for checkRateLimit)
// found 11 real, signed-in-tenant mutation routes that were never actually
// calling it: billing/checkout, billing/portal, inventory/reorder-threshold,
// and 8 marketplace-connector routes (amazon/listings, ebay/business-
// policies, ebay/listings, ebay/location, shopify/listings, tiktok/
// select-shop, walmart/listings, walmart/listings/[id]/check-status).
//
// inventory/reorder-threshold and locations/HR's own rate-limited routes
// already have real end-to-end coverage elsewhere (locations-mutations-
// e2e.test.ts, hr-mutations-e2e.test.ts) -- this file covers the 10 that
// don't, by PRE-SEEDING api_rate_limit_windows to exactly the default limit
// for (tenant, route) and firing one real request, rather than actually
// firing 120+ requests against routes that would otherwise hit Stripe or a
// real marketplace API. This proves the ACTUAL risk this pass fixed --
// "does this route call checkRateLimit with the right tenantId, in the
// right place, before any real work" -- without needing live credentials
// for eBay/Shopify/Walmart/Amazon, since the point is that the request
// never reaches that real work at all once rate limited.
//
// channels/tiktok/select-shop is the one exception: its rate-limit check
// only runs after a signed pending-connection token is verified, and
// constructing a real one needs TIKTOK_OAUTH_PENDING_SECRET, which isn't
// configured in this environment (see CLAUDE.md's own note on this route's
// verification for the honest limitation) -- so it's covered by build/
// typecheck + code inspection only, not a live trip here.
//
// Run with: npm run test:new-rate-limited-routes-e2e --workspace=@alltix/web
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
import { computeWindowStart, DEFAULT_RATE_LIMIT_PER_MINUTE, RATE_LIMIT_ERROR_MESSAGE } from "../src/lib/rate-limit.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..");
const REPO_ROOT = join(__dirname, "..", "..", "..");

loadEnv({ path: join(REPO_ROOT, ".env") });

// Distinct from every other e2e test file's own port (4173/4174/4175).
const PORT = 4176;
const BASE_URL = `http://localhost:${PORT}`;

let pool: Pool;
let serverProcess: ChildProcessWithoutNullStreams;

const tenant = {
  tenantId: randomUUID(),
  clerkUserId: `test-clerk-user-${randomUUID()}`,
  email: "rate-limit-routes-e2e@tenant.example.com",
};

interface RouteCase {
  routeKey: string;
  path: string;
  fallbackPath: string; // where redirectWithError sends this route on a non-rate-limit error
  body: Record<string, string>;
}

// One case per newly-protected route (excluding tiktok/select-shop -- see
// header comment) -- garbage-but-well-formed bodies are fine, since the
// whole point is the request must never reach the code that would validate
// or act on them once rate limited.
const ROUTE_CASES: RouteCase[] = [
  { routeKey: "billing.checkout", path: "/api/billing/checkout", fallbackPath: "/settings/billing", body: {} },
  { routeKey: "billing.portal", path: "/api/billing/portal", fallbackPath: "/settings/billing", body: {} },
  {
    routeKey: "channels.amazon.listings",
    path: "/api/channels/amazon/listings",
    fallbackPath: "/products",
    body: { productId: randomUUID(), asin: "B000000000", price: "9.99" },
  },
  {
    routeKey: "channels.ebay.business_policies",
    path: "/api/channels/ebay/business-policies",
    fallbackPath: "/settings/channels",
    body: { fulfillmentPolicyId: "x", paymentPolicyId: "y", returnPolicyId: "z" },
  },
  {
    routeKey: "channels.ebay.listings",
    path: "/api/channels/ebay/listings",
    fallbackPath: "/products",
    body: { productId: randomUUID(), price: "9.99" },
  },
  {
    routeKey: "channels.ebay.location",
    path: "/api/channels/ebay/location",
    fallbackPath: "/settings/channels",
    body: { name: "x", addressLine1: "x", city: "x", stateOrProvince: "x", postalCode: "x", country: "US" },
  },
  {
    routeKey: "channels.shopify.listings",
    path: "/api/channels/shopify/listings",
    fallbackPath: "/products",
    body: { productId: randomUUID(), title: "x", description: "x", imageUrl: "", price: "9.99" },
  },
  {
    routeKey: "channels.walmart.listings",
    path: "/api/channels/walmart/listings",
    fallbackPath: "/products",
    body: { productId: randomUUID(), price: "9.99", gtin: "12345678" },
  },
  {
    routeKey: "channels.walmart.listings_check_status",
    path: `/api/channels/walmart/listings/${randomUUID()}/check-status`,
    fallbackPath: "/products",
    body: {},
  },
];

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

function postForm(path: string, fields: Record<string, string>): Promise<{ status: number; location: string | null }> {
  const body = new URLSearchParams(fields);
  return fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-test-clerk-user-id": tenant.clerkUserId },
    body,
    redirect: "manual",
  }).then((res) => ({ status: res.status, location: res.headers.get("location") }));
}

/** Reads the `error` query param off a redirect Location, decoded -- not a
 *  substring match, since RATE_LIMIT_ERROR_MESSAGE contains spaces that URL
 *  encoding turns into `+`/`%20`. */
function errorParam(location: string | null): string | null {
  if (!location) return null;
  return new URL(location, BASE_URL).searchParams.get("error");
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
  // api_rate_limit_windows deliberately has no DELETE grant for app_user
  // (migrations/0033_api_rate_limit_windows.sql's own doc comment -- this
  // pass never deletes a row through the app, only the scheduler's own
  // cleanupRateLimitWindows job does, via adminPool) -- so, like the
  // users/tenants cleanup right below, this has to go through an admin
  // (DATABASE_URL, RLS-bypassing) connection, not withTenant()'s app_user.
  const { Client } = await import("pg");
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query("DELETE FROM api_rate_limit_windows WHERE tenant_id = $1", [tenant.tenantId]);
  await admin.query("DELETE FROM users WHERE tenant_id = $1", [tenant.tenantId]);
  await admin.query("DELETE FROM tenants WHERE id = $1", [tenant.tenantId]);
  await admin.end();
  await pool.end();
});

/**
 * Pre-seeds exactly this one route's window to the default limit,
 * immediately before firing the request that's meant to trip it -- not once
 * for every route far ahead of time in before(). A shared, upfront seed
 * (this file's original shape) computes one windowStart and relies on every
 * subsequent request landing in that SAME one-minute window; against a real
 * clock, a slow `next dev` cold start (or, in the full suite, whatever
 * load the prior 48 test files already put on the machine) can push a
 * later request past a minute boundary, silently reseeding a brand-new,
 * un-tripped window instead of matching the pre-seeded one -- confirmed to
 * actually happen this way (8/9 route cases failed with real route errors,
 * not the rate-limit message, in exactly this shape) the first time this
 * file ran as part of the full suite rather than in isolation. Seeding
 * right before each request keeps the seed and the request within
 * milliseconds of each other, not minutes, making that race negligible
 * rather than eliminating it in theory only.
 */
async function seedRateLimitWindow(routeKey: string): Promise<void> {
  const windowStart = computeWindowStart(Date.now());
  await withTenant(pool, tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO api_rate_limit_windows (tenant_id, route_key, window_start, request_count)
       VALUES ($1, $2, to_timestamp($3 / 1000.0), $4)`,
      [tenant.tenantId, routeKey, windowStart, DEFAULT_RATE_LIMIT_PER_MINUTE],
    ),
  );
}

for (const routeCase of ROUTE_CASES) {
  test(`${routeCase.path} is rate limited -- a pre-tripped window rejects before any real work runs`, async () => {
    await seedRateLimitWindow(routeCase.routeKey);
    const result = await postForm(routeCase.path, routeCase.body);
    assert.equal(result.status, 303, `expected a 303 redirect, got ${result.status}`);
    assert.equal(
      errorParam(result.location),
      RATE_LIMIT_ERROR_MESSAGE,
      `expected the rate-limit error message, got Location: ${result.location}`,
    );
    // Confirms the redirect went to that route's OWN fallback page -- not a
    // generic error page -- same as every other rate-limited route in this
    // app.
    assert.ok(
      result.location?.startsWith(`${BASE_URL}${routeCase.fallbackPath}?`),
      `expected a redirect to ${routeCase.fallbackPath}, got ${result.location}`,
    );
  });
}

test("a route key that was never pre-seeded is NOT rate limited -- confirms independent per-route budgets, not a blanket redirect", async () => {
  // channels.ebay.business_policies was pre-seeded and IS expected to trip
  // (proven above); a route this test never touched at all must behave
  // normally -- inventory.reorder_threshold already has its own dedicated
  // coverage, so this just proves the mechanism isn't globally tripping
  // every request for this tenant regardless of route.
  const result = await postForm("/api/inventory/reorder-threshold", { reorderThresholdDays: "" });
  assert.equal(result.status, 303);
  assert.notEqual(
    errorParam(result.location),
    RATE_LIMIT_ERROR_MESSAGE,
    "an unrelated, never-pre-seeded route must not also report rate limited",
  );
});
