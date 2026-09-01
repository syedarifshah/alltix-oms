-- Per-tenant marketplace OAuth credentials -- deliberately a separate table
-- from channel_listings (0004), which stays scoped to per-SKU listing data
-- (external_id/external_sku/listing_status). This table is the credential
-- store a connector adapter (CLAUDE.md §4.3, e.g.
-- packages/channel-connectors/src/amazon-connector.ts) authenticates with;
-- channel_listings never carries a secret and channel_connections never
-- carries a SKU.
--
-- Encryption: CLAUDE.md §6 calls for KMS-backed encryption of marketplace
-- API tokens at rest. No KMS integration exists anywhere in this repo yet,
-- so encrypted_client_secret / encrypted_refresh_token use pgcrypto's
-- pgp_sym_encrypt/pgp_sym_decrypt (extension already enabled in 0001) as the
-- interim mechanism -- see packages/db/src/encryption.ts, which binds the
-- symmetric key as a query parameter (never string-interpolated into SQL)
-- from CHANNEL_CREDENTIALS_ENCRYPTION_KEY. Swapping that key's source for a
-- real KMS-fetched data key later doesn't require a schema change.
--
-- access_token is stored as plaintext TEXT, not encrypted: it's short-lived
-- (LWA access tokens expire in ~1hr, refreshed automatically -- see
-- amazon-connector.ts) and gets overwritten on every refresh, unlike
-- client_secret/refresh_token which are long-lived, high-value credentials.
CREATE TABLE channel_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  channel TEXT NOT NULL,
  marketplace TEXT NOT NULL,
  external_account_id TEXT NOT NULL,  -- seller id / merchant id, channel-specific
  lwa_client_id TEXT NOT NULL,
  encrypted_client_secret BYTEA NOT NULL,
  encrypted_refresh_token BYTEA NOT NULL,
  access_token TEXT,
  token_expires_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disconnected', 'error')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, channel, marketplace, external_account_id)
);

CREATE INDEX idx_channel_connections_tenant_id ON channel_connections (tenant_id);

ALTER TABLE channel_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_connections FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_channel_connections ON channel_connections
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON channel_connections TO app_user;
