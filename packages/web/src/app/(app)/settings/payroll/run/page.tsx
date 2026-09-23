import type { ReactElement } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { generateRunPayrollLink } from "@alltix/payroll-service";
import { getAppPool } from "@/lib/db";
import { getAuthContext } from "@/lib/auth-context";
import { resolveTenantId } from "@/lib/with-tenant-auth";

export const dynamic = "force-dynamic";

interface RunPayrollPageProps {
  searchParams: Promise<{ payroll?: string }>;
}

/**
 * Run Payroll component embedding point (CLAUDE.md §14.1, task #34) --
 * CONFIRMED endpoint (docs.checkhq.com/reference/run-payroll:
 * `POST /companies/{company}/components/run_payroll`), the one component
 * type this whole pass confirmed directly rather than inferring by
 * symmetry (see @alltix/payroll-service's own CheckComponentType doc
 * comment).
 *
 * time_entries (migration 0028) stays the system of record for hours
 * worked -- this page is deliberately reached FROM /hr/payroll (the
 * existing gross-wage-calculation view, CLAUDE.md §14 task #33), not the
 * other way around: a tenant reviews hours × rate there first, then comes
 * here to actually run pay through Check. Nothing in this app pushes hours
 * into Check automatically -- CONFIRMED prerequisites
 * (docs.checkhq.com/reference/run-payroll) are that the company already has
 * at least one employee/contractor, a pay schedule, and completed onboard
 * status; entering actual pay amounts happens inside the Component itself,
 * live-previewed against Check's own tax engine, not computed by this app.
 *
 * `?payroll=` (optional) launches the Component in edit-view mode for an
 * already-started payroll -- CONFIRMED optional query param, same page.
 * Same "plain iframe, fresh link every load" shape as the two onboard
 * pages -- see the company onboard page's own doc comment for the full
 * reasoning.
 */
export default async function RunPayrollPage({ searchParams }: RunPayrollPageProps): Promise<ReactElement> {
  const authContext = await getAuthContext(await headers());
  if (!authContext) {
    redirect("/sign-in");
  }

  const pool = getAppPool();
  const tenantId = await resolveTenantId(pool, authContext.clerkUserId);
  const { payroll } = await searchParams;

  if (!tenantId) {
    return (
      <main className="page">
        <h1>Run payroll</h1>
        <p>No tenant is associated with this account yet.</p>
      </main>
    );
  }

  let componentLink: string | null = null;
  let linkError: string | null = null;
  try {
    const result = await generateRunPayrollLink(pool, tenantId, payroll);
    componentLink = result.link;
  } catch (err) {
    linkError = err instanceof Error ? err.message : String(err);
  }

  return (
    <main className="page">
      <h1>Run payroll</h1>
      <p className="subtitle">
        Set up worker pay, add earnings, and preview a payroll run through Check&apos;s own hosted Component -- see{" "}
        <a href="/hr/payroll">/hr/payroll</a> for tracked hours and gross-wage totals first.
      </p>
      {linkError && (
        <div className="alert alert-danger">
          Could not generate a Run Payroll link: {linkError}. This is expected until a real, Check-verified sandbox
          integration exists with at least one employee, a pay schedule, and completed company onboarding
          (CLAUDE.md §14.1) -- see <a href="/settings/payroll">Payroll settings</a>.
        </div>
      )}
      {componentLink && (
        <div className="stack">
          <p className="muted">
            This link is single-use and expires in 24 hours -- reload this page to generate a fresh one.
          </p>
          <iframe
            src={componentLink}
            title="Run payroll"
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
