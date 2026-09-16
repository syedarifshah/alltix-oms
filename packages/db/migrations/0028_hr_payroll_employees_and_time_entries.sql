-- HR & Payroll module (CLAUDE.md §0 locked scope decision, §14) -- tasks #31-33:
-- an employee directory, per-shift time tracking, and (built on top of this
-- schema, not in it) a live gross-wage-calculation query over an arbitrary
-- date range. Deliberately NOT in scope here: tax withholding, deductions,
-- filings, or a real payroll-processor integration -- that is its own
-- separately-scoped future task (CLAUDE.md §14, task #34) given
-- jurisdiction-specific legal complexity.
--
-- No pay_periods/payroll_runs table in this pass -- gross wages are computed
-- as a live query (hours from time_entries x employees.hourly_rate) over a
-- tenant-chosen date range, mirroring the existing /reports page's
-- period-selector pattern. A stored payroll-run state machine is deferred
-- until real payroll processing (task #34) actually needs one to track
-- what's been "run" vs. not -- adding it now would be speculative.
CREATE TABLE employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name TEXT NOT NULL,
  -- Free text, not a fixed enum -- CLAUDE.md's own MVP customers (small/mid
  -- multichannel sellers) use whatever job-title vocabulary they already
  -- have ("Picker", "Warehouse Lead", "CSR"); constraining this to a fixed
  -- list would just mean an "Other" escape hatch nobody wants to maintain.
  role TEXT NOT NULL,
  -- Nullable: an employee isn't always tied to a single warehouse/3PL (e.g.
  -- a remote CSR), and this predates any employee being scheduled anywhere.
  location_id UUID REFERENCES locations (id),
  -- Nullable: lets an employee directory entry exist (for time tracking
  -- alone, task #32) before wage data is entered -- gross-wage calculation
  -- (task #33) simply can't compute a number for that employee yet.
  hourly_rate NUMERIC(10, 2) CHECK (hourly_rate IS NULL OR hourly_rate >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_employees_tenant_id ON employees (tenant_id);
CREATE INDEX idx_employees_location_id ON employees (location_id);

ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_employees ON employees
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON employees TO app_user;

-- One row per shift, whether it was live clock-in/clock-out or a manually
-- entered shift. Deliberately one canonical shape rather than a separate
-- "manual hours" numeric field alongside clock_in/clock_out: a manual entry
-- still gets real clock_in/clock_out timestamps (the UI computes
-- clock_out = clock_in + N hours when someone keys in "8 hours" instead of
-- punching in/out), so every downstream consumer -- gross-wage calculation
-- above all -- reads one shape instead of branching on entry_source.
-- entry_source is kept purely as provenance for that UI/audit distinction.
CREATE TABLE time_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  employee_id UUID NOT NULL REFERENCES employees (id),
  -- Nullable, independent of employees.location_id -- a shift can be worked
  -- at a location other than the employee's usual one (covering another
  -- warehouse), and this also tolerates an employee with no home location.
  location_id UUID REFERENCES locations (id),
  clock_in TIMESTAMPTZ NOT NULL,
  -- NULL means still clocked in -- an open shift, not a zero-length one.
  clock_out TIMESTAMPTZ,
  entry_source TEXT NOT NULL DEFAULT 'clock' CHECK (entry_source IN ('clock', 'manual')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (clock_out IS NULL OR clock_out > clock_in)
);

CREATE INDEX idx_time_entries_tenant_id ON time_entries (tenant_id);
CREATE INDEX idx_time_entries_employee_id ON time_entries (tenant_id, employee_id);
-- Supports the gross-wage-calculation query's date-range filter (task #33)
-- without a full table scan per tenant.
CREATE INDEX idx_time_entries_clock_in ON time_entries (tenant_id, clock_in);

ALTER TABLE time_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_entries FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_time_entries ON time_entries
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON time_entries TO app_user;
