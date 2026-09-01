// Direct SQL-level cross-tenant proof for channel_connections, mirroring the
// rigor of packages/web/test/tenant-isolation.e2e.test.ts (SELECT/UPDATE/
// DELETE/INSERT) but at the DB layer -- there's no HTTP API for this table
// yet, so there's nothing to boot a Next.js server against.
//
// Run with: npm run test --workspace=@alltix/db
// Requires: Postgres reachable via the .env at the repo root, with
// migrations applied (npm run db:migrate).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { createAppPool, withTenant, encryptChannelSecret, decryptChannelSecret } from "../src/index.js";
import type { Pool } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

loadEnv({ path: join(REPO_ROOT, ".env") });
// Only needed so encryptChannelSecret/decryptChannelSecret have a key to
// bind -- this test never asserts anything about key management itself.
process.env.CHANNEL_CREDENTIALS_ENCRYPTION_KEY ??= "test-only-key-do-not-use-in-prod";

let pool: Pool;

const tenantA = { tenantId: randomUUID() };
const tenantB = { tenantId: randomUUID() };

// Each call inserts under a fresh external_account_id -- tests run against
// the same two tenant ids, and (tenant_id, channel, marketplace,
// external_account_id) is UNIQUE, so reusing one id across independent test
// cases would collide instead of exercising RLS.
async function insertConnection(tenantId: string): Promise<string> {
  return withTenant(pool, tenantId, async (client) => {
    const clientSecret = await encryptChannelSecret(client, "client-secret-plaintext");
    const refreshToken = await encryptChannelSecret(client, "refresh-token-plaintext");
    const result = await client.query<{ id: string }>(
      `INSERT INTO channel_connections
         (tenant_id, channel, marketplace, external_account_id, lwa_client_id, encrypted_client_secret, encrypted_refresh_token)
       VALUES ($1, 'amazon', 'UK', $2, 'lwa-client-id', $3, $4)
       RETURNING id`,
      [tenantId, `SELLER-${randomUUID().slice(0, 8)}`, clientSecret, refreshToken],
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
  await withTenant(pool, tenantA.tenantId, (client) =>
    client.query("DELETE FROM channel_connections WHERE tenant_id = $1", [tenantA.tenantId]),
  );
  await withTenant(pool, tenantB.tenantId, (client) =>
    client.query("DELETE FROM channel_connections WHERE tenant_id = $1", [tenantB.tenantId]),
  );
  await pool.end();
});

test("secrets round-trip through pgcrypto and are never stored as plaintext", async () => {
  const id = await insertConnection(tenantA.tenantId);

  const stored = await withTenant(pool, tenantA.tenantId, (client) =>
    client.query<{ encrypted_client_secret: Buffer; encrypted_refresh_token: Buffer }>(
      "SELECT encrypted_client_secret, encrypted_refresh_token FROM channel_connections WHERE id = $1",
      [id],
    ),
  );
  const row = stored.rows[0]!;
  assert.ok(!row.encrypted_client_secret.toString("utf8").includes("client-secret-plaintext"));
  assert.ok(!row.encrypted_refresh_token.toString("utf8").includes("refresh-token-plaintext"));

  const decrypted = await withTenant(pool, tenantA.tenantId, (client) =>
    decryptChannelSecret(client, row.encrypted_client_secret),
  );
  assert.equal(decrypted, "client-secret-plaintext");
});

test("SELECT never returns another tenant's connection", async () => {
  const idB = await insertConnection(tenantB.tenantId);

  const asA = await withTenant(pool, tenantA.tenantId, (client) =>
    client.query("SELECT id FROM channel_connections"),
  );
  assert.ok(
    !asA.rows.some((r) => (r as { id: string }).id === idB),
    "tenant A must never see tenant B's connection",
  );

  const asADirectLookup = await withTenant(pool, tenantA.tenantId, (client) =>
    client.query("SELECT id FROM channel_connections WHERE tenant_id = $1", [tenantB.tenantId]),
  );
  assert.equal(
    asADirectLookup.rowCount,
    0,
    "querying by tenant B's tenant_id while in tenant A's session context must still return nothing",
  );
});

test("UPDATE from the wrong tenant context affects zero rows", async () => {
  const idB = await insertConnection(tenantB.tenantId);

  const result = await withTenant(pool, tenantA.tenantId, (client) =>
    client.query("UPDATE channel_connections SET status = 'error' WHERE id = $1", [idB]),
  );
  assert.equal(result.rowCount, 0);

  const check = await withTenant(pool, tenantB.tenantId, (client) =>
    client.query<{ status: string }>("SELECT status FROM channel_connections WHERE id = $1", [idB]),
  );
  assert.equal(check.rows[0]?.status, "active", "tenant B's row must be unaffected by tenant A's UPDATE");
});

test("DELETE from the wrong tenant context affects zero rows", async () => {
  const idB = await insertConnection(tenantB.tenantId);

  const result = await withTenant(pool, tenantA.tenantId, (client) =>
    client.query("DELETE FROM channel_connections WHERE id = $1", [idB]),
  );
  assert.equal(result.rowCount, 0);

  const check = await withTenant(pool, tenantB.tenantId, (client) =>
    client.query("SELECT id FROM channel_connections WHERE id = $1", [idB]),
  );
  assert.equal(check.rowCount, 1, "tenant A's DELETE must not have removed tenant B's row");
});

test("INSERT with a mismatched tenant_id is rejected by the WITH CHECK policy", async () => {
  await assert.rejects(
    withTenant(pool, tenantA.tenantId, (client) =>
      client.query(
        `INSERT INTO channel_connections
           (tenant_id, channel, marketplace, external_account_id, lwa_client_id, encrypted_client_secret, encrypted_refresh_token)
         VALUES ($1, 'amazon', 'UK', 'forged-account', 'client', pgp_sym_encrypt('x', 'k'), pgp_sym_encrypt('y', 'k'))`,
        [tenantB.tenantId],
      ),
    ),
    /row-level security/i,
  );
});
