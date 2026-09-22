import type { Pool } from "pg";
import { withTenant, encryptChannelSecret } from "@alltix/db";

/**
 * Encrypts and upserts a completed TikTok Shop credential set into
 * `channel_connections`, using the exact column mapping
 * loadTikTokCredentialsFromChannelConnection's own doc comment
 * (tiktok-connector.ts) documents: lwa_client_id = appKey,
 * encrypted_client_secret = appSecret, encrypted_access_token = accessToken,
 * encrypted_refresh_token = refreshToken, external_account_id = shopCipher.
 *
 * Extracted here so the three real callers -- the manual-paste POST handler
 * (../app/api/channels/tiktok/connect/route.ts), the OAuth callback's
 * single-shop fast path, and the OAuth shop-picker's POST target
 * (../app/api/channels/tiktok/select-shop/route.ts) -- share one copy of
 * this upsert instead of three near-identical ones drifting apart. Any of
 * the three can reconnect/overwrite what either of the other two stored.
 */
export interface TikTokConnectionToPersist {
  appKey: string;
  appSecret: string;
  accessToken: string;
  refreshToken: string;
  shopCipher: string;
}

export async function persistTikTokConnection(pool: Pool, tenantId: string, creds: TikTokConnectionToPersist): Promise<void> {
  await withTenant(pool, tenantId, async (client) => {
    const [encryptedAppSecret, encryptedAccessToken, encryptedRefreshToken] = await Promise.all([
      encryptChannelSecret(client, creds.appSecret),
      encryptChannelSecret(client, creds.accessToken),
      encryptChannelSecret(client, creds.refreshToken),
    ]);

    await client.query(
      `INSERT INTO channel_connections
         (tenant_id, channel, marketplace, external_account_id, lwa_client_id,
          encrypted_client_secret, encrypted_access_token, encrypted_refresh_token, status)
       VALUES ($1, 'tiktok', '', $2, $3, $4, $5, $6, 'active')
       ON CONFLICT (tenant_id, channel, marketplace, external_account_id)
       DO UPDATE SET
         lwa_client_id = EXCLUDED.lwa_client_id,
         encrypted_client_secret = EXCLUDED.encrypted_client_secret,
         encrypted_access_token = EXCLUDED.encrypted_access_token,
         encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
         status = 'active',
         updated_at = now()`,
      [tenantId, creds.shopCipher, creds.appKey, encryptedAppSecret, encryptedAccessToken, encryptedRefreshToken],
    );
  });
}
