-- `channel` is left as free text rather than a CHECK-constrained enum:
-- the roadmap (CLAUDE.md §8, Phase 5) adds eBay/TikTok Shop later, and a new
-- channel is purely a connector-layer addition (§4) that should not require
-- a schema migration just to record its name.
CREATE TABLE channel_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  product_id UUID NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  channel_marketplace TEXT NOT NULL,
  external_id TEXT,
  external_sku TEXT,
  listing_status TEXT NOT NULL DEFAULT 'draft',
  last_synced_at TIMESTAMPTZ,
  raw_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, channel, channel_marketplace, external_id)
);

CREATE INDEX idx_channel_listings_tenant_id ON channel_listings (tenant_id);
CREATE INDEX idx_channel_listings_product_id ON channel_listings (product_id);

ALTER TABLE channel_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_listings FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_channel_listings ON channel_listings
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON channel_listings TO app_user;
