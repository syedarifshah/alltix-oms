// Proves the sync-failure-tracking columns added by
// migrations/0021_channel_connections_failure_tracking.sql actually work --
// both the real wiring (syncShopifyOrders()'s catch block calling
// recordSyncFailure()/recordSyncSuccess()) and those two helpers called
// directly. Needs only a real local Postgres (npm run db:migrate) -- unlike
// amazon-order-sync-e2e.test.ts, no live marketplace credentials or network
// call of any kind is involved: the Shopify tenant seeded here gets a
// channel_connections row with no encrypted_access_token at all, which
// loadShopifyCredentialsFromChannelConnection (shopify-connector.ts)
// rejects synchronously, before ever reaching the network -- a
// guaranteed, deterministic failure to drive the tracking logic with,
// not a flaky "hope the sandbox is up" one. Shopify (not Amazon/Walmart)
// is used here purely because its relaxed-nullable columns (migration
// 0019) let a minimal, credential-free row be inserted at all.
//
// Run with: npm run test --workspace=@alltix/scheduler -- sync-failure-tracking

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import type { Pool } from "pg";
import { createAppPool, withTenant, withTenantAndUser } from "@alltix/db";
import { InProcessEventBus } from "@alltix/shared";
import {
  syncShopifyOrders,
  recordSyncFailure,
  recordSyncSuccess,
  CONSECUTIVE_FAILURE_ERROR_THRESHOLD,
} from "../src/index.js";

// Same .env-loading as amazon-order-sync-e2e.test.ts's own header comment
// explains -- needed here purely for APP_DATABASE_URL/DATABASE_URL
// (connecting to local Postgres), not for any marketplace credential (see
// this file's top-of-file comment: no network call happens in this file at
// all).
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
  last_failure_at: string | null;
  last_failure_message: string | null;
}

/** A 'shopify' channel_connections row with no encrypted_access_token --
 *  see this file's header comment for why that's the deterministic,
 *  network-free failure trigger this whole file relies on. */
async function seedBrokenShopifyConnection(): Promise<string> {
  const tenantId = randomUUID();
  await withTenant(appPool, tenantId, (client) =>
    client.query(
      `INSERT INTO channel_connections (tenant_id, channel, marketplace, external_account_id)
       VALUES ($1, 'shopify', '', $2)`,
      [tenantId, `broken-test-${tenantId.slice(0, 8)}.myshopify.com`],
    ),
  );
  return tenantId;
}

async function getConnection(tenantId: string): Promise<ConnectionRow> {
  const result = await withTenant(appPool, tenantId, (client) =>
    client.query<ConnectionRow>(
      `SELECT status, consecutive_failures, last_failure_at, last_failure_message
         FROM channel_connections WHERE tenant_id = $1 AND channel = 'shopify'`,
      [tenantId],
    ),
  );
  const row = result.rows[0];
  assert.ok(row, `expected a channel_connections row for tenant ${tenantId}`);
  return row;
}

async function cleanup(tenantId: string): Promise<void> {
  await withTenant(appPool, tenantId, (client) =>
    client.query("DELETE FROM channel_connections WHERE tenant_id = $1", [tenantId]),
  );
}

/** Same broken-connection shape as seedBrokenShopifyConnection(), but for a
 *  tenantId the caller already minted -- needed by the notifyTenantUsers()
 *  test below, which has to seed a real `tenants` row (and `users` rows
 *  under it) FIRST, via seedTenantWithUsers(), rather than letting this
 *  function mint its own random tenant id the way seedBrokenShopifyConnection()
 *  does. */
async function seedBrokenShopifyConnectionForTenant(tenantId: string): Promise<void> {
  await withTenant(appPool, tenantId, (client) =>
    client.query(
      `INSERT INTO channel_connections (tenant_id, channel, marketplace, external_account_id)
       VALUES ($1, 'shopify', '', $2)`,
      [tenantId, `broken-test-${tenantId.slice(0, 8)}.myshopify.com`],
    ),
  );
}

/**
 * Seeds a REAL `tenants` row plus one `users` row per given email --
 * needed to test recordSyncFailure()'s new notifyTenantUsers() call, which
 * reads real `users.email` values. `users.tenant_id` is the one table in
 * this schema with a real FK to `tenants(id)` (migration 0010's own
 * comment), unlike every tenant-scoped table `seedBrokenShopifyConnection()`
 * above gets away with seeding against a bare synthetic UUID -- so a real
 * `tenants` row has to exist first.
 *
 * `app_user` has no INSERT grant on `tenants` (only SELECT/UPDATE --
 * confirmed via migration 0010_tenants_and_users.sql's own GRANT
 * statements), so the `tenants` insert goes through `adminPool`
 * (DATABASE_URL, the schema-owning connection already used elsewhere in
 * this codebase for legitimately cross-tenant/system-level operations --
 * see SyncAmazonOrdersParams.adminPool's own doc comment in
 * packages/scheduler/src/index.ts). `users` DOES have an app_user INSERT
 * grant, but its RLS policy (self_lookup_users) is scoped by
 * `app.clerk_user_id`, not `app.tenant_id` -- withTenant() alone never sets
 * that, so the insert needs withTenantAndUser() (packages/db/src/pool.ts),
 * which sets both in the same transaction, exactly the way
 * provisionTenantForNewUser() itself does for a real signup.
 */
async function seedTenantWithUsers(emails: string[]): Promise<string> {
  const tenantId = randomUUID();
  await adminPool.query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, [
    tenantId,
    `notify-test-tenant-${tenantId.slice(0, 8)}`,
  ]);
  for (const email of emails) {
    const clerkUserId = `test-clerk-${randomUUID()}`;
    await withTenantAndUser(appPool, { tenantId, clerkUserId }, (client) =>
      client.query(`INSERT INTO users (tenant_id, clerk_user_id, email) VALUES ($1, $2, $3)`, [
        tenantId,
        clerkUserId,
        email,
      ]),
    );
  }
  return tenantId;
}

/** Counterpart to seedTenantWithUsers() -- app_user has no DELETE grant on
 *  either `users` or `tenants` (same migration 0010 GRANT statements), so
 *  cleanup goes through adminPool, users first to respect the FK. */
async function cleanupTenantWithUsers(tenantId: string): Promise<void> {
  await adminPool.query(`DELETE FROM users WHERE tenant_id = $1`, [tenantId]);
  await adminPool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
}

test("a Shopify connection with no access token fails deterministically, with no network call", async () => {
  const tenantId = await seedBrokenShopifyConnection();
  try {
    const results = await syncShopifyOrders({ appPool, adminPool, eventBus: new InProcessEventBus() });
    const ourResult = results.find((r) => r.tenantId === tenantId);
    assert.ok(ourResult, "syncShopifyOrders must discover the seeded tenant via its cross-tenant enumeration query");
    assert.equal(ourResult.success, false);
    assert.match(ourResult.error ?? "", /No active 'shopify' channel_connections row/);
  } finally {
    await cleanup(tenantId);
  }
});

test(`status flips to 'error' after ${CONSECUTIVE_FAILURE_ERROR_THRESHOLD} consecutive failed runs, then the tenant stops being discovered`, async () => {
  const tenantId = await seedBrokenShopifyConnection();
  try {
    for (let i = 1; i <= CONSECUTIVE_FAILURE_ERROR_THRESHOLD; i++) {
      const results = await syncShopifyOrders({ appPool, adminPool, eventBus: new InProcessEventBus() });
      const ourResult = results.find((r) => r.tenantId === tenantId);
      assert.ok(ourResult, `run ${i}: tenant must still be discovered going into this run (status was 'active' beforehand)`);
      assert.equal(ourResult.success, false);

      const row = await getConnection(tenantId);
      assert.equal(row.consecutive_failures, i);
      if (i < CONSECUTIVE_FAILURE_ERROR_THRESHOLD) {
        assert.equal(row.status, "active", `run ${i}: must stay 'active' below the threshold`);
      } else {
        assert.equal(row.status, "error", `run ${i}: must flip to 'error' at the threshold`);
        assert.ok(row.last_failure_at);
        assert.match(row.last_failure_message ?? "", /No active 'shopify' channel_connections row/);
      }
    }

    // One more run: the row is now status='error', so the discovery
    // query's own `WHERE status = 'active'` filter must exclude it --
    // proves the "self-removes from the active pool" behavior
    // recordSyncFailure()'s doc comment claims, not just the column value.
    const resultsAfterError = await syncShopifyOrders({ appPool, adminPool, eventBus: new InProcessEventBus() });
    assert.ok(
      !resultsAfterError.some((r) => r.tenantId === tenantId),
      "an 'error' connection must not be re-discovered/re-attempted by the next run",
    );
    const row = await getConnection(tenantId);
    assert.equal(
      row.consecutive_failures,
      CONSECUTIVE_FAILURE_ERROR_THRESHOLD,
      "consecutive_failures must stop climbing once status='error' -- the row left the active pool",
    );
  } finally {
    await cleanup(tenantId);
  }
});

test("recordSyncSuccess resets consecutive_failures to 0 but leaves last_failure_at/last_failure_message in place", async () => {
  const tenantId = await seedBrokenShopifyConnection();
  try {
    await recordSyncFailure(appPool, tenantId, "shopify", "simulated failure");
    const afterFailure = await getConnection(tenantId);
    assert.equal(afterFailure.consecutive_failures, 1);
    assert.equal(afterFailure.status, "active");
    assert.ok(afterFailure.last_failure_at);

    await recordSyncSuccess(appPool, tenantId, "shopify");
    const afterSuccess = await getConnection(tenantId);
    assert.equal(afterSuccess.consecutive_failures, 0, "a successful run must reset the counter");
    assert.equal(afterSuccess.status, "active");
    assert.ok(afterSuccess.last_failure_at, "last_failure_at must NOT be cleared by a success -- history stays visible");
    assert.equal(
      afterSuccess.last_failure_message,
      "simulated failure",
      "last_failure_message must NOT be cleared by a success either",
    );
  } finally {
    await cleanup(tenantId);
  }
});

test("recordSyncFailure does not keep incrementing an already-'error' row (self-removal is permanent until reconnect)", async () => {
  const tenantId = await seedBrokenShopifyConnection();
  try {
    for (let i = 0; i < CONSECUTIVE_FAILURE_ERROR_THRESHOLD; i++) {
      await recordSyncFailure(appPool, tenantId, "shopify", `failure ${i + 1}`);
    }
    const errored = await getConnection(tenantId);
    assert.equal(errored.status, "error");
    assert.equal(errored.consecutive_failures, CONSECUTIVE_FAILURE_ERROR_THRESHOLD);

    await recordSyncFailure(appPool, tenantId, "shopify", "one more failure after error");
    const stillErrored = await getConnection(tenantId);
    assert.equal(
      stillErrored.consecutive_failures,
      CONSECUTIVE_FAILURE_ERROR_THRESHOLD,
      "must not climb past the threshold once status='error'",
    );
    assert.equal(
      stillErrored.last_failure_message,
      `failure ${CONSECUTIVE_FAILURE_ERROR_THRESHOLD}`,
      "must not overwrite last_failure_message once status='error' either -- the row is a fixed historical marker",
    );
  } finally {
    await cleanup(tenantId);
  }
});

test("recordSyncFailure emails the tenant's own users exactly once, on the run that crosses the failure threshold", async () => {
  const tenantId = await seedTenantWithUsers(["owner@example.test", "teammate@example.test"]);
  await seedBrokenShopifyConnectionForTenant(tenantId);

  const originalApiKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = "re_test_key";
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    callCount++;
    capturedInit = init;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    for (let i = 1; i < CONSECUTIVE_FAILURE_ERROR_THRESHOLD; i++) {
      await recordSyncFailure(appPool, tenantId, "shopify", `failure ${i}`);
    }
    assert.equal(callCount, 0, "must not notify before the connection actually crosses the threshold");

    await recordSyncFailure(appPool, tenantId, "shopify", "final straw failure");
    assert.equal(callCount, 1, "must notify exactly once, on the run that flips status to 'error'");

    const body = JSON.parse(capturedInit?.body as string) as { to: string[]; subject: string; text: string };
    assert.deepEqual(
      [...body.to].sort(),
      ["owner@example.test", "teammate@example.test"].sort(),
      "recipients must be exactly this tenant's own users' emails, nothing more/less",
    );
    assert.match(body.subject, /shopify connection has stopped syncing/);
    assert.match(body.text, /final straw failure/);
    assert.match(body.text, /\/settings\/channels/, "the email must point the tenant at how to fix it");

    // A further failure past the threshold must not re-notify --
    // recordSyncFailure()'s own WHERE status = 'active' guard means the
    // UPDATE returns zero rows once already 'error', so the notify branch
    // (gated on RETURNING a row at all) never re-fires.
    await recordSyncFailure(appPool, tenantId, "shopify", "post-error failure");
    assert.equal(callCount, 1, "must not re-notify once the connection is already status='error'");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.RESEND_API_KEY;
    } else {
      process.env.RESEND_API_KEY = originalApiKey;
    }
    await cleanup(tenantId);
    await cleanupTenantWithUsers(tenantId);
  }
});
