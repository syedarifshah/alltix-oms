-- Links a "the rest of your order" backorder split off from a short pick
-- (WarehouseService.packOrder, CLAUDE.md §3's now-resolved OPEN PRODUCT
-- DECISION -- Arif's call: split into a partial shipment + backorder rather
-- than silently ship-what-was-picked or hold the whole order) back to the
-- real order it was split from.
--
-- Nullable, self-referencing FK -- the overwhelming majority of orders are
-- never split and this stays NULL. A reverse lookup ("did this order ever
-- spin off a backorder, and if so which one") is a plain
-- `SELECT id FROM orders WHERE split_from_order_id = $1` -- no second
-- column needed on the original order, and no risk of the two ever
-- disagreeing about the relationship the way two independently-maintained
-- pointers could.
--
-- Expand-only per CLAUDE.md §9: a new nullable column with no default,
-- backfilling nothing on existing rows.
ALTER TABLE orders ADD COLUMN split_from_order_id UUID REFERENCES orders (id);

-- Partial index -- only the (rare) split-off rows are ever looked up by
-- this column, so indexing the common NULL case would be pure overhead.
CREATE INDEX idx_orders_split_from_order_id ON orders (split_from_order_id)
  WHERE split_from_order_id IS NOT NULL;
