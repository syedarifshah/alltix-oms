-- Deviation from the illustrative schema in CLAUDE.md §2.1: internal_sku is
-- scoped UNIQUE per tenant, not globally. A global unique constraint would
-- both be operationally wrong (two unrelated sellers may legitimately reuse
-- the same SKU string) and would leak cross-tenant existence information via
-- constraint-violation errors, which violates the tenant isolation goal in §2.4.
CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  internal_sku TEXT NOT NULL,
  name TEXT NOT NULL,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, internal_sku)
);

CREATE INDEX idx_products_tenant_id ON products (tenant_id);

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_products ON products
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON products TO app_user;
