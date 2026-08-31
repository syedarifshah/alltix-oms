-- The stock ledger (CLAUDE.md §2.2). This table is append-only: app_user is
-- granted SELECT/INSERT only, never UPDATE/DELETE, so "never let a channel
-- adapter write directly to inventory_levels" is enforced at the grant level,
-- not just by convention.
CREATE TABLE inventory_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  product_id UUID NOT NULL REFERENCES products (id),
  location_id UUID NOT NULL REFERENCES locations (id),
  event_type TEXT NOT NULL CHECK (
    event_type IN ('receipt', 'sale', 'reservation', 'release', 'adjustment', 'damage', 'transfer')
  ),
  quantity_delta INT NOT NULL,
  reference_type TEXT CHECK (reference_type IN ('order', 'po', 'manual', 'return')),
  reference_id UUID,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_inventory_events_tenant_id ON inventory_events (tenant_id);
CREATE INDEX idx_inventory_events_product_location ON inventory_events (product_id, location_id);
CREATE INDEX idx_inventory_events_reference ON inventory_events (reference_type, reference_id);

ALTER TABLE inventory_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_inventory_events ON inventory_events
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT ON inventory_events TO app_user;
