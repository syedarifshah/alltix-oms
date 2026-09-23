import type { Pool } from "pg";
import { withTenant, encryptChannelSecret, recordAuditEvent } from "@alltix/db";

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
 *
 * Also the one place that needs to record the audit event for all three
 * callers -- same "instrument the shared chokepoint once" reasoning
 * OrderService.transition() already applies to ~50 order-mutation call
 * sites (CLAUDE.md §17). actorUserId is optional because not every caller
 * has resolved a current-user row (mirrors OrderService.transition()'s own
 * actorUserId?: string | null param) -- audit rows accept a null userId
 * for exactly this reason. Never logs a secret value, only which
 * channel/account changed; xmax = 0 distinguishes a brand-new connection
 * from a credential rotation on an existing one, same as the Amazon/eBay
 * OAuth callbacks' identical INSERT ... ON CONFLICT DO UPDATE ... RETURNING.
 */
export interface TikTokConnectionToPersist {
  appKey: string;
  appSecret: string;
  accessToken: string;
  refreshToken: string;
  shopCipher: string;
}

export async function persistTikTokConnection(
  pool: Pool,
  tenantId: string,
  creds: TikTokConnectionToPersist,
  actorUserId?: string | null,
): Promise<void> {
  await withTenant(pool, tenantId, async (client) => {
    const [encryptedAppSecret, encryptedAccessToken, encryptedRefreshToken] = await Promise.all([
      encryptChannelSecret(client, creds.appSecret),
      encryptChannelSecret(client, creds.accessToken),
      encryptChannelSecret(client, creds.refreshToken),
    ]);

    const result = await client.query<{ id: string; is_new: boolean }>(
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
         updated_at = now()
       RETURNING id, (xmax = 0) AS is_new`,
      [tenantId, creds.shopCipher, creds.appKey, encryptedAppSecret, encryptedAccessToken, encryptedRefreshToken],
    );
    const { id, is_new: isNew } = result.rows[0]!;

    await recordAuditEvent(client, {
      tenantId,
      userId: actorUserId ?? null,
      action: isNew ? "channel_connection.connected" : "channel_connection.credentials_rotated",
      entityType: "channel_connection",
      entityId: id,
      details: { channel: "tiktok", marketplace: "", externalAccountId: creds.shopCipher },
    });
  });
}
