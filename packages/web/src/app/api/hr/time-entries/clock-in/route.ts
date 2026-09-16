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
 * task #33's gross-wage calculation -- the checked SELECT + INSERT run
 * inside one withTenant transaction, so a double-submit from the same page
 * either both see the same open entry (second one rejected) or both race
 * fresh (Postgres row-level locking within the transaction serializes them,
 * since both write the same employee_id).
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
    return redirectWithError(req, "/hr", `time_entry_clock_in_failed:${errorMessage(err)}`);
  }

  return redirectTo(req, "/hr?clocked_in=1");
}
