import type { NextRequest } from "next/server";
import { createCheckCompanyForTenant, type CheckCompanyParams } from "@alltix/payroll-service";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";
import { checkRateLimit, RATE_LIMIT_ERROR_MESSAGE } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const VALID_BUSINESS_TYPES: ReadonlySet<string> = new Set([
  "sole_proprietorship",
  "partnership",
  "c_corporation",
  "s_corporation",
  "llc",
]);

const VALID_PAY_FREQUENCIES: ReadonlySet<string> = new Set([
  "weekly",
  "biweekly",
  "semimonthly",
  "monthly",
  "quarterly",
  "annually",
]);

/**
 * POST /api/payroll/company/create -- creates the Check Company resource
 * for a tenant that's already connected a Check API key
 * (createCheckCompanyForTenant, CONFIRMED shape:
 * `POST https://sandbox.checkhq.com/companies` -- see @alltix/payroll-service's
 * own doc comments). The second of the two connect-time steps CLAUDE.md
 * §14.1 calls out (an API key alone authenticates but doesn't say who this
 * tenant IS to Check).
 *
 * UNVERIFIED IN PRACTICE -- same status as every route in
 * packages/web/src/app/api/payroll: complete and typechecked, never
 * round-tripped against a real Check company, for the same "no real Check
 * credentials yet" reason /api/payroll/connect's own doc comment gives.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const pool = getAppPool();
  const user = await requireCurrentUser(req, pool);
  if (!user) {
    return redirectWithError(req, "/settings/payroll", "not signed in");
  }

  if (await checkRateLimit(pool, user.tenantId, "payroll.company.create")) {
    return redirectWithError(req, "/settings/payroll", RATE_LIMIT_ERROR_MESSAGE);
  }

  const formData = await req.formData();
  const legalName = String(formData.get("legalName") ?? "").trim();
  const businessType = String(formData.get("businessType") ?? "").trim();
  const tradeName = String(formData.get("tradeName") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  const payFrequency = String(formData.get("payFrequency") ?? "").trim();

  if (!legalName || !VALID_BUSINESS_TYPES.has(businessType)) {
    return redirectWithError(req, "/settings/payroll", "payroll_company_missing_fields");
  }

  const params: CheckCompanyParams = {
    legalName,
    businessType: businessType as CheckCompanyParams["businessType"],
    tradeName: tradeName || undefined,
    email: email || undefined,
    phone: phone || undefined,
    payFrequency: VALID_PAY_FREQUENCIES.has(payFrequency) ? (payFrequency as CheckCompanyParams["payFrequency"]) : undefined,
  };

  try {
    await createCheckCompanyForTenant(pool, user.tenantId, params, user.id);
  } catch (err) {
    return redirectWithError(req, "/settings/payroll", `payroll_company_create_failed:${errorMessage(err)}`);
  }

  return redirectTo(req, "/settings/payroll?connected=check_company");
}
