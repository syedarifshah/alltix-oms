// End-to-end proof, through the real HTTP layer, that POST
// /api/leads/demo-request is actually rate limited -- closing the gap
// CLAUDE.md §16's own "fourth pass" note named as the one mutation route
// every earlier rate-limiting pass left unprotected. Every other
// rate-limited route in this app is session-authenticated and keyed by
// tenantId; this one is public/unauthenticated (see that route's own doc
// comment) and keyed by the requester's own IP address instead
// (getClientIp/checkIpRateLimit, migration
// 0036_public_ip_rate_limit_windows.sql).
//
// Unlike new-rate-limited-routes-e2e.test.ts's 10 cases -- which pre-seed
// each route's window to the tenant-scoped DEFAULT_RATE_LIMIT_PER_MINUTE
// (120) rather than firing 120+ real requests against a route that would
// otherwise call Stripe or a real marketplace API -- this route's own limit
// (DEFAULT_PUBLIC_RATE_LIMIT_PER_MINUTE, 5) is small and its real work is
// just a local DB insert plus a no-op email (RESEND_API_KEY is unset in
// every test environment), so this test fires the actual requests rather
// than pre-seeding the window table directly -- a more direct proof, and
// cheap enough (6 requests, not 121) not to need the pre-seed shortcut.
//
// Run with: npm run test:demo-request-rate-limit-e2e --workspace=@alltix/web
// Requires: Postgres reachable via the .env at the repo root, with
// migrations applied (npm run db:migrate).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { Client } from "pg";
import { DEFAULT_PUBLIC_RATE_LIMIT_PER_MINUTE, RATE_LIMIT_ERROR_MESSAGE } from "../src/lib/rate-limit.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..");
const REPO_ROOT = join(__dirname, "..", "..", "..");

loadEnv({ path: join(REPO_ROOT, ".env") });

// Distinct from every other e2e test file's own port (4173-4176) -- node:test
// runs files concurrently by default, and two `next dev` instances racing
// for the same port would make one of them fail to start.
const PORT = 4177;
const BASE_URL = `http://localhost:${PORT}`;

// A fixed test-run id lets cleanup find exactly (and only) the rows this
// run created, whichever of the two simulated IPs below wrote them --
// mirroring every other e2e file's own "one unique, greppable marker,
// cleaned up by an admin connection since app_user has no SELECT/DELETE
// grant on demo_requests or DELETE on public_ip_rate_limit_windows" shape.
const RUN_ID = randomUUID();
const RATE_LIMITED_IP = `203.0.113.${1 + Math.floor(Math.random() * 200)}`;
const UNAFFECTED_IP = `198.51.100.${1 + Math.floor(Math.random() * 200)}`;

let serverProcess: ChildProcessWithoutNullStreams;

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

/** Posts a demo-request submission as the given simulated client IP --
 *  `next dev` has no real proxy in front of it locally, so this sets
 *  `x-forwarded-for` directly, exactly the header getClientIp() reads. */
function postDemoRequest(fromIp: string, index: number): Promise<{ status: number; retryAfter: string | null; body: { error?: string; status?: string } }> {
  return fetch(`${BASE_URL}/api/leads/demo-request`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": fromIp },
    body: JSON.stringify({
      name: "Rate Limit Test",
      email: `rate-limit-e2e-${RUN_ID}-${index}@tenant.example.com`,
      company: "",
      message: "",
    }),
  }).then(async (res) => ({
    status: res.status,
    retryAfter: res.headers.get("retry-after"),
    body: (await res.json()) as { error?: string; status?: string },
  }));
}

before(async () => {
  serverProcess = spawn("npx", ["next", "dev", "-p", String(PORT)], {
    cwd: WEB_DIR,
    env: { ...process.env },
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
  // demo_requests has no SELECT/DELETE grant for app_user (migrations/
  // 0017_demo_requests.sql's own doc comment -- deliberately unreadable by
  // the app itself), and public_ip_rate_limit_windows has no DELETE grant
  // either (migrations/0036_public_ip_rate_limit_windows.sql's own GRANT
  // comment) -- both cleanups need an admin (DATABASE_URL, RLS-bypassing)
  // connection, same as every other e2e test file's own tenant/user
  // cleanup.
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query("DELETE FROM demo_requests WHERE email LIKE $1", [`rate-limit-e2e-${RUN_ID}-%`]);
  await admin.query("DELETE FROM public_ip_rate_limit_windows WHERE ip_address = ANY($1)", [
    [RATE_LIMITED_IP, UNAFFECTED_IP],
  ]);
  await admin.end();
});

test("the first DEFAULT_PUBLIC_RATE_LIMIT_PER_MINUTE requests from one IP all succeed", async () => {
  for (let i = 0; i < DEFAULT_PUBLIC_RATE_LIMIT_PER_MINUTE; i++) {
    const result = await postDemoRequest(RATE_LIMITED_IP, i);
    assert.equal(result.status, 200, `request ${i + 1} of ${DEFAULT_PUBLIC_RATE_LIMIT_PER_MINUTE} should succeed`);
    assert.equal(result.body.status, "received");
  }
});

test("the next request from the same IP, over the limit, is rejected with 429 + Retry-After", async () => {
  const result = await postDemoRequest(RATE_LIMITED_IP, DEFAULT_PUBLIC_RATE_LIMIT_PER_MINUTE);
  assert.equal(result.status, 429);
  assert.equal(result.body.error, RATE_LIMIT_ERROR_MESSAGE);
  assert.ok(result.retryAfter, "expected a Retry-After header on a 429 response");
  assert.ok(Number(result.retryAfter) >= 1, `expected Retry-After to be a positive number of seconds, got ${result.retryAfter}`);
});

test("a request from a DIFFERENT IP is unaffected -- confirms the limit is per-IP, not global", async () => {
  const result = await postDemoRequest(UNAFFECTED_IP, 0);
  assert.equal(result.status, 200, "a different IP's own budget must be untouched by the rate-limited IP's requests");
  assert.equal(result.body.status, "received");
});
