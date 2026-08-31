-- Deviation from the illustrative schema in CLAUDE.md §2.2: tenant_id is
-- denormalized onto this table even though the sketch's PK is
-- (product_id, location_id) only. §2.4 states every table carries tenant_id
-- for RLS; without it here, policies would need a subquery into products,
-- which is slower and a well-known source of RLS correctness gotchas.
CREATE TABLE inventory_levels (
  tenant_id UUID NOT NULL,
  product_id UUID NOT NULL REFERENCES products (id),
  location_id UUID NOT NULL REFERENCES locations (id),
  on_hand INT NOT NULL DEFAULT 0,
  reserved INT NOT NULL DEFAULT 0,
  available INT GENERATED ALWAYS AS (on_hand - reserved) STORED,
  channel_buffer JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, location_id)
);

CREATE INDEX idx_inventory_levels_tenant_id ON inventory_levels (tenant_id);

ALTER TABLE inventory_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_levels FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_inventory_levels ON inventory_levels
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- No DELETE: rows are derived from inventory_events and updated in place,
-- never removed independently of that ledger.
GRANT SELECT, INSERT, UPDATE ON inventory_levels TO app_user;
