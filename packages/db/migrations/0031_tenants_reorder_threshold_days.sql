-- Adds the piece @alltix/inventory-service's own DEFAULT_REORDER_THRESHOLD_DAYS
-- doc comment already flagged as open: "not yet exposed as a real per-tenant
-- setting anywhere, that would be a genuine scope increase, not attempted
-- here." This is that setting -- how many days of estimated stock remaining
-- (assessStockForecast's own velocity-based forecast, CLAUDE.md §8 Phase 5's
-- "stock forecasting" line) counts as "reorder soon" for a given tenant,
-- shown on /inventory and /reports and editable from /inventory.
--
-- DEFAULT 14 is not arbitrary here -- it's the exact same value
-- DEFAULT_REORDER_THRESHOLD_DAYS already hardcoded, so a tenant who never
-- touches this setting sees IDENTICAL forecast behavior after this migration
-- as before it. Genuinely additive, no behavior change for any existing
-- tenant.
--
-- CHECK (1-365) mirrors the app-level validation in
-- packages/web/src/lib/reorder-threshold.ts (parseReorderThresholdDays) --
-- defense-in-depth, same "never rely on one layer alone" principle CLAUDE.md
-- §6 already applies to tenant isolation, applied here to input validation
-- instead. UPDATE was already GRANTed on tenants (migration 0010, for
-- Stripe's own webhook-driven subscription-status writes) -- no new GRANT
-- needed.
ALTER TABLE tenants
  ADD COLUMN reorder_threshold_days INT NOT NULL DEFAULT 14
    CHECK (reorder_threshold_days BETWEEN 1 AND 365);
