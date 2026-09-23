import type { NextRequest } from "next/server";
import { connectPayrollProcessor } from "@alltix/payroll-service";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";
import { checkRateLimit, RATE_LIMIT_ERROR_MESSAGE } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * POST /api/payroll/connect -- persists a tenant's Check API key from the
 * /settings/payroll "Connect Check" form (CLAUDE.md §14.1, task #34).
 *
 * Same "verify before persist" shape as /api/channels/walmart/connect (see
 * that route's own doc comment): connectPayrollProcessor() makes a real,
 * live call against Check's sandbox before writing anything to
 * payroll_connections, so submitting a wrong or placeholder key here
 * correctly fails rather than silently "connecting" nothing.
 *
 * UNVERIFIED IN PRACTICE, same status as WalmartConnector/TemuConnector/
 * TikTokConnector when each was first wired: this route's logic is
 * complete and typechecked, but no real Check API key exists anywhere in
 * this codebase yet -- Check has no self-serve sandbox signup (a sales
 * contact form was submitted; see CLAUDE.md §14.1), so this stays untested
 * against live Check infrastructure until that key arrives.
 *
 * Only ever accepts a sandbox key -- @alltix/payroll-service's own
 * CheckClient always targets CHECK_SANDBOX_BASE_URL for now (see its class
 * doc comment), unlike WalmartConnector's always-production connect route,
 * since no tenant here has a Check-verified production integration to
 * point at yet.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const pool = getAppPool();
  const user = await requireCurrentUser(req, pool);
  if (!user) {
    return redirectWithError(req, "/settings/payroll", "not signed in");
  }

  if (await checkRateLimit(pool, user.tenantId, "payroll.connect")) {
    return redirectWithError(req, "/settings/payroll", RATE_LIMIT_ERROR_MESSAGE);
  }

  const formData = await req.formData();
  const apiKey = String(formData.get("apiKey") ?? "").trim();

  if (!apiKey) {
    return redirectWithError(req, "/settings/payroll", "payroll_missing_api_key");
  }

  try {
    await connectPayrollProcessor(pool, user.tenantId, apiKey, user.id);
  } catch (err) {
    return redirectWithError(req, "/settings/payroll", `payroll_verify_failed:${errorMessage(err)}`);
  }

  return redirectTo(req, "/settings/payroll?connected=check");
}
