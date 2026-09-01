import type { PoolClient } from "pg";

// Interim stand-in for the KMS-backed encryption CLAUDE.md §6 calls for --
// no KMS integration exists in this repo yet. Uses pgcrypto's
// pgp_sym_encrypt/pgp_sym_decrypt (see migrations/0012_channel_connections.sql),
// running server-side so the key is always bound as a query parameter, never
// interpolated into SQL text.

function readEncryptionKey(): string {
  const key = process.env.CHANNEL_CREDENTIALS_ENCRYPTION_KEY;
  if (!key) {
    throw new Error(
      "Missing required environment variable: CHANNEL_CREDENTIALS_ENCRYPTION_KEY (see .env.example)",
    );
  }
  return key;
}

/** Encrypts a channel_connections secret (client_secret / refresh_token) for storage. */
export async function encryptChannelSecret(client: PoolClient, plaintext: string): Promise<Buffer> {
  const result = await client.query<{ encrypted: Buffer }>(
    "SELECT pgp_sym_encrypt($1, $2) AS encrypted",
    [plaintext, readEncryptionKey()],
  );
  return result.rows[0]!.encrypted;
}

/** Decrypts a value produced by {@link encryptChannelSecret}. */
export async function decryptChannelSecret(client: PoolClient, ciphertext: Buffer): Promise<string> {
  const result = await client.query<{ decrypted: string }>(
    "SELECT pgp_sym_decrypt($1, $2) AS decrypted",
    [ciphertext, readEncryptionKey()],
  );
  return result.rows[0]!.decrypted;
}
