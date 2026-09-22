// Proves the cross-run half of CLAUDE.md §4.4's rate limit/circuit breaker
// (migration 0024_channel_connections_rate_limited_until.sql +
// recordRateLimitTrip()) actually works: the DB write itself, that it's
// independent of the consecutive_failures/'error' tracking
// sync-failure-tracking.test.ts already covers, and -- the part that
// matters operationally -- that a cooled-down connection is genuinely
// skipped by syncShopifyOrders()'s discovery query and picked back up once
// the cooldown lapses or a real success clears it.
//
// Same "no live marketplace credentials, no network call" shape as
// sync-failure-tracking.test.ts: a 'shopify' channel_connections row with
// no encrypted_access_token fails deterministically before ever reaching
// the network, which is exactly what's needed here -- these tests are
// about whether a tenant is *discovered* at all, not about what happens
// once discovery hands it to a connector. Needs only a real local Postgres
// (npm run db:migrate).
//
// Run with: npm run test --workspace=@alltix/scheduler -- rate-limit-cooldown

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import type { Pool } from "pg";
import { createAppPool, withTenant } from "@alltix/db";
import { InProcessEventBus } from "@alltix/shared";
import { syncShopifyOrders, recordRateLimitTrip, recordSyncSuccess, RATE_LIMIT_COOLDOWN_MS } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
loadEnv({ path: join(REPO_ROOT, ".env") });

let appPool: Pool;
let adminPool: Pool;

before(() => {
  const appConnectionString = process.env.APP_DATABASE_URL;
  const adminConnectionString = process.env.DATABASE_URL;
  if (!appConnectionString) throw new Error("APP_DATABASE_URL is not set (see .env.example)");
  if (!adminConnectionString) throw new Error("DATABASE_URL is not set (see .env.example)");
  appPool = createAppPool({ connectionString: appConnectionString });
  adminPool = createAppPool({ connectionString: adminConnectionString });
});

after(async () => {
  await appPool.end();
  await adminPool.end();
});

interface ConnectionRow {
  status: string;
  consecutive_failures: number;
  rate_limited_until: string | null;
}

/** Same deterministic, network-free broken 'shopify' row as
 *  sync-failure-tracking.test.ts's seedBrokenShopifyConnection(). */
async function seedShopifyConnection(): Promise<string> {
  const tenantId = randomUUID();
  await withTenant(appPool, tenantId, (client) =>
    client.query(
      `INSERT INTO channel_connections (tenant_id, channel, marketplace, external_account_id)
       VALUES ($1, 'shopify', '', $2)`,
      [tenantId, `rate-limit-test-${tenantId.slice(0, 8)}.myshopify.com`],
    ),
  );
  return tenantId;
}

async function getConnection(tenantId: string): Promise<ConnectionRow> {
  const result = await withTenant(appPool, tenantId, (client) =>
    client.query<ConnectionRow>(
      `SELECT status, consecutive_failures, rate_limited_until
         FROM channel_connections WHERE tenant_id = $1 AND channel = 'shopify'`,
      [tenantId],
    ),
  );
  const row = result.rows[0];
  assert.ok(row, `expected a channel_connections row for tenant ${tenantId}`);
  return row;
}

async function setRateLimitedUntil(tenantId: string, when: Date | null): Promise<void> {
  await withTenant(appPool, tenantId, (client) =>
    client.query(`UPDATE channel_connections SET rate_limited_until = $1 WHERE tenant_id = $2 AND channel = 'shopify'`, [
      when,
      tenantId,
    ]),
  );
}

async function cleanup(tenantId: string): Promise<void> {
  await withTenant(appPool, tenantId, (client) =>
    client.query("DELETE FROM channel_connections WHERE tenant_id = $1", [tenantId]),
  );
}

test("recordRateLimitTrip stamps rate_limited_until at least RATE_LIMIT_COOLDOWN_MS out, without touching status/consecutive_failures", async () => {
  const tenantId = await seedShopifyConnection();
  try {
    const before = Date.now();
    await recordRateLimitTrip(appPool, tenantId, "shopify", null);
    const row = await getConnection(tenantId);

    assert.equal(row.status, "active", "a rate-limit trip must not flip status to 'error' -- it's not a dead credential");
    assert.equal(row.consecutive_failures, 0, "a rate-limit trip must not touch consecutive_failures");
    assert.ok(row.rate_limited_until, "rate_limited_until must be set");
    const untilMs = new Date(row.rate_limited_until!).getTime();
    assert.ok(
      untilMs >= before + RATE_LIMIT_COOLDOWN_MS,
      `expected rate_limited_until >= now + ${RATE_LIMIT_COOLDOWN_MS}ms, got ${untilMs - before}ms out`,
    );
  } finally {
    await cleanup(tenantId);
  }
});

test("recordRateLimitTrip honors a longer Retry-After over the default cooldown", async () => {
  const tenantId = await seedShopifyConnection();
  try {
    const longRetryAfterMs = RATE_LIMIT_COOLDOWN_MS * 3;
    const before = Date.now();
    await recordRateLimitTrip(appPool, tenantId, "shopify", longRetryAfterMs);
    const row = await getConnection(tenantId);

    const untilMs = new Date(row.rate_limited_until!).getTime();
    assert.ok(
      untilMs >= before + longRetryAfterMs - 1000,
      "a Retry-After longer than the default cooldown must be honored, not clamped down to the default",
    );
  } finally {
    await cleanup(tenantId);
  }
});

test("a connection with a future rate_limited_until is skipped by syncShopifyOrders' discovery query", async () => {
  const tenantId = await seedShopifyConnection();
  try {
    await setRateLimitedUntil(tenantId, new Date(Date.now() + RATE_LIMIT_COOLDOWN_MS));

    const results = await syncShopifyOrders({ appPool, adminPool, eventBus: new InProcessEventBus() });
    assert.ok(
      !results.some((r) => r.tenantId === tenantId),
      "a connection still inside its cooldown window must not be discovered/attempted at all",
    );
  } finally {
    await cleanup(tenantId);
  }
});

test("a connection whose rate_limited_until has already passed is discovered again", async () => {
  const tenantId = await seedShopifyConnection();
  try {
    await setRateLimitedUntil(tenantId, new Date(Date.now() - 1000));

    const results = await syncShopifyOrders({ appPool, adminPool, eventBus: new InProcessEventBus() });
    assert.ok(
      results.some((r) => r.tenantId === tenantId),
      "a cooldown that already expired must not keep excluding the connection",
    );
  } finally {
    await cleanup(tenantId);
  }
});

test("a connection with rate_limited_until = NULL is discovered normally", async () => {
  const tenantId = await seedShopifyConnection();
  try {
    const results = await syncShopifyOrders({ appPool, adminPool, eventBus: new InProcessEventBus() });
    assert.ok(results.some((r) => r.tenantId === tenantId), "NULL rate_limited_until must never exclude a connection");
  } finally {
    await cleanup(tenantId);
  }
});

test("recordRateLimitTrip never emails the tenant, even with RESEND_API_KEY set -- deliberately Sentry/log-only (see its own doc comment on alert fatigue)", async () => {
  const tenantId = await seedShopifyConnection();
  const originalApiKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = "re_test_key";
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount++;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    await recordRateLimitTrip(appPool, tenantId, "shopify", null);
    assert.equal(
      callCount,
      0,
      "a rate-limit trip is self-healing and non-actionable -- it must never call sendEmail, unlike recordSyncFailure's threshold-crossing branch",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.RESEND_API_KEY;
    } else {
      process.env.RESEND_API_KEY = originalApiKey;
    }
    await cleanup(tenantId);
  }
});

test("recordSyncSuccess clears an in-progress rate_limited_until", async () => {
  const tenantId = await seedShopifyConnection();
  try {
    await recordRateLimitTrip(appPool, tenantId, "shopify", null);
    const tripped = await getConnection(tenantId);
    assert.ok(tripped.rate_limited_until, "sanity check: the trip actually set the column");

    await recordSyncSuccess(appPool, tenantId, "shopify");
    const recovered = await getConnection(tenantId);
    assert.equal(recovered.rate_limited_until, null, "a demonstrated success must clear the cooldown, not make it wait out the clock");
  } finally {
    await cleanup(tenantId);
  }
});
