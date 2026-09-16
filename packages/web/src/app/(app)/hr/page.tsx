import type { ReactElement } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { withTenant } from "@alltix/db";
import type { EmployeeStatus, TimeEntrySource } from "@alltix/shared";
import { getAppPool } from "@/lib/db";
import { getAuthContext } from "@/lib/auth-context";
import { resolveTenantId } from "@/lib/with-tenant-auth";

export const dynamic = "force-dynamic";

interface LocationOption {
  id: string;
  name: string;
}

interface EmployeeRow {
  id: string;
  name: string;
  role: string;
  location_id: string | null;
  location_name: string | null;
  hourly_rate: string | null;
  status: EmployeeStatus;
  created_at: string;
  open_time_entry_id: string | null;
}

interface TimeEntryRow {
  id: string;
  employee_name: string;
  location_name: string | null;
  clock_in: string;
  clock_out: string | null;
  entry_source: TimeEntrySource;
  notes: string | null;
}

interface HrPageProps {
  searchParams: Promise<{
    error?: string;
    employee_created?: string;
    employee_updated?: string;
    clocked_in?: string;
    clocked_out?: string;
    time_entry_added?: string;
  }>;
}

const RECENT_TIME_ENTRIES_LIMIT = 50;

/**
 * HR & Payroll module, layer 1 (CLAUDE.md §0/§14) -- employee directory +
 * time tracking. No wage math on this page: an hourly_rate is recorded per
 * employee (task #31's schema) so task #33's gross-wage-calculation view
 * has something to multiply hours by, but this page itself never computes a
 * dollar figure.
 *
 * Same auth/tenant pattern as every other page in this app -- see
 * src/app/orders/page.tsx's doc comment. "Clock in"/"Clock out" and "Add a
 * shift" are plain HTML forms, no client JS, same convention as every other
 * page-driven mutation here (see /locations page's own doc comment).
 */
export default async function HrPage({ searchParams }: HrPageProps): Promise<ReactElement> {
  const authContext = await getAuthContext(await headers());
  if (!authContext) {
    redirect("/sign-in");
  }

  const pool = getAppPool();
  const tenantId = await resolveTenantId(pool, authContext.clerkUserId);
  const {
    error,
    employee_created: employeeCreated,
    employee_updated: employeeUpdated,
    clocked_in: clockedIn,
    clocked_out: clockedOut,
    time_entry_added: timeEntryAdded,
  } = await searchParams;

  if (!tenantId) {
    return (
      <main className="page">
        <h1>HR &amp; Payroll</h1>
        <p>No tenant is associated with this account yet.</p>
      </main>
    );
  }

  const { employees, locations, timeEntries } = await withTenant(pool, tenantId, async (client) => {
    const employeesResult = await client.query<EmployeeRow>(
      `SELECT e.id, e.name, e.role, e.location_id, loc.name AS location_name,
              e.hourly_rate::text AS hourly_rate, e.status, e.created_at,
              open.id AS open_time_entry_id
         FROM employees e
         LEFT JOIN locations loc ON loc.id = e.location_id
         LEFT JOIN time_entries open ON open.employee_id = e.id AND open.clock_out IS NULL
        ORDER BY e.status, e.name`,
    );
    const locationsResult = await client.query<LocationOption>(`SELECT id, name FROM locations ORDER BY name`);
    const timeEntriesResult = await client.query<TimeEntryRow>(
      `SELECT te.id, e.name AS employee_name, loc.name AS location_name,
              te.clock_in, te.clock_out, te.entry_source, te.notes
         FROM time_entries te
         JOIN employees e ON e.id = te.employee_id
         LEFT JOIN locations loc ON loc.id = te.location_id
        ORDER BY te.clock_in DESC
        LIMIT ${RECENT_TIME_ENTRIES_LIMIT}`,
    );
    return { employees: employeesResult.rows, locations: locationsResult.rows, timeEntries: timeEntriesResult.rows };
  });

  return (
    <main className="page">
      <h1>HR &amp; Payroll</h1>
      <p className="subtitle">
        Employee directory and time tracking. See <a href="/hr/payroll">/hr/payroll</a> for gross wages (hours ×
        rate, no tax withholding) per pay period.
      </p>

      {employeeCreated === "1" && <div className="alert alert-success">Employee added.</div>}
      {employeeUpdated === "1" && <div className="alert alert-success">Employee updated.</div>}
      {clockedIn === "1" && <div className="alert alert-success">Clocked in.</div>}
      {clockedOut === "1" && <div className="alert alert-success">Clocked out.</div>}
      {timeEntryAdded === "1" && <div className="alert alert-success">Shift added.</div>}
      {error && <div className="alert alert-danger">{describeError(error)}</div>}

      <h2>Employees</h2>

      <details className="stack" style={{ marginBottom: 16 }}>
        <summary>Add an employee</summary>
        <form action="/api/hr/employees/create" method="POST" className="row" style={{ gap: 6, marginTop: 8 }}>
          <input type="text" name="name" placeholder="Full name" required />
          <input type="text" name="role" placeholder="Role (e.g. Picker)" required />
          <select name="locationId" defaultValue="">
            <option value="">No location</option>
            {locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
          </select>
          <input type="number" name="hourlyRate" placeholder="Hourly rate (optional)" min="0" step="0.01" style={{ width: 160 }} />
          <button type="submit">Add employee</button>
        </form>
      </details>

      {employees.length === 0 ? (
        <p className="empty">No employees yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Location</th>
                <th>Hourly rate</th>
                <th>Status</th>
                <th>Edit</th>
                <th>Time clock</th>
              </tr>
            </thead>
            <tbody>
              {employees.map((employee) => (
                <tr key={employee.id}>
                  <td>{employee.name}</td>
                  <td>{employee.role}</td>
                  <td>{employee.location_name ?? <span className="muted">none</span>}</td>
                  <td>{employee.hourly_rate ?? <span className="muted">not set</span>}</td>
                  <td>
                    <span className="badge">{employee.status}</span>
                  </td>
                  <td>
                    <EditEmployeeForm employee={employee} locations={locations} />
                  </td>
                  <td>
                    <ClockForm employeeId={employee.id} locations={locations} openTimeEntryId={employee.open_time_entry_id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 style={{ marginTop: 32 }}>Add a shift (manual entry)</h2>
      <p className="subtitle">
        For a shift that wasn't live clocked in/out. Enter a start time and hours worked -- the end time is
        computed for you.
      </p>
      <ManualTimeEntryForm employees={employees} locations={locations} />

      <h2 style={{ marginTop: 32 }}>Recent shifts</h2>
      {timeEntries.length === 0 ? (
        <p className="empty">No shifts recorded yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Employee</th>
                <th>Location</th>
                <th>Clock in</th>
                <th>Clock out</th>
                <th>Hours</th>
                <th>Source</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {timeEntries.map((entry) => (
                <tr key={entry.id}>
                  <td>{entry.employee_name}</td>
                  <td>{entry.location_name ?? <span className="muted">none</span>}</td>
                  <td>{new Date(entry.clock_in).toISOString()}</td>
                  <td>
                    {entry.clock_out ? (
                      new Date(entry.clock_out).toISOString()
                    ) : (
                      <span className="badge">in progress</span>
                    )}
                  </td>
                  <td>{formatHours(entry.clock_in, entry.clock_out)}</td>
                  <td>
                    <span className="badge">{entry.entry_source}</span>
                  </td>
                  <td>{entry.notes ?? <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

function formatHours(clockIn: string, clockOut: string | null): string {
  if (!clockOut) return "—";
  const hours = (new Date(clockOut).getTime() - new Date(clockIn).getTime()) / (60 * 60 * 1000);
  return hours.toFixed(2);
}

/** Always-visible edit form (no toggled "edit mode" -- no client JS here to
 *  toggle it with), same convention as /locations' RenameLocationForm.
 *  `name` isn't editable here -- unlike role/location/rate/status, a
 *  person's name isn't something this form treats as a correction to make
 *  casually; there's no strong reason to lock it either, just no request
 *  for it yet, so it's simply left off this pass. */
function EditEmployeeForm({
  employee,
  locations,
}: {
  employee: EmployeeRow;
  locations: LocationOption[];
}): ReactElement {
  return (
    <form action={`/api/hr/employees/${employee.id}/update`} method="POST" className="row" style={{ gap: 6 }}>
      <input type="text" name="role" defaultValue={employee.role} required style={{ width: 120 }} />
      <select name="locationId" defaultValue={employee.location_id ?? ""}>
        <option value="">No location</option>
        {locations.map((location) => (
          <option key={location.id} value={location.id}>
            {location.name}
          </option>
        ))}
      </select>
      <input
        type="number"
        name="hourlyRate"
        defaultValue={employee.hourly_rate ?? ""}
        min="0"
        step="0.01"
        style={{ width: 100 }}
      />
      <select name="status" defaultValue={employee.status}>
        <option value="active">Active</option>
        <option value="inactive">Inactive</option>
      </select>
      <button type="submit">Save</button>
    </form>
  );
}

/** Two separate one-click forms (Clock in / Clock out), only one of which
 *  ever renders for a given employee -- whether they currently have an open
 *  shift (`openTimeEntryId`) decides which. No fields to fill in: clock-in
 *  captures `now()` server-side (see the route's own doc comment). */
function ClockForm({
  employeeId,
  locations,
  openTimeEntryId,
}: {
  employeeId: string;
  locations: LocationOption[];
  openTimeEntryId: string | null;
}): ReactElement {
  if (openTimeEntryId) {
    return (
      <form action={`/api/hr/time-entries/${openTimeEntryId}/clock-out`} method="POST">
        <button type="submit">Clock out</button>
      </form>
    );
  }
  return (
    <form action="/api/hr/time-entries/clock-in" method="POST" className="row" style={{ gap: 6 }}>
      <input type="hidden" name="employeeId" value={employeeId} />
      {locations.length > 0 && (
        <select name="locationId" defaultValue="">
          <option value="">No location</option>
          {locations.map((location) => (
            <option key={location.id} value={location.id}>
              {location.name}
            </option>
          ))}
        </select>
      )}
      <button type="submit">Clock in</button>
    </form>
  );
}

function ManualTimeEntryForm({
  employees,
  locations,
}: {
  employees: EmployeeRow[];
  locations: LocationOption[];
}): ReactElement {
  return (
    <form action="/api/hr/time-entries/manual" method="POST" className="row" style={{ gap: 6, flexWrap: "wrap" }}>
      <select name="employeeId" required defaultValue="">
        <option value="" disabled>
          Employee
        </option>
        {employees.map((employee) => (
          <option key={employee.id} value={employee.id}>
            {employee.name}
          </option>
        ))}
      </select>
      <select name="locationId" defaultValue="">
        <option value="">No location</option>
        {locations.map((location) => (
          <option key={location.id} value={location.id}>
            {location.name}
          </option>
        ))}
      </select>
      <input type="datetime-local" name="clockIn" required />
      <input type="number" name="hours" placeholder="Hours" min="0.01" step="0.01" required style={{ width: 90 }} />
      <input type="text" name="notes" placeholder="Notes (optional)" style={{ width: 160 }} />
      <button type="submit">Add shift</button>
    </form>
  );
}

function describeError(error: string): string {
  if (error === "employee_missing_fields") return "Enter a name and role before submitting.";
  if (error === "employee_invalid_hourly_rate") return "Hourly rate must be a non-negative number.";
  if (error === "employee_invalid_status") return "Choose a valid status.";
  if (error === "employee_not_found") return "That employee could not be found.";
  if (error.startsWith("employee_create_failed:")) {
    return `Could not add that employee: ${error.slice("employee_create_failed:".length)}`;
  }
  if (error.startsWith("employee_update_failed:")) {
    return `Could not update that employee: ${error.slice("employee_update_failed:".length)}`;
  }
  if (error === "time_entry_missing_employee") return "Choose an employee before submitting.";
  if (error === "time_entry_already_clocked_in") return "That employee is already clocked in.";
  if (error === "time_entry_not_open") return "That shift is already clocked out.";
  if (error.startsWith("time_entry_clock_in_failed:")) {
    return `Could not clock in: ${error.slice("time_entry_clock_in_failed:".length)}`;
  }
  if (error.startsWith("time_entry_clock_out_failed:")) {
    return `Could not clock out: ${error.slice("time_entry_clock_out_failed:".length)}`;
  }
  if (error === "time_entry_missing_fields") return "Choose an employee, a start time, and hours before submitting.";
  if (error === "time_entry_invalid_clock_in") return "Enter a valid start time.";
  if (error === "time_entry_invalid_hours") return "Hours worked must be a positive number.";
  if (error.startsWith("time_entry_manual_add_failed:")) {
    return `Could not add that shift: ${error.slice("time_entry_manual_add_failed:".length)}`;
  }
  return error;
}
