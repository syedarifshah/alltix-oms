import type { NextRequest } from "next/server";
import { withTenant } from "@alltix/db";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";
import { checkRateLimit, RATE_LIMIT_ERROR_MESSAGE } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * POST /api/hr/time-entries/manual -- the /hr page's "Add a shift" form for
 * a shift that wasn't (or couldn't be) live clock-in/clock-out'd. Per
 * migration 0028's own comment, this still produces a real
 * clock_in/clock_out pair, not a separate "manual hours" shape:
 * `clockIn` comes straight off the form's `<input type="datetime-local">`,
 * and `clockOut` is computed here as `clockIn + hoursWorked`, so every
 * downstream reader (task #33's gross-wage calculation above all) sees one
 * canonical shift shape regardless of entry_source.
 *
 * KNOWN LIMITATION, flagged rather than silently assumed: `datetime-local`
 * submits a timezone-free string ("YYYY-MM-DDTHH:mm"); `new Date(...)` on
 * that string is interpreted in the *server's* local timezone (this app's
 * Vercel deployment runs UTC), not the browser's. For a tenant not on UTC,
 * a manually-entered shift's stored clock_in/clock_out will be offset from
 * what they typed. No format-level fix exists without also asking the
 * tenant's own timezone somewhere durable (no such setting exists yet
 * anywhere in this schema) -- left as a real, documented gap rather than a
 * guessed "fix" that could be wrong in the other direction.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const pool = getAppPool();
  const user = await requireCurrentUser(req, pool);
  if (!user) {
    return redirectWithError(req, "/hr", "not signed in");
  }

  if (await checkRateLimit(pool, user.tenantId, "hr.time_entries.manual")) {
    return redirectWithError(req, "/hr", RATE_LIMIT_ERROR_MESSAGE);
  }

  const formData = await req.formData();
  const employeeId = String(formData.get("employeeId") ?? "").trim();
  const locationId = String(formData.get("locationId") ?? "").trim() || null;
  const clockInRaw = String(formData.get("clockIn") ?? "").trim();
  const hoursRaw = String(formData.get("hours") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim() || null;

  if (!employeeId || !clockInRaw || !hoursRaw) {
    return redirectWithError(req, "/hr", "time_entry_missing_fields");
  }

  const clockIn = new Date(clockInRaw);
  if (Number.isNaN(clockIn.getTime())) {
    return redirectWithError(req, "/hr", "time_entry_invalid_clock_in");
  }

  const hours = Number(hoursRaw);
  if (!Number.isFinite(hours) || hours <= 0) {
    return redirectWithError(req, "/hr", "time_entry_invalid_hours");
  }

  const clockOut = new Date(clockIn.getTime() + hours * 60 * 60 * 1000);

  try {
    await withTenant(pool, user.tenantId, (client) =>
      client.query(
        `INSERT INTO time_entries (tenant_id, employee_id, location_id, clock_in, clock_out, entry_source, notes)
         VALUES ($1, $2, $3, $4, $5, 'manual', $6)`,
        [user.tenantId, employeeId, locationId, clockIn.toISOString(), clockOut.toISOString(), notes],
      ),
    );
  } catch (err) {
    return redirectWithError(req, "/hr", `time_entry_manual_add_failed:${errorMessage(err)}`);
  }

  return redirectTo(req, "/hr?time_entry_added=1");
}
