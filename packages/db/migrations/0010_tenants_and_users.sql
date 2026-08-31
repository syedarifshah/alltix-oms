-- Root of tenancy. Unlike every other table, rows here aren't scoped by a
-- tenant_id column pointing elsewhere -- a tenant row IS the tenant boundary,
-- so its own id plays that role. RLS is still enabled: without it, a query
-- that forgot a WHERE clause would return every tenant on the platform
-- instead of just the caller's.
CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_tenants ON tenants
  USING (id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, UPDATE ON tenants TO app_user;

-- Maps a Clerk identity to the tenant it belongs to. This is the one
-- deliberate exception to "always scope by app.tenant_id": a request's
-- tenant_id isn't known yet when it first arrives -- that's what this table
-- resolves -- so its policy scopes by app.clerk_user_id instead, set via the
-- same SET LOCAL / set_config('app.clerk_user_id', ..., true) mechanism used
-- for app.tenant_id (see packages/db/src/pool.ts withClerkUser/withTenant).
-- Once tenant_id has been resolved from this table, every further query in
-- the request goes through withTenant() and is scoped normally.
--
-- Only a self-lookup policy exists today (a user reading/inserting their own
-- row by clerk_user_id). A future "list my org's teammates" feature needs an
-- additional policy branch scoped by app.tenant_id -- don't widen this one
-- to double as that; add a second policy so the self-lookup path (which runs
-- before tenant_id is known) keeps working even if the tenant-scoped one is
-- ever tightened or removed.
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id),
  clerk_user_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_tenant_id ON users (tenant_id);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

CREATE POLICY self_lookup_users ON users
  USING (clerk_user_id = current_setting('app.clerk_user_id', true))
  WITH CHECK (clerk_user_id = current_setting('app.clerk_user_id', true));

GRANT SELECT, INSERT ON users TO app_user;
