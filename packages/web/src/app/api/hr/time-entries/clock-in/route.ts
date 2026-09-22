import type { NextRequest } from "next/server";
import { withTenant } from "@alltix/db";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

/**
 * POST /api/hr/time-entries/clock-in -- the /hr page's per-employee
 * "Clock in" button. Inserts an open shift (clock_out left NULL -- "still
 * clocked in", not a zero-length shift, per migration 0028's own comment).
 * Refuses a second concurrent open shift for the same employee rather than
 * silently creating overlapping entries that would double-count hours in
 * task #33's gross-wage calculation.
 *
 * The checked SELECT ... FOR UPDATE below is only a fast, friendly
 * early-exit for the common sequential case (an employee who's already
 * clocked in clicking the button again) -- it does NOT by itself prevent
 * the race migration 0029 closes: `FOR UPDATE` only locks rows that
 * already exist, and when there's no open shift yet (the common case),
 * that SELECT returns zero rows and locks nothing, so two genuinely
 * concurrent clock-ins for the same employee could both see "no open
 * shift" and both INSERT. The real guarantee is
 * `idx_time_entries_one_open_shift_per_employee` (migration 0029), a
 * partial UNIQUE index on `(tenant_id, employee_id) WHERE clock_out IS
 * NULL` -- a second concurrent INSERT fails with a real unique_violation
 * (23505), caught below the same way /api/products/create already catches
 * a duplicate-SKU 23505.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireCurrentUser(req, getAppPool());
  if (!user) {
    return redirectWithError(req, "/hr", "not signed in");
  }

  const formData = await req.formData();
  const employeeId = String(formData.get("employeeId") ?? "").trim();
  const locationId = String(formData.get("locationId") ?? "").trim() || null;

  if (!employeeId) {
    return redirectWithError(req, "/hr", "time_entry_missing_employee");
  }

  try {
    await withTenant(getAppPool(), user.tenantId, async (client) => {
      const open = await client.query(
        `SELECT id FROM time_entries WHERE tenant_id = $1 AND employee_id = $2 AND clock_out IS NULL FOR UPDATE`,
        [user.tenantId, employeeId],
      );
      if ((open.rowCount ?? 0) > 0) {
        throw new Error("already_clocked_in");
      }
      await client.query(
        `INSERT INTO time_entries (tenant_id, employee_id, location_id, clock_in, entry_source)
         VALUES ($1, $2, $3, now(), 'clock')`,
        [user.tenantId, employeeId, locationId],
      );
    });
  } catch (err) {
    if (errorMessage(err) === "already_clocked_in") {
      return redirectWithError(req, "/hr", "time_entry_already_clocked_in");
    }
    // Postgres unique_violation on idx_time_entries_one_open_shift_per_employee
    // (migration 0029) -- the real guard against two concurrent clock-ins for
    // the same employee both racing past the SELECT above and both INSERTing.
    const pgCode = (err as { code?: string } | null)?.code;
    if (pgCode === "23505") {
      return redirectWithError(req, "/hr", "time_entry_already_clocked_in");
    }
    return redirectWithError(req, "/hr", `time_entry_clock_in_failed:${errorMessage(err)}`);
  }

  return redirectTo(req, "/hr?clocked_in=1");
}
