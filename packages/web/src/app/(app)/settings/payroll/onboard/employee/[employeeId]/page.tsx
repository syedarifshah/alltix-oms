import type { ReactElement } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { generateEmployeeOnboardLink } from "@alltix/payroll-service";
import { getAppPool } from "@/lib/db";
import { getAuthContext } from "@/lib/auth-context";
import { resolveTenantId } from "@/lib/with-tenant-auth";

export const dynamic = "force-dynamic";

interface EmployeeOnboardPageProps {
  params: Promise<{ employeeId: string }>;
}

/**
 * Check Employee Onboard component embedding point (CLAUDE.md §14.1, task
 * #34) -- collects a worker's own payment method, SSN/ITIN, W-4, and bank
 * account for direct deposit, entirely inside Check's own hosted flow
 * (raw SSN never touches this app -- only `ssn_last_four` comes back via
 * the Check API afterward, per CONFIRMED docs.checkhq.com/reference/create-an-employee).
 *
 * Same "plain iframe, fresh link every page load, no client SDK needed"
 * shape as the company onboard page (see that page's own doc comment for
 * the full reasoning) -- unlike that page, no signer form step first:
 * CONFIRMED (docs.checkhq.com/docs/check-onboard) an employee/contractor
 * onboard link needs no name/email at generation time, since the Check
 * Employee resource this links to (employees.check_employee_id, set by
 * linkEmployeeToCheck()) already carries that.
 *
 * Reached only for an employee already linked via
 * /api/payroll/employees/link -- generateEmployeeOnboardLink() itself
 * throws a clear error otherwise, surfaced below rather than this page
 * pre-checking and duplicating that same guard.
 */
export default async function EmployeeOnboardPage({ params }: EmployeeOnboardPageProps): Promise<ReactElement> {
  const authContext = await getAuthContext(await headers());
  if (!authContext) {
    redirect("/sign-in");
  }

  const pool = getAppPool();
  const tenantId = await resolveTenantId(pool, authContext.clerkUserId);
  const { employeeId } = await params;

  if (!tenantId) {
    return (
      <main className="page">
        <h1>Employee Check onboarding</h1>
        <p>No tenant is associated with this account yet.</p>
      </main>
    );
  }

  let componentLink: string | null = null;
  let linkError: string | null = null;
  try {
    const result = await generateEmployeeOnboardLink(pool, tenantId, employeeId);
    componentLink = result.link;
  } catch (err) {
    linkError = err instanceof Error ? err.message : String(err);
  }

  return (
    <main className="page">
      <h1>Employee Check onboarding</h1>
      {linkError && (
        <div className="alert alert-danger">
          Could not generate a Check Onboard link for this employee: {linkError}. This is expected until a real,
          Check-verified sandbox integration exists (CLAUDE.md §14.1) -- see{" "}
          <a href="/settings/payroll">Payroll settings</a>.
        </div>
      )}
      {componentLink && (
        <div className="stack">
          <p className="muted">
            This link is single-use and expires in 24 hours -- reload this page to generate a fresh one if it
            expires before this employee finishes.
          </p>
          <iframe
            src={componentLink}
            title="Employee Check onboarding"
            allow="clipboard-write; fullscreen; camera; microphone"
            style={{ width: "100%", height: "80vh", border: "1px solid var(--border)", borderRadius: 8 }}
          />
        </div>
      )}
      <p className="muted" style={{ marginTop: 16 }}>
        <a href="/settings/payroll">Back to Payroll settings</a>
      </p>
    </main>
  );
}
