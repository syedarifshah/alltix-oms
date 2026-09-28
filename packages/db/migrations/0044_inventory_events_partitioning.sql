-- Monthly range partitioning for `inventory_events` (CLAUDE.md §2.2, "the
-- most important table in the system"). CLAUDE.md's own "Retrofit risk at
-- the top of the target range" paragraph named this as the likely approach
-- "when it's needed" -- it's needed now: AlltixOMS has real contracts with
-- a few large companies and expects 30,000+ orders/week, well past the
-- ~50,000 orders/month threshold that paragraph itself named as the point
-- where an unpartitioned ledger becomes the same "expensive to retrofit
-- later" category as RLS (§11 item 6). Doing this now, while the table is
-- still comparatively small, is materially cheaper and safer than
-- retrofitting it onto an already-grown, already-live production table --
-- the exact lesson this codebase already learned twice from the RLS bug in
-- §18.
--
-- ============================================================================
-- THE HARD PART: idempotency_key's UNIQUE constraint cannot survive
-- partitioning as-is, and weakening it silently would be a real bug, not a
-- cosmetic one.
-- ============================================================================
--
-- Postgres requires every unique constraint (including a PRIMARY KEY) on a
-- partitioned table to include all of the partition key's own columns --
-- documented Postgres behavior, not a limitation specific to this schema
-- ("the partition structure itself must guarantee there are no duplicates
-- in different partitions," since each partition's own index can only
-- enforce uniqueness within that one partition). Two consequences:
--
--   1. `id UUID PRIMARY KEY` becomes `PRIMARY KEY (id, created_at)` --
--      harmless; nothing in this codebase looks up an inventory_events row
--      by `id` alone in a way that cares about the PK's own column list.
--
--   2. `idempotency_key TEXT UNIQUE` cannot become
--      `UNIQUE (idempotency_key, created_at)` and still mean what it meant
--      before. `idempotency_key` has no natural relationship to which
--      calendar month the resulting event lands in (`order-sale:<orderId>:
--      <orderLineId>`, `pack-shortfall:<orderId>:<lineId>`, etc. -- see
--      every real caller in packages/inventory-service, packages/order-
--      service, packages/warehouse-service) -- a redelivered/retried write
--      for the SAME logical event, arriving in a DIFFERENT calendar month
--      than the original (a redelivery hours, days, or -- per CLAUDE.md
--      §4.4's own "both Amazon and Walmart will redeliver" -- even longer
--      after the fact), would get a DIFFERENT `created_at`, and a
--      constraint scoped to `(idempotency_key, created_at)` would let it
--      through as if it were a new event. That's exactly the double-
--      application bug CLAUDE.md §4.4 promises can't happen ("handlers must
--      be safe to run twice") and exactly what this column exists to
--      prevent (§2.2's own comment: "prevents double-processing on
--      retries/redelivery"). Silently weakening this constraint to make
--      partitioning easier would be a real, dangerous correctness
--      regression in the one table this schema calls out by name as making
--      "oversell bugs debuggable instead of mysterious" -- not acceptable
--      here.
--
-- Fix: TRUE, table-wide uniqueness moves to a small, deliberately NOT
-- partitioned sidecar table, `inventory_event_idempotency_keys`, whose own
-- `PRIMARY KEY (idempotency_key)` is the one place this is still enforced
-- globally, independent of which partition the real event row ends up in.
-- Every write path claims a key here FIRST, in the same transaction as the
-- real `inventory_events` insert -- see
-- packages/db/src/inventory-event-idempotency.ts for the two claim
-- functions (`claimInventoryEventIdempotencyKey` /
-- `claimInventoryEventIdempotencyKeyOrThrow`) that replace every direct
-- `ON CONFLICT (idempotency_key)` / unguarded-unique-constraint reliance
-- this table's real callers used to have, preserving each call site's
-- EXACT prior behavior (silent no-op vs. a thrown error on a genuine
-- duplicate) rather than inventing one new uniform behavior.
--
-- ============================================================================
-- Partition maintenance: a DEFAULT partition as a safety net, a real
-- ongoing job as the actual mechanism.
-- ============================================================================
--
-- This migration pre-creates one partition per calendar month from the
-- table's own earliest existing row (or the current month, for a database
-- with none yet) through 3 months past the current month, plus a DEFAULT
-- partition that accepts anything outside that range rather than rejecting
-- an insert outright. The DEFAULT partition is a backstop, not the intended
-- steady state -- packages/scheduler's new `ensureInventoryEventPartitions`
-- (run daily via `GET /api/cron/inventory-partition-maintenance`, see that
-- route's own doc comment) keeps a real monthly partition ready 3 months
-- ahead on an ongoing basis, so in normal operation nothing should ever
-- actually land in DEFAULT -- if it does, that's a signal the maintenance
-- job itself has been down for a while, worth investigating, not itself a
-- correctness problem (data landing in DEFAULT is still fully correct and
-- queryable, it just doesn't get this feature's own partition-pruning
-- benefit until moved into a real monthly partition by hand later).
--
-- Assumes PostgreSQL 12+ (foreign keys directly on a partitioned parent
-- table, applied automatically to every partition, were a PG12 addition;
-- this codebase's own use of generated STORED columns and pgcrypto already
-- implies a reasonably modern Postgres).
--
-- Migration mechanics: converting an existing plain table into a
-- partitioned one is not a single ALTER TABLE in Postgres -- this creates a
-- fresh partitioned table under the OLD table's name (after renaming the
-- old table out of the way first, so the clean, expected name/index names
-- are free for the new table to reuse -- no `_partitioned`-suffixed
-- temporary name/final rename needed), copies every existing row across in
-- one INSERT ... SELECT, and keeps the original table around, renamed and
-- archived, rather than dropping it -- the same "the ledger should show
-- why" caution CLAUDE.md §3 applies to order cancellation, applied here to
-- "why does the schema look different now": if anything about this
-- migration turns out wrong, the original table is still there to compare
-- against, and dropping it is a deliberate, separate follow-up once this
-- has run cleanly in production for a while, not bundled into this change.
--
-- This migration runs inside the single transaction packages/db/src/
-- migrate.ts already wraps every migration file in. For this table's real
-- current row count (one recently-scaled tenant, not yet a large historical
-- backlog) the one-shot INSERT ... SELECT below completes quickly; a much
-- larger historical backlog would need a batched/background backfill
-- instead of a single statement -- flagged here, not built, since it isn't
-- what this table's real size calls for today.

-- ----------------------------------------------------------------------------
-- 1. Sidecar table for TRUE, table-wide idempotency_key uniqueness.
-- ----------------------------------------------------------------------------

CREATE TABLE inventory_event_idempotency_keys (
  idempotency_key TEXT PRIMARY KEY,
  inventory_event_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE inventory_event_idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_event_idempotency_keys FORCE ROW LEVEL SECURITY;

-- No tenant_id column: the UNIQUE constraint this table replaces
-- (inventory_events.idempotency_key, migration 0005) was never scoped by
-- tenant either -- this preserves that exact scope, table-wide, not a new
-- per-tenant behavior. RLS stays ON anyway (USING (true)/WITH CHECK (true))
-- -- same "defense-in-depth even for a table with no tenant_id to scope by"
-- precedent carrier_surcharges (migration 0039) and demo_requests
-- (migration 0017) already established.
CREATE POLICY allow_all_inventory_event_idempotency_keys ON inventory_event_idempotency_keys
  USING (true) WITH CHECK (true);

-- Append-only in practice (nothing in this codebase ever UPDATEs/DELETEs a
-- claimed key), same GRANT shape as inventory_events itself always had.
GRANT SELECT, INSERT ON inventory_event_idempotency_keys TO app_user;

-- Backfill from every idempotency_key already in use, BEFORE the old table
-- is touched below -- a genuinely new event minted right after cutover must
-- never be able to collide with an old, already-used key this table
-- doesn't know about yet.
INSERT INTO inventory_event_idempotency_keys (idempotency_key, inventory_event_id, created_at)
  SELECT idempotency_key, id, created_at FROM inventory_events;

-- ----------------------------------------------------------------------------
-- 2. Move the original table out of the way, freeing its name (and its
--    schema-wide-unique index names) for the new partitioned table to
--    reuse directly -- no temporary name, no final rename needed.
-- ----------------------------------------------------------------------------

ALTER TABLE inventory_events RENAME TO inventory_events_pre_partition_20260928;

-- Table RENAME does not rename a table's own indexes or constraints, and
-- index names (unlike plain CHECK constraint names) are unique per SCHEMA,
-- not per table -- these three explicitly-named indexes, and the PK/UNIQUE
-- constraints' own backing indexes, would otherwise collide with the new
-- table's identically-named ones below.
ALTER INDEX idx_inventory_events_tenant_id RENAME TO idx_inventory_events_tenant_id_pre_partition;
ALTER INDEX idx_inventory_events_product_location RENAME TO idx_inventory_events_product_location_pre_partition;
ALTER INDEX idx_inventory_events_reference RENAME TO idx_inventory_events_reference_pre_partition;
-- Renaming a PK/UNIQUE constraint also renames its backing index to match,
-- so this alone frees both names (inventory_events_pkey,
-- inventory_events_idempotency_key_key) for reuse.
ALTER TABLE inventory_events_pre_partition_20260928
  RENAME CONSTRAINT inventory_events_pkey TO inventory_events_pkey_pre_partition;
ALTER TABLE inventory_events_pre_partition_20260928
  RENAME CONSTRAINT inventory_events_idempotency_key_key TO inventory_events_idempotency_key_key_pre_partition;

-- ----------------------------------------------------------------------------
-- 3. The new partitioned table, under the real `inventory_events` name.
--    Same columns/CHECK constraints as before (migrations 0005, 0022) --
--    only the PK shape and idempotency_key's own UNIQUE-ness changed, per
--    this migration's own header comment above.
-- ----------------------------------------------------------------------------

CREATE TABLE inventory_events (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  product_id UUID NOT NULL REFERENCES products (id),
  location_id UUID NOT NULL REFERENCES locations (id),
  event_type TEXT NOT NULL CHECK (
    event_type IN ('receipt', 'sale', 'reservation', 'release', 'adjustment', 'damage', 'transfer')
  ),
  quantity_delta INT NOT NULL,
  reference_type TEXT CHECK (reference_type IN ('order', 'po', 'manual', 'return', 'transfer')),
  reference_id UUID,
  -- No longer UNIQUE at the table level -- see this migration's own header
  -- comment. Still NOT NULL: every real caller has always supplied one.
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX idx_inventory_events_tenant_id ON inventory_events (tenant_id);
CREATE INDEX idx_inventory_events_product_location ON inventory_events (product_id, location_id);
CREATE INDEX idx_inventory_events_reference ON inventory_events (reference_type, reference_id);
-- New: idempotency_key lost its UNIQUE index above, so a plain (non-unique)
-- one takes its place for the lookup queries that still filter by it
-- directly (InventoryService.transferStock's own pre-check).
CREATE INDEX idx_inventory_events_idempotency_key ON inventory_events (idempotency_key);

ALTER TABLE inventory_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_events FORCE ROW LEVEL SECURITY;

-- Guarded NULLIF(...) cast from the start, per §18's own closing
-- instruction: a brand-new tenant-scoped table's policy should crib this
-- form directly, not reproduce the bug class §18 spent two rounds fixing.
CREATE POLICY tenant_isolation_inventory_events ON inventory_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Same append-only grant shape as before -- app_user gets SELECT/INSERT
-- only, never UPDATE/DELETE.
GRANT SELECT, INSERT ON inventory_events TO app_user;

-- ----------------------------------------------------------------------------
-- 4. Monthly partitions, from the table's own earliest existing row through
--    3 months past the current month, plus a DEFAULT safety-net partition.
--    See this migration's own header comment for why DEFAULT is a backstop,
--    not the intended steady state.
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  earliest_month DATE;
  cursor_month DATE;
  end_month DATE;
  partition_name TEXT;
BEGIN
  SELECT date_trunc('month', COALESCE(MIN(created_at), now()))::date
    INTO earliest_month
    FROM inventory_events_pre_partition_20260928;

  cursor_month := earliest_month;
  end_month := (date_trunc('month', now()) + interval '3 months')::date;

  WHILE cursor_month <= end_month LOOP
    partition_name := 'inventory_events_' || to_char(cursor_month, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF inventory_events FOR VALUES FROM (%L) TO (%L)',
      partition_name,
      cursor_month,
      (cursor_month + interval '1 month')::date
    );
    cursor_month := (cursor_month + interval '1 month')::date;
  END LOOP;

  EXECUTE 'CREATE TABLE inventory_events_default PARTITION OF inventory_events DEFAULT';
END
$$;

-- ----------------------------------------------------------------------------
-- 5. Copy every existing row across.
-- ----------------------------------------------------------------------------

INSERT INTO inventory_events
  (id, tenant_id, product_id, location_id, event_type, quantity_delta, reference_type, reference_id, idempotency_key, created_at)
  SELECT id, tenant_id, product_id, location_id, event_type, quantity_delta, reference_type, reference_id, idempotency_key, created_at
  FROM inventory_events_pre_partition_20260928;
