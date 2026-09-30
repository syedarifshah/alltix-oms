-- Round 3 of the exact bug migrations 0018 and 0035 already fixed twice:
-- migration 0038 (payroll_connections, CLAUDE.md §14.1) went right back to
-- the unguarded `current_setting('app.tenant_id', true)::uuid` cast that
-- both 0018 and 0035 already diagnosed and warned would keep recurring on
-- any future table whose own migration doesn't crib the guarded form
-- directly -- 0035's own closing line said exactly this: "a future new
-- tenant-scoped table's migration should crib the guarded-cast form
-- directly from this section or from 0018/0035, not from an older
-- migration that might itself predate 0018." 0038 was written around the
-- same time as 0035 (both touch tenant-scoped RLS) but independently, and
-- neither noticed the other -- 0038 copied the bare-cast shape from an
-- older migration instead.
--
-- Not caught by 0035's own sweep because 0038 didn't exist yet at 0035's
-- audit time; not caught by any later migration because every one of them
-- (0039 onward) got the guarded form right from the start, so nothing
-- since flagged this one as still open. Found instead by a fresh, direct
-- audit of every migration file for a bare `current_setting('app.tenant_id'`
-- cast with no `NULLIF` guard -- the same audit technique CLAUDE.md's own
-- §16/§17 "grep for the instrumentation marker, then read each unmatched
-- file" passes already used for rate-limiting and audit-log coverage gaps,
-- applied here to this specific recurring bug class instead.
--
-- Concretely, the same crash 0018's/0035's own comments both describe:
-- `payroll_connections` is queried by `/settings/payroll` (every visit,
-- even before a tenant has connected Check) and by `packages/payroll-service`'s
-- own `connectPayrollProcessor()`/`createCheckCompanyForTenant()` calls --
-- both ordinary `withTenant()`-scoped requests. On a pooled connection that
-- previously served a Clerk-session lookup (`withClerkUser()`, which
-- deliberately leaves `app.tenant_id` unset) or simply reverted to `''`
-- after an earlier `withTenant()` transaction committed (0018's own comment
-- covers why Postgres does this for an undeclared custom GUC), the bare
-- cast throws `invalid input syntax for type uuid: ""` -- a real,
-- intermittent 500 on `/settings/payroll`, not a permission-denied.
--
-- Fix: identical to 0018/0035 -- NULLIF(current_setting('app.tenant_id',
-- true), '') before the ::uuid cast, so a poisoned '' becomes a real SQL
-- NULL (casts to NULL, not an error) instead of crashing the query.
--
-- Expand-only per CLAUDE.md §9: DROP + CREATE POLICY only, no table/column
-- change, no app code change required, safe to apply without a deploy
-- coordination window.

DROP POLICY tenant_isolation_payroll_connections ON payroll_connections;
CREATE POLICY tenant_isolation_payroll_connections ON payroll_connections
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
