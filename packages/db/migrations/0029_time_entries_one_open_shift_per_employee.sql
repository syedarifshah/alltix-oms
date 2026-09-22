-- Closes a real concurrency gap in the HR clock-in flow (found auditing
-- packages/web/src/app/api/hr/time-entries/clock-in/route.ts): that route's
-- only defense against double-booking an employee was
-- `SELECT id FROM time_entries WHERE ... clock_out IS NULL FOR UPDATE`
-- inside the same transaction as the INSERT. `FOR UPDATE` only locks rows
-- that already exist -- when an employee has no open shift yet (the common
-- case: their last shift was properly clocked out, or this is their first
-- ever clock-in), that SELECT returns zero rows and locks nothing, so two
-- concurrent clock-in requests for the same employee (a double-click, or
-- two people at a shared kiosk) can both see "no open shift" and both
-- INSERT, leaving two overlapping open shifts. That would double-count
-- hours in task #33's gross-wage calculation exactly the way migration
-- 0028's own comment on clock-in says this check exists to prevent --
-- CLAUDE.md's own allocation/transfer code is careful about this same
-- "FOR UPDATE doesn't lock rows that don't exist yet" pitfall (locking is
-- always paired with either an existing row or a real unique constraint);
-- this table was missing the latter.
--
-- Fixed at the only place a concurrency invariant can actually be
-- guaranteed: the database, not the application-level SELECT-then-INSERT
-- (which stays, as a fast, friendly early-exit for the common sequential
-- case -- see the route's own updated comment). A partial UNIQUE index
-- makes a second concurrent INSERT for the same (tenant_id, employee_id)
-- while one is still open fail with a real unique_violation (Postgres
-- error 23505), which the route now catches the same way
-- /api/products/create already catches a duplicate-SKU 23505 -- a friendly
-- redirect error instead of a raw constraint-violation message.
CREATE UNIQUE INDEX idx_time_entries_one_open_shift_per_employee
  ON time_entries (tenant_id, employee_id)
  WHERE clock_out IS NULL;
