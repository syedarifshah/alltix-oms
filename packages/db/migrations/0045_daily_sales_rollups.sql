-- CLAUDE.md §8 Phase 4's own reporting section named a concrete, agreed
-- revisit trigger for the deferred "real CDC-fed read-optimized store":
-- "(a) a real tenant's /reports page becomes visibly/measurably slow, or
-- (b) any tenant's monthly order volume crosses roughly 10,000-20,000
-- orders/month." With real contracts now in place and 30,000+ orders/week
-- expected (~130,000/month), trigger (b) has fired.
--
-- What this migration does NOT do: stand up Debezium + ClickHouse/BigQuery.
-- That needs real vendor accounts, billing, and a new deployment surface --
-- none of which this session can provision (no cloud credentials for any
-- external warehouse exist anywhere in this codebase, the same "wired but
-- unverified" gap every other external integration starts from, except
-- there is no code-only way to "wire" a database that doesn't exist yet).
-- Building that now, sight-unseen, would be exactly the "standing up infra
-- nobody's earned yet" mistake this codebase has deliberately avoided for
-- BullMQ/Redis (§4.4), Kafka (§1), and a real feature-flag vendor (§15) --
-- except here the infra genuinely IS earned by the trigger firing, so the
-- honest move is a real, deployable-today improvement using what's already
-- in place (Postgres, the existing daily-cron mechanism), not silence.
--
-- What this migration DOES: daily rollup tables for the two queries on
-- /reports that actually scan `orders`/`order_lines` per-row for the
-- selected period (sales-by-channel, top-SKUs-by-revenue) -- the ones whose
-- cost grows with order volume, unlike the inventory-snapshot/trouble-spot
-- queries, which scan `inventory_levels` (one row per product/location,
-- not per order) and aren't touched by this migration. A tenant's report
-- query for "last 90 days" now sums at most 90 * (channel count) rollup
-- rows instead of scanning every order_line placed in that window --
-- the same "precompute the roll-up, don't recompute it from raw rows on
-- every read" idea CLAUDE.md's own inventory_levels table already applies
-- to inventory_events, just for sales reporting instead of stock levels.
--
-- This is a real, if smaller, step toward "read-optimized" -- these tables
-- are written by a daily job, not on every order, so a report read never
-- contends with the transactional path at all, which is the actual thing
-- CLAUDE.md's Reporting/Analytics module description cares about. It does
-- NOT get a separate columnar engine or a separate physical database --
-- that remains the real, larger piece of work, with its own new revisit
-- trigger recorded in CLAUDE.md rather than left as a vague "later."
CREATE TABLE daily_channel_sales_rollups (
  tenant_id UUID NOT NULL,
  -- UTC calendar date derived from orders.placed_at, matching every other
  -- UTC-anchored daily concept in this schema (inventory partition
  -- boundaries, migration 0044).
  sale_date DATE NOT NULL,
  channel TEXT NOT NULL,
  order_count INT NOT NULL DEFAULT 0 CHECK (order_count >= 0),
  units_sold INT NOT NULL DEFAULT 0 CHECK (units_sold >= 0),
  -- Gross order-line revenue, non-cancelled orders only -- the identical
  -- "gross, not net of returns" definition /reports' own doc comment
  -- already documents for its live query; a return's restock stays a
  -- separate, visible figure, never netted back into this column.
  revenue NUMERIC(14, 2) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, sale_date, channel)
);

CREATE TABLE daily_product_sales_rollups (
  tenant_id UUID NOT NULL,
  sale_date DATE NOT NULL,
  product_id UUID NOT NULL,
  units_sold INT NOT NULL DEFAULT 0 CHECK (units_sold >= 0),
  revenue NUMERIC(14, 2) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, sale_date, product_id)
);
-- No FK to products: a product can be referenced by historical order_lines
-- after... this schema never deletes products, so this is a defensive
-- choice consistent with inventory_events' own product_id FK, not a real
-- gap -- kept FK-free here only to keep the nightly rollup job's own
-- upsert simple against a table that is, by design, fully recomputable
-- from orders/order_lines at any time (see packages/scheduler's own
-- rollupDailySales doc comment).

ALTER TABLE daily_channel_sales_rollups ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_channel_sales_rollups FORCE ROW LEVEL SECURITY;
-- Guarded NULLIF(...) cast from the start -- CLAUDE.md §18's own closing
-- instruction, crib this directly from 0018/0035 on a brand-new table
-- rather than reproducing that bug class a third time.
CREATE POLICY tenant_isolation_daily_channel_sales_rollups ON daily_channel_sales_rollups
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT ON daily_channel_sales_rollups TO app_user;
-- No INSERT/UPDATE grant for app_user -- only the nightly cron job (via
-- adminPool, the schema-owning role, same reasoning migration 0044's own
-- partition-maintenance DDL and every other admin-only write in this
-- codebase already uses) ever writes to these tables. A tenant's own
-- session can read its own rollups (RLS-scoped) but can never write or
-- corrupt one, even via a bug elsewhere in the app.

ALTER TABLE daily_product_sales_rollups ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_product_sales_rollups FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_daily_product_sales_rollups ON daily_product_sales_rollups
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT ON daily_product_sales_rollups TO app_user;

-- Both tables also need INSERT/UPDATE for the schema-owning admin role
-- specifically (not app_user) -- the role migrations themselves run as
-- already has this implicitly as the table owner, so no extra GRANT is
-- needed for that role; this comment exists only so a future reader
-- doesn't mistake the missing app_user INSERT/UPDATE grant above for an
-- oversight.

CREATE INDEX idx_daily_channel_sales_rollups_tenant_date
  ON daily_channel_sales_rollups (tenant_id, sale_date);
CREATE INDEX idx_daily_product_sales_rollups_tenant_date
  ON daily_product_sales_rollups (tenant_id, sale_date);
