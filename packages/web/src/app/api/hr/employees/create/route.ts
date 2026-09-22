import type { NextRequest } from "next/server";
import { withTenant, recordAuditEvent } from "@alltix/db";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";
import { checkRateLimit, RATE_LIMIT_ERROR_MESSAGE } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * POST /api/hr/employees/create -- the /hr page's "Add employee" form.
 * `role` is free text, not validated against a fixed list -- see migration
 * 0028_hr_payroll_employees_and_time_entries.sql's own comment for why (this
 * platform's MVP customers already have their own job-title vocabulary).
 * `locationId` and `hourlyRate` are both optional: an employee can exist for
 * time tracking alone (task #32) before wage data is entered (task #33 can't
 * compute a gross wage for that employee until it is).
 */
export async function POST(req: NextRequest): Promise<Response> {
  const pool = getAppPool();
  const user = await requireCurrentUser(req, pool);
  if (!user) {
    return redirectWithError(req, "/hr", "not signed in");
  }

  if (await checkRateLimit(pool, user.tenantId, "hr.employees.create")) {
    return redirectWithError(req, "/hr", RATE_LIMIT_ERROR_MESSAGE);
  }

  const formData = await req.formData();
  const name = String(formData.get("name") ?? "").trim();
  const role = String(formData.get("role") ?? "").trim();
  const locationId = String(formData.get("locationId") ?? "").trim() || null;
  const hourlyRateRaw = String(formData.get("hourlyRate") ?? "").trim();

  if (!name || !role) {
    return redirectWithError(req, "/hr", "employee_missing_fields");
  }

  let hourlyRate: number | null = null;
  if (hourlyRateRaw) {
    hourlyRate = Number(hourlyRateRaw);
    if (!Number.isFinite(hourlyRate) || hourlyRate < 0) {
      return redirectWithError(req, "/hr", "employee_invalid_hourly_rate");
    }
  }

  try {
    await withTenant(pool, user.tenantId, async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO employees (tenant_id, name, role, location_id, hourly_rate) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [user.tenantId, name, role, locationId, hourlyRate],
      );
      // Same transaction as the INSERT above -- see recordAuditEvent's own
      // doc comment for why that matters (a rolled-back create never leaves
      // a committed audit row behind).
      await recordAuditEvent(client, {
        tenantId: user.tenantId,
        userId: user.id,
        action: "employee.created",
        entityType: "employee",
        entityId: result.rows[0]!.id,
        details: { name, role, locationId, hourlyRate },
      });
    });
  } catch (err) {
    return redirectWithError(req, "/hr", `employee_create_failed:${errorMessage(err)}`);
  }

  return redirectTo(req, "/hr?employee_created=1");
}
