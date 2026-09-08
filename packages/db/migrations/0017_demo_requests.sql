-- Public "Book a Demo" lead capture (marketing site, /book-a-demo). Unlike
-- every other table in this schema, rows here are NOT tenant data -- they're
-- submitted by anonymous prospects who don't have a tenant_id (or even a
-- Clerk account) yet, so there's no app.tenant_id to scope by and no
-- withTenant() call wrapping the insert (see api/leads/demo-request/route.ts,
-- which calls pool.query() directly against app_user, same as any other
-- unauthenticated public endpoint like the Clerk/Stripe webhooks).
--
-- RLS is still enabled (defense-in-depth, CLAUDE.md §6), but deliberately
-- INSERT-only for app_user: no SELECT policy/grant exists, so nothing in the
-- app's own request-handling code can read leads back out, accidentally or
-- otherwise. Reading submitted leads is an operator task (query directly as
-- the DATABASE_URL owner role, which bypasses RLS) until/unless a real
-- admin UI is built for this -- not a v1 requirement.
CREATE TABLE demo_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  company TEXT,
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE demo_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY public_insert_demo_requests ON demo_requests
  FOR INSERT
  WITH CHECK (true);

GRANT INSERT ON demo_requests TO app_user;
