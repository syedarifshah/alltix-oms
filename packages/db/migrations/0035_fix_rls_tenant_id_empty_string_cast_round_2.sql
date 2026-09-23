-- Round 2 of the exact bug migration 0018 already fixed once: every table
-- created (or given a new tenant-scoped policy) AFTER 0018 shipped went
-- right back to the unguarded `current_setting('app.tenant_id',
-- true)::uuid` cast that 0018's own comment already diagnosed and warned
-- was "latent anywhere a future ... table reuses a connection that's
-- already been 'poisoned' this way" -- 0018 fixed every table that existed
-- at the time, but nothing enforces the guarded pattern on a *new* table's
-- migration, so five migrations since (0025, 0028 x2, 0030, 0033, 0034 x2)
-- all quietly reintroduced it.
--
-- Caught investigating `packages/web/test/tenant-isolation.e2e.test.ts`,
-- long logged in CLAUDE.md's own verification notes as a "known
-- pre-existing failure" and left at that across many passes -- it was
-- never pre-existing flakiness, it was this. Concretely: `withClerkUser()`
-- (packages/db/src/pool.ts) sets `app.clerk_user_id` but deliberately
-- leaves `app.tenant_id` unset, by design, for the pre-tenant-resolution
-- lookup of a signed-in user's own row. On a `pg.Pool` connection that
-- previously served an ordinary `withTenant()` request (i.e. almost any
-- connection, almost immediately), `app.tenant_id` reverts to `''` after
-- that transaction commits (0018's own comment covers why Postgres does
-- this for an undeclared custom GUC) rather than to NULL. Any policy on
-- `users` still doing the bare cast then throws `invalid input syntax for
-- type uuid: ""` on that connection's very next SELECT against `users` --
-- which is every sign-in, every request that resolves `tenantId` from a
-- Clerk session, hitting a poisoned connection. Not a test-only issue: the
-- exact same crash is live on `resolveTenantId()` (packages/web/src/lib/
-- with-tenant-auth.ts) in production, intermittently, whenever the
-- connection pool happens to hand back a previously-tenant-scoped
-- connection -- which, at any real request volume, is most of the time.
--
-- Also deduplicates `users`: migration 0030 already added
-- `tenant_scoped_select_users` for exactly the "list my org's teammates /
-- notify tenant users" need 0010's own comment predicted; migration 0034
-- added a second, functionally identical policy
-- (`tenant_scoped_read_users`) without noticing 0030 already covered it.
-- Postgres OR's multiple permissive policies together, so the duplicate
-- was harmless for correctness, but it's dead weight (two policies
-- evaluated, including twice hitting this same cast bug) for zero
-- additional access. Replaced with one.
--
-- Fix: NULLIF(current_setting('app.tenant_id', true), '') before the
-- ::uuid cast, same as 0018, so a poisoned `''` becomes a real SQL NULL
-- (which casts to NULL, not an error) instead of crashing the query --
-- restores the exact behavior every caller already assumed the cast had.
--
-- Expand-only per CLAUDE.md §9: DROP + CREATE POLICY only, no table/column
-- change, no app code change required, safe to apply without a deploy
-- coordination window.

DROP POLICY tenant_isolation_early_channel_cancellations ON early_channel_cancellations;
CREATE POLICY tenant_isolation_early_channel_cancellations ON early_channel_cancellations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY tenant_isolation_employees ON employees;
CREATE POLICY tenant_isolation_employees ON employees
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY tenant_isolation_time_entries ON time_entries;
CREATE POLICY tenant_isolation_time_entries ON time_entries
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY tenant_isolation_api_rate_limit_windows ON api_rate_limit_windows;
CREATE POLICY tenant_isolation_api_rate_limit_windows ON api_rate_limit_windows
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY tenant_isolation_audit_log ON audit_log;
CREATE POLICY tenant_isolation_audit_log ON audit_log
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- users: replace BOTH duplicate policies with one guarded one, named after
-- 0030's original (the one 0034 should have found and reused).
DROP POLICY tenant_scoped_select_users ON users;
DROP POLICY tenant_scoped_read_users ON users;
CREATE POLICY tenant_scoped_select_users ON users
  FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
