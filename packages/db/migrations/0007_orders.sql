-- status is CHECK-constrained (unlike channel_listings.channel) because the
-- order lifecycle state machine in CLAUDE.md §3 is a locked design decision,
-- not an open-ended list like marketplace names.
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  channel TEXT NOT NULL,
  external_order_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (
    status IN (
      'received', 'validated', 'on_hold', 'allocated', 'backordered',
      'picking', 'packed', 'shipped', 'delivered',
      'returned', 'refunded', 'cancelled'
    )
  ),
  customer JSONB,
  shipping_address JSONB,
  placed_at TIMESTAMPTZ,
  raw_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, channel, external_order_id)
);

CREATE INDEX idx_orders_tenant_id ON orders (tenant_id);
CREATE INDEX idx_orders_status ON orders (tenant_id, status);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_orders ON orders
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON orders TO app_user;
