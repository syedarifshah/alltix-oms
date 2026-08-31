-- Deviation from the illustrative schema in CLAUDE.md §2.3: tenant_id is
-- denormalized onto order_lines (the sketch omits it), for the same RLS
-- correctness/performance reason as inventory_levels in 0006.
CREATE TABLE order_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  order_id UUID NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products (id),
  quantity INT NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(12, 2) NOT NULL,
  fulfillment_type TEXT NOT NULL CHECK (
    fulfillment_type IN ('seller_fulfilled', 'fba', 'wfs', '3pl')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_order_lines_tenant_id ON order_lines (tenant_id);
CREATE INDEX idx_order_lines_order_id ON order_lines (order_id);

ALTER TABLE order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_lines FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_order_lines ON order_lines
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON order_lines TO app_user;
