-- CLAUDE.md §6 flags this too: "architect logging/access-control from day
-- one -- retrofitting audit trails later is expensive." Until now the only
-- audit trail in this schema was inventory_events (§2.2) -- who cancelled
-- an order, created or toggled an automation rule, or changed a tenant
-- setting was tracked nowhere. This is that general-purpose trail,
-- deliberately generic (action/entity_type/entity_id/details) rather than a
-- dedicated table per mutation type, the same "one canonical shape, not a
-- growing family of near-identical tables" call time_entries' own
-- entry_source column already made (migration 0028).
--
-- Append-only by design: GRANT below covers SELECT and INSERT only, no
-- UPDATE/DELETE -- an audit trail the app itself can quietly edit or erase
-- isn't much of one. Same spirit as inventory_events, which nothing in this
-- codebase ever UPDATEs or DELETEs either, just never enforced at the GRANT
-- layer there since it predates this table.
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  -- Nullable: most rows have a real signed-in actor, but an
  -- operator-run script (e.g. scripts/set-channel-flags.ts) has no Clerk
  -- session to attribute the change to -- NULL means "the platform
  -- operator, outside the app" rather than inventing a fake system user
  -- row just to satisfy a NOT NULL constraint.
  user_id UUID REFERENCES users (id),
  -- Free TEXT, dot-namespaced by domain (e.g. 'rule.created',
  -- 'settings.reorder_threshold_changed') -- same "this app's own
  -- vocabulary keeps growing" reasoning employees.role and
  -- api_rate_limit_windows.route_key already gave (migrations 0028, 0033),
  -- not a fixed enum a new audited action would need a migration to extend.
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  -- Nullable: not every audited action has one addressable row (a
  -- tenant-wide settings change like the channel-flags script has no
  -- single entity_id to point at).
  entity_id UUID,
  -- Whatever the action-specific caller wants to record (old/new values,
  -- form input, etc.) -- deliberately not a structured before/after pair:
  -- capturing a true before-image would mean every instrumented route
  -- re-reading the row before its own UPDATE, which none of them need for
  -- their actual logic today. A stronger before/after guarantee is real,
  -- separate future work if this log's usage ever demands it.
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_log_tenant_created ON audit_log (tenant_id, created_at DESC);
CREATE INDEX idx_audit_log_tenant_entity ON audit_log (tenant_id, entity_type, entity_id);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_audit_log ON audit_log
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT ON audit_log TO app_user;

-- Migration 0010's own users table doc comment already flagged this exact
-- need and named the fix: "A future 'list my org's teammates' feature
-- needs an additional policy branch scoped by app.tenant_id -- don't widen
-- [self_lookup_users] to double as that; add a second policy." This is
-- that second policy -- /settings/activity (this migration's own new page)
-- needs to resolve OTHER users' emails within the same tenant to show who
-- did what, which self_lookup_users alone can never do (it only ever
-- matches the CURRENT request's own clerk_user_id, and withTenant-scoped
-- queries don't even set app.clerk_user_id -- see that function's own doc
-- comment in packages/db/src/pool.ts). Postgres combines multiple
-- permissive policies for the same command with OR, so this is purely
-- additive: self_lookup_users keeps working unchanged for every existing
-- caller. SELECT only -- INSERT stays exclusively self_lookup_users' own
-- job (a user's own row is still only ever created via that path).
CREATE POLICY tenant_scoped_read_users ON users
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
