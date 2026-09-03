-- Warehouse/Fulfillment picklists (CLAUDE.md §1, §3: allocated -> picking ->
-- packed). A persisted, stateful entity rather than a derived view over
-- orders/order_lines -- picking has its own real-world lifecycle (open ->
-- assigned -> completed) independent of the orders it covers, needs to
-- survive and be reprintable/reassignable, and (per CLAUDE.md §2.2's
-- event-sourced-ledger philosophy) should be a first-class record, not
-- something reconstructed each time from other tables' current state.
--
-- One picklist is scoped to a single location. A picklist's location comes
-- from the inventory_events 'reservation' row order-service's allocateOrder()
-- already writes per order_line (idempotency_key
-- 'order-allocation:<order_id>:<order_line_id>') -- not a new, separately
-- mutable column on orders -- so there is exactly one source of truth for
-- "where was this line's stock reserved from."
CREATE TABLE picklists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  location_id UUID NOT NULL REFERENCES locations (id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'assigned', 'completed', 'cancelled')),
  -- Deliberately not REFERENCES users(id) with a FK-enforced NOT NULL --
  -- nullable until assigned. Note users' own RLS policy (migration 0010) is
  -- self-lookup-only (no tenant-scoped SELECT policy yet), so joining
  -- picklists.assigned_to back to users for e.g. "show me this picklist's
  -- assignee's name" won't resolve under RLS for anyone but that user
  -- themselves -- a known gap for a future picker-facing UI, not fixed here.
  assigned_to UUID REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_picklists_tenant_id ON picklists (tenant_id);
CREATE INDEX idx_picklists_status ON picklists (tenant_id, status);

ALTER TABLE picklists ENABLE ROW LEVEL SECURITY;
ALTER TABLE picklists FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_picklists ON picklists
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- No DELETE: like orders, a picklist is a workflow/audit record, not
-- something the app ever removes.
GRANT SELECT, INSERT, UPDATE ON picklists TO app_user;

-- One row per order_line pulled onto a picklist. quantity_picked/status
-- record the real-world pick outcome (short-picked or damaged items are a
-- fact to record, per CLAUDE.md §2.2, not a silent quantity fudge) --
-- packOrder() reads these to decide whether an inventory_events adjustment/
-- damage entry is needed before the covering order can move to 'packed'.
CREATE TABLE picklist_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  picklist_id UUID NOT NULL REFERENCES picklists (id) ON DELETE CASCADE,
  order_line_id UUID NOT NULL REFERENCES order_lines (id),
  product_id UUID NOT NULL REFERENCES products (id),
  quantity_requested INT NOT NULL CHECK (quantity_requested > 0),
  quantity_picked INT NOT NULL DEFAULT 0 CHECK (quantity_picked >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'picked', 'short', 'damaged')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (picklist_id, order_line_id)
);

CREATE INDEX idx_picklist_lines_tenant_id ON picklist_lines (tenant_id);
CREATE INDEX idx_picklist_lines_picklist_id ON picklist_lines (picklist_id);
CREATE INDEX idx_picklist_lines_order_line_id ON picklist_lines (order_line_id);

ALTER TABLE picklist_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE picklist_lines FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_picklist_lines ON picklist_lines
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON picklist_lines TO app_user;
