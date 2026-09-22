import type { NextRequest } from "next/server";
import { withTenant, recordAuditEvent } from "@alltix/db";
import type { EmployeeStatus } from "@alltix/shared";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";
import { checkRateLimit, RATE_LIMIT_ERROR_MESSAGE } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** employees.status's CHECK constraint (migration 0028), duplicated here as
 *  a literal array -- same "validate against a real TS union before ever
 *  hitting the DB" reasoning as /api/locations/create's LOCATION_TYPES. */
const EMPLOYEE_STATUSES: readonly EmployeeStatus[] = ["active", "inactive"];

/**
 * POST /api/hr/employees/[id]/update -- the /hr page's inline "Edit"
 * form per employee row. Unlike /locations' rename (which fixes `type`
 * after creation because it's load-bearing for allocation/routing),
 * everything about an employee here is safe to change any time: role,
 * location, hourly rate, and status (marking someone 'inactive' rather than
 * deleting them -- same "workflow record, not something the app ever
 * removes" precedent as locations/orders/picklists, and time_entries keeps
 * referencing this row regardless of status).
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const pool = getAppPool();
  const user = await requireCurrentUser(req, pool);
  if (!user) {
    return redirectWithError(req, "/hr", "not signed in");
  }

  if (await checkRateLimit(pool, user.tenantId, "hr.employees.update")) {
    return redirectWithError(req, "/hr", RATE_LIMIT_ERROR_MESSAGE);
  }

  const { id } = await ctx.params;
  const formData = await req.formData();
  const role = String(formData.get("role") ?? "").trim();
  const locationId = String(formData.get("locationId") ?? "").trim() || null;
  const hourlyRateRaw = String(formData.get("hourlyRate") ?? "").trim();
  const status = String(formData.get("status") ?? "").trim();

  if (!role) {
    return redirectWithError(req, "/hr", "employee_missing_fields");
  }
  if (!EMPLOYEE_STATUSES.includes(status as EmployeeStatus)) {
    return redirectWithError(req, "/hr", "employee_invalid_status");
  }

  let hourlyRate: number | null = null;
  if (hourlyRateRaw) {
    hourlyRate = Number(hourlyRateRaw);
    if (!Number.isFinite(hourlyRate) || hourlyRate < 0) {
      return redirectWithError(req, "/hr", "employee_invalid_hourly_rate");
    }
  }

  try {
    const rowCount = await withTenant(pool, user.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE employees SET role = $1, location_id = $2, hourly_rate = $3, status = $4, updated_at = now()
          WHERE id = $5 AND tenant_id = $6`,
        [role, locationId, hourlyRate, status, id, user.tenantId],
      );
      if (result.rowCount) {
        // Same transaction as the UPDATE above -- see recordAuditEvent's own
        // doc comment for why that matters. Only recorded when a row was
        // actually matched, so a not-found update leaves no audit trace.
        await recordAuditEvent(client, {
          tenantId: user.tenantId,
          userId: user.id,
          action: "employee.updated",
          entityType: "employee",
          entityId: id,
          details: { role, locationId, hourlyRate, status },
        });
      }
      return result.rowCount;
    });
    if (rowCount === 0) {
      return redirectWithError(req, "/hr", "employee_not_found");
    }
  } catch (err) {
    return redirectWithError(req, "/hr", `employee_update_failed:${errorMessage(err)}`);
  }

  return redirectTo(req, "/hr?employee_updated=1");
}
