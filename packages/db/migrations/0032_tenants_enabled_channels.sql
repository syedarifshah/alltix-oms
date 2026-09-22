-- Adds the piece CLAUDE.md §9's DevOps table already flagged as future
-- work: "Feature flags ... for gradually rolling out new channel
-- connectors per tenant." This is a lightweight, in-house version of that
-- -- a plain TEXT[] column, not a LaunchDarkly (or similar) integration --
-- same "don't stand up infra a single self-testing tenant hasn't earned
-- yet" call this codebase already makes for BullMQ/Redis (§4.4) and Kafka
-- (§1). See packages/web/src/lib/channel-flags.ts for the app-level
-- reasoning and the new "## 15. Channel Feature Flags" section in
-- CLAUDE.md for the full design.
--
-- DEFAULT is every channel this codebase has a connector for -- so a
-- tenant who's never had this touched sees IDENTICAL behavior after this
-- migration as before it (every "Connect X" button still renders).
-- Genuinely additive, same "zero behavior change until a tenant is
-- explicitly opted out" discipline migration 0031 already used for
-- reorder_threshold_days.
--
-- CHECK (<@, "is contained by") mirrors the app-level ALL_CHANNELS list in
-- channel-flags.ts -- defense-in-depth, same "never rely on one layer
-- alone" principle CLAUDE.md §6 already applies to tenant isolation,
-- applied here to input validation instead (same reasoning migration
-- 0031's own CHECK gives). UPDATE was already GRANTed on tenants
-- (migration 0010, for Stripe's own webhook-driven subscription-status
-- writes) -- no new GRANT needed.
ALTER TABLE tenants
  ADD COLUMN enabled_channels TEXT[] NOT NULL
    DEFAULT ARRAY['amazon', 'shopify', 'walmart', 'ebay', 'temu', 'tiktok']
  CHECK (enabled_channels <@ ARRAY['amazon', 'shopify', 'walmart', 'ebay', 'temu', 'tiktok']);
