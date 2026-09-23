import type { NextRequest } from "next/server";
import { linkEmployeeToCheck } from "@alltix/payroll-service";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";
import { checkRateLimit, RATE_LIMIT_ERROR_MESSAGE } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * POST /api/payroll/employees/link -- creates the Check-side Employee
 * resource for one local `employees` row and links the two
 * (employees.check_employee_id, migration 0038) via
 * linkEmployeeToCheck() (CONFIRMED shape: `POST /employees` -- see
 * @alltix/payroll-service's own doc comments). Expand-only: a second
 * submission for an already-linked employee is refused by the service
 * layer, not silently re-run.
 *
 * `workplaceId` is collected as a plain text field here rather than a
 * dropdown of real Check Workplace resources -- this pass builds
 * CheckClient.createWorkplace() but no UI/service function decides which
 * of a tenant's own `locations` rows should become which Check Workplace
 * (see linkEmployeeToCheck's own doc comment for why that mapping is left
 * as an open design question, not guessed at here). A tenant with a real
 * Check company must create the workplace in Check's own Dashboard (or via
 * a future pass's own UI) and paste its id here for now.
 *
 * UNVERIFIED IN PRACTICE -- same status as every route in
 * packages/web/src/app/api/payroll.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const pool = getAppPool();
  const user = await requireCurrentUser(req, pool);
  if (!user) {
    return redirectWithError(req, "/settings/payroll", "not signed in");
  }

  if (await checkRateLimit(pool, user.tenantId, "payroll.employees.link")) {
    return redirectWithError(req, "/settings/payroll", RATE_LIMIT_ERROR_MESSAGE);
  }

  const formData = await req.formData();
  const employeeId = String(formData.get("employeeId") ?? "").trim();
  const workplaceId = String(formData.get("workplaceId") ?? "").trim();

  if (!employeeId || !workplaceId) {
    return redirectWithError(req, "/settings/payroll", "payroll_link_missing_fields");
  }

  try {
    await linkEmployeeToCheck(pool, user.tenantId, employeeId, [workplaceId], user.id);
  } catch (err) {
    return redirectWithError(req, "/settings/payroll", `payroll_link_failed:${errorMessage(err)}`);
  }

  return redirectTo(req, "/settings/payroll?connected=employee_linked");
}
