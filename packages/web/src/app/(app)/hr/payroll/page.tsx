import type { ReactElement } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { withTenant } from "@alltix/db";
import { getAppPool } from "@/lib/db";
import { getAuthContext } from "@/lib/auth-context";
import { resolveTenantId } from "@/lib/with-tenant-auth";

export const dynamic = "force-dynamic";

interface GrossWageRow {
  id: string;
  name: string;
  role: string;
  hourly_rate: string | null;
  hours: string;
  open_shifts: string;
}

interface PayrollPageProps {
  searchParams: Promise<{ from?: string; to?: string }>;
}

const DEFAULT_PERIOD_DAYS = 14;

function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Parses a `YYYY-MM-DD` searchParam into a real Date, falling back to
 *  `fallback` on anything unparseable (missing, malformed, or -- since
 *  `new Date("garbage")` doesn't throw -- an Invalid Date). Deliberately
 *  permissive rather than erroring the page: this is a read-only report
 *  with a plain GET form, no ?error= banner convention to show a rejection
 *  through, so silently falling back to a sane default (matching /reports'
 *  own parsePeriodDays fallback-not-error precedent) is the better failure
 *  mode for a bad or hand-edited URL. */
function parseDateParam(raw: string | undefined, fallback: Date): Date {
  if (!raw) return fallback;
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

/**
 * Gross wage calculation (CLAUDE.md §0/§14, task #33) -- hours × rate, over
 * an arbitrary tenant-chosen date range, computed live from `time_entries` x
 * `employees.hourly_rate`. Deliberately NOT a stored payroll-run: see
 * migration 0028's own comment for why (no `pay_periods` table exists --
 * this is a read-only query, same "start simple" call /reports' own doc
 * comment makes for its own reporting layer). No tax withholding,
 * deductions, or filings -- explicitly out of scope for this pass (§0);
 * that's task #34's own separately-scoped future work.
 *
 * Period boundary: an employee's hours count toward this period based on
 * `clock_in` falling within [from, to] (inclusive of the whole `to` day,
 * hence the exclusive `< to + 1 day` upper bound in the query) -- a shift
 * that started in-period but hasn't been clocked out yet
 * (`clock_out IS NULL`) is excluded from the hours sum (its duration isn't
 * knowable yet) but the employee still appears with an "open shifts" count
 * so a still-running shift is visibly flagged, not silently dropped.
 *
 * An employee with hours but no `hourly_rate` set shows "no rate set" and
 * is excluded from the total, rather than being silently treated as $0 --
 * a $0 gross wage and "we don't know this employee's rate" are two very
 * different facts and conflating them would be a real payroll error.
 */
export default async function PayrollPage({ searchParams }: PayrollPageProps): Promise<ReactElement> {
  const authContext = await getAuthContext(await headers());
  if (!authContext) {
    redirect("/sign-in");
  }

  const pool = getAppPool();
  const tenantId = await resolveTenantId(pool, authContext.clerkUserId);
  const { from: rawFrom, to: rawTo } = await searchParams;

  if (!tenantId) {
    return (
      <main className="page">
        <h1>Payroll</h1>
        <p>No tenant is associated with this account yet.</p>
      </main>
    );
  }

  const defaultTo = new Date();
  const defaultFrom = new Date(defaultTo.getTime() - (DEFAULT_PERIOD_DAYS - 1) * 24 * 60 * 60 * 1000);

  const from = parseDateParam(rawFrom, defaultFrom);
  const to = parseDateParam(rawTo, defaultTo);
  // Exclusive upper bound covering the whole `to` calendar day.
  const toExclusive = new Date(to.getTime() + 24 * 60 * 60 * 1000);

  const rows = await withTenant(pool, tenantId, async (client) => {
    const result = await client.query<GrossWageRow>(
      `SELECT e.id, e.name, e.role, e.hourly_rate::text AS hourly_rate,
              coalesce(sum(
                extract(epoch FROM (te.clock_out - te.clock_in)) / 3600.0
              ) FILTER (WHERE te.clock_out IS NOT NULL), 0)::text AS hours,
              count(*) FILTER (WHERE te.clock_out IS NULL)::text AS open_shifts
         FROM employees e
         JOIN time_entries te ON te.employee_id = e.id
        WHERE te.clock_in >= $1 AND te.clock_in < $2
        GROUP BY e.id, e.name, e.role, e.hourly_rate
        ORDER BY e.name`,
      [from.toISOString(), toExclusive.toISOString()],
    );
    return result.rows;
  });

  let totalHours = 0;
  let totalGrossPay = 0;
  let anyMissingRate = false;

  return (
    <main className="page">
      <h1>Payroll</h1>
      <p className="subtitle">
        Gross wages (hours × hourly rate) for a pay period, computed live from tracked time. No tax withholding,
        deductions, or filings -- see <a href="/hr">/hr</a> for the employee directory and time clock.
      </p>

      <form method="GET" className="row" style={{ gap: 8, marginBottom: 20 }}>
        <label>
          From <input type="date" name="from" defaultValue={toDateOnly(from)} />
        </label>
        <label>
          To <input type="date" name="to" defaultValue={toDateOnly(to)} />
        </label>
        <button type="submit">View</button>
      </form>

      {rows.length === 0 ? (
        <p className="empty">No shifts started in this period.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Employee</th>
                <th>Role</th>
                <th>Hours</th>
                <th>Hourly rate</th>
                <th>Gross pay</th>
                <th>Open shifts</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const hours = Number(row.hours);
                const hourlyRate = row.hourly_rate !== null ? Number(row.hourly_rate) : null;
                const grossPay = hourlyRate !== null ? hours * hourlyRate : null;
                totalHours += hours;
                if (grossPay !== null) {
                  totalGrossPay += grossPay;
                } else {
                  anyMissingRate = true;
                }
                return (
                  <tr key={row.id}>
                    <td>{row.name}</td>
                    <td>{row.role}</td>
                    <td>{hours.toFixed(2)}</td>
                    <td>{hourlyRate !== null ? hourlyRate.toFixed(2) : <span className="muted">not set</span>}</td>
                    <td>
                      {grossPay !== null ? (
                        grossPay.toFixed(2)
                      ) : (
                        <span className="badge badge-danger">no rate set</span>
                      )}
                    </td>
                    <td>
                      {Number(row.open_shifts) > 0 ? (
                        <span className="badge">{row.open_shifts} still open</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              <tr>
                <td>
                  <strong>Total</strong>
                </td>
                <td></td>
                <td>
                  <strong>{totalHours.toFixed(2)}</strong>
                </td>
                <td></td>
                <td>
                  <strong>{totalGrossPay.toFixed(2)}</strong>
                  {anyMissingRate && (
                    <>
                      {" "}
                      <span className="muted">(excludes employees with no rate set)</span>
                    </>
                  )}
                </td>
                <td></td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
