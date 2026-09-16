import type { NextRequest } from "next/server";
import { withTenant } from "@alltix/db";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

/**
 * POST /api/hr/time-entries/[id]/clock-out -- the /hr page's per-employee
 * "Clock out" button, closing that employee's currently-open shift. Scoped
 * by `clock_out IS NULL` in the WHERE clause, not just id/tenant -- an
 * already-closed entry (e.g. a double-submitted click) is a no-op
 * (rowCount 0 -> friendly redirect error) rather than silently overwriting
 * a real clock_out with a later one.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const user = await requireCurrentUser(req, getAppPool());
  if (!user) {
    return redirectWithError(req, "/hr", "not signed in");
  }

  const { id } = await ctx.params;

  try {
    const result = await withTenant(getAppPool(), user.tenantId, (client) =>
      client.query(
        `UPDATE time_entries SET clock_out = now(), updated_at = now()
          WHERE id = $1 AND tenant_id = $2 AND clock_out IS NULL`,
        [id, user.tenantId],
      ),
    );
    if (result.rowCount === 0) {
      return redirectWithError(req, "/hr", "time_entry_not_open");
    }
  } catch (err) {
    return redirectWithError(req, "/hr", `time_entry_clock_out_failed:${errorMessage(err)}`);
  }

  return redirectTo(req, "/hr?clocked_out=1");
}
