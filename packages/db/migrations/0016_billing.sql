-- Billing/Subscription module (CLAUDE.md §1, §5 Stripe Billing). Expand-only,
-- backward-compatible (CLAUDE.md §9): every new column is nullable, no
-- backfill needed -- a tenant with no Stripe activity yet simply has nulls
-- here until it visits /settings/billing for the first time.

-- stripe_customer_id: set on first Stripe Customer creation (idempotent --
-- looked up before creating a new one, see @alltix/billing-service).
-- stripe_subscription_id / subscription_status / subscription_current_period_end:
-- written ONLY from verified webhook events (checkout.session.completed,
-- customer.subscription.updated/.deleted, invoice.payment_failed), never
-- from anything the UI/checkout redirect itself claims -- Stripe's webhook
-- is the source of truth per this task's own requirement, the same
-- "never trust the client, trust the verified event" principle CLAUDE.md
-- §6 already states for Amazon SNS/Shopify HMAC.
--
-- subscription_status deliberately has NO CHECK constraint, unlike
-- orders.status (migration 0007): that state machine is this app's own
-- locked design; Stripe's Subscription.status enum is Stripe's to extend,
-- not ours to gatekeep -- same reasoning migration 0004's header comment
-- gives for leaving channel_listings.channel unconstrained. Stored exactly
-- as Stripe reports it (e.g. 'trialing', 'active', 'past_due', 'canceled',
-- 'unpaid', 'incomplete', 'incomplete_expired', 'paused').
ALTER TABLE tenants ADD COLUMN stripe_customer_id TEXT UNIQUE;
ALTER TABLE tenants ADD COLUMN stripe_subscription_id TEXT UNIQUE;
ALTER TABLE tenants ADD COLUMN subscription_status TEXT;
ALTER TABLE tenants ADD COLUMN subscription_current_period_end TIMESTAMPTZ;

-- A Stripe webhook event identifies a tenant only by its `customer` id --
-- tenant_id isn't known yet at that point, the same chicken-and-egg problem
-- migration 0010's self_lookup_users policy solves for Clerk user ids.
-- Second permissive policy on the same table (combined with OR, same as
-- Postgres does for any two permissive policies on one command) -- doesn't
-- touch or weaken tenant_isolation_tenants above. Scoped by
-- app.stripe_customer_id (set via withStripeCustomer(), packages/db/src/pool.ts),
-- never app.tenant_id, so this can never be (mis)used as a general-purpose
-- tenant lookup.
CREATE POLICY stripe_customer_self_lookup_tenants ON tenants
  USING (stripe_customer_id = current_setting('app.stripe_customer_id', true))
  WITH CHECK (stripe_customer_id = current_setting('app.stripe_customer_id', true));

-- Basic usage counters (CLAUDE.md §1 Billing: "usage metering (orders
-- processed, SKUs, users)") -- deliberately not wired into Stripe's
-- metered-billing API yet (that's a v2 concern once real tiers exist); this
-- is only what /settings/billing displays against a flat plan limit.
--
-- orders_processed is a real, incremented-on-insert counter (written
-- atomically alongside the order insert itself in
-- OrderService.persistPulledOrders(), same transaction -- see that file),
-- not a derived COUNT(*) query, because it's meant to become the seed of a
-- real Stripe usage-record report later, which is itself event-driven
-- ("report N units as of now"), not a point-in-time query.
--
-- SKU/product count is NOT stored here on purpose -- current SKU count is
-- exactly `count(*) from products`, already indexed on tenant_id (migration
-- 0003), always accurate, and unlike orders a product can be deleted, so a
-- separately-maintained counter would need decrement logic too and could
-- drift; a live COUNT(*) has no such risk and this table isn't the place
-- for redundant state that has to be kept in sync by hand.
--
-- month is 'YYYY-MM' (UTC) -- the row resets itself (see the UPSERT in
-- persistPulledOrders()) rather than needing a separate cron job to zero
-- counters at month boundaries.
--
-- tenant_id deliberately has NO REFERENCES tenants(id) -- matching every
-- other tenant-scoped table in this schema (products, locations, orders,
-- etc. -- checked, none of them FK to tenants either). RLS is what
-- actually enforces isolation here, not a hard FK; `users` is the one
-- exception, FK'd because provisionTenantForNewUser() creates both rows in
-- the same transaction. Several existing order-service tests deliberately
-- use a synthetic tenantId with no backing tenants row (confirmed live: an
-- earlier version of this migration with the FK broke
-- persist-and-allocate.test.ts and allocation-concurrency.test.ts) -- this
-- table must not be the first tenant-scoped table to demand a real
-- tenants row exist.
CREATE TABLE tenant_usage (
  tenant_id UUID PRIMARY KEY,
  month TEXT NOT NULL,
  orders_processed INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE tenant_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_usage FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_tenant_usage ON tenant_usage
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON tenant_usage TO app_user;
