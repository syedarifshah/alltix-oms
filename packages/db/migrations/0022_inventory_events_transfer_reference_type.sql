-- Widens inventory_events.reference_type's CHECK constraint to allow
-- 'transfer', for InventoryService.transferStock() (packages/inventory-service/
-- src/index.ts) -- the new method that finally implements the 'transfer'
-- event_type migration 0005 already allowed in its own CHECK constraint but
-- nothing ever wrote (recordInventoryEvent() threw outright on it, see that
-- class's own doc comment/this migration's sibling code change).
--
-- A transfer records two paired inventory_events rows (one negative-delta
-- 'transfer' event at the source location, one positive-delta 'transfer'
-- event at the destination), both carrying reference_type = 'transfer' and
-- the SAME reference_id (a fresh UUID generated per transfer, not tied to
-- any other table) -- the mechanism that lets the two legs of one transfer
-- be found and displayed together later, the same role reference_type/
-- reference_id already play for 'order' (an order's allocation/sale
-- events) and 'po' (a purchase-order receipt).
--
-- Widening a CHECK constraint's allowed value set is expand-only per
-- CLAUDE.md §9: every existing row's reference_type is one of the four
-- values already allowed, so re-adding them alongside the new fifth value
-- changes nothing about what's already stored. Postgres has no
-- ALTER TABLE ... ALTER CONSTRAINT for CHECK, so this drops and recreates
-- it under the same auto-generated name Postgres gave it in 0005
-- (`<table>_<column>_check`) -- purely so `\d inventory_events` still shows
-- one obviously-named constraint per column, not `..._check1`.
ALTER TABLE inventory_events DROP CONSTRAINT inventory_events_reference_type_check;
ALTER TABLE inventory_events ADD CONSTRAINT inventory_events_reference_type_check
  CHECK (reference_type IN ('order', 'po', 'manual', 'return', 'transfer'));
