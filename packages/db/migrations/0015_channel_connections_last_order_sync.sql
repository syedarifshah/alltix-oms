-- Expand-only, backward-compatible (CLAUDE.md §9): nullable, no backfill
-- needed. Set by the scheduled Amazon order-sync job (packages/scheduler)
-- to the *start* time of each successful sync pass -- not completion time,
-- so an order placed while a sync is in flight doesn't fall into the gap
-- between "when this sync started reading" and "when it finished writing."
-- NULL means "never synced" -- the job falls back to a default lookback
-- window on a tenant's first sync.
ALTER TABLE channel_connections ADD COLUMN last_order_sync_at TIMESTAMPTZ;
