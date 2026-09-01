import "dotenv/config";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createAppPool, withTenant, encryptChannelSecret } from "../packages/db/src/index.js";

// Inserts one channel_connections row for a brand-new test tenant, using the
// AMAZON_SANDBOX_* credentials already in .env -- proves the encrypt-then-
// store path (packages/db/src/encryption.ts) with real values instead of the
// RLS test's throwaway fixture strings. A fresh tenant_id is generated every
// run: (tenant_id, channel, marketplace, external_account_id) is UNIQUE, and
// there's no reason to collide with previous runs' rows.
//
// Reused by scripts/amazon-pull-orders-smoke-test.ts via
// seedTestChannelConnection() so that script doesn't duplicate this logic.

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  }
  return value;
}

export interface SeededChannelConnection {
  tenantId: string;
  connectionId: string;
}

/** Encrypts and inserts one 'amazon' channel_connections row for a fresh tenant. Never logs the decrypted values. */
export async function seedTestChannelConnection(pool: Pool): Promise<SeededChannelConnection> {
  const clientId = readRequiredEnv("AMAZON_SANDBOX_CLIENT_ID");
  const clientSecret = readRequiredEnv("AMAZON_SANDBOX_CLIENT_SECRET");
  const refreshToken = readRequiredEnv("AMAZON_SANDBOX_REFRESH_TOKEN");

  const tenantId = randomUUID();

  const connectionId = await withTenant(pool, tenantId, async (client) => {
    const encryptedClientSecret = await encryptChannelSecret(client, clientSecret);
    const encryptedRefreshToken = await encryptChannelSecret(client, refreshToken);

    const result = await client.query<{ id: string }>(
      `INSERT INTO channel_connections
         (tenant_id, channel, marketplace, external_account_id, lwa_client_id, encrypted_client_secret, encrypted_refresh_token)
       VALUES ($1, 'amazon', 'UK', $2, $3, $4, $5)
       RETURNING id`,
      [
        tenantId,
        `SANDBOX-SELLER-${randomUUID().slice(0, 8)}`,
        clientId,
        encryptedClientSecret,
        encryptedRefreshToken,
      ],
    );
    return result.rows[0]!.id;
  });

  return { tenantId, connectionId };
}

async function main(): Promise<void> {
  const pool = createAppPool({ connectionString: readRequiredEnv("APP_DATABASE_URL") });
  try {
    const { tenantId, connectionId } = await seedTestChannelConnection(pool);
    console.log("Seeded channel_connections row for a fresh test tenant.");
    console.log(`  tenant_id: ${tenantId}`);
    console.log(`  channel_connections.id: ${connectionId}`);
  } finally {
    await pool.end();
  }
}

// Only run as a CLI entrypoint -- when imported (e.g. by
// amazon-pull-orders-smoke-test.ts) this must not also seed+print on its own.
const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((error: unknown) => {
    console.error("Seed failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
