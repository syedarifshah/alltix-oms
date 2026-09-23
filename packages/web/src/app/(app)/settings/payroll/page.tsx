import type { ReactElement } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { withTenant } from "@alltix/db";
import { getPayrollConnection, getCompanyOnboardStatus } from "@alltix/payroll-service";
import { getAppPool } from "@/lib/db";
import { getAuthContext } from "@/lib/auth-context";
import { resolveTenantId } from "@/lib/with-tenant-auth";

export const dynamic = "force-dynamic";

interface PayrollSettingsPageProps {
  searchParams: Promise<{ connected?: string; error?: string }>;
}

interface EmployeeLinkRow {
  id: string;
  name: string;
  role: string;
  check_employee_id: string | null;
}

/**
 * /settings/payroll -- the real Check payroll-processor integration
 * (CLAUDE.md §14.1, task #34), built speculatively ("wired but unverified")
 * against Check's documented API shape, same style Walmart/eBay/Temu/
 * TikTok's own settings sections were each built ahead of real
 * credentials -- see ChannelsSettingsPage's own subtitle for that
 * established precedent, and @alltix/payroll-service's own class doc
 * comment for exactly which parts of Check's API were CONFIRMED by a
 * direct fetch this pass vs INFERRED by symmetry with a confirmed sibling.
 *
 * Separate from /settings/channels -- Check is not a sales channel
 * (payroll_connections is its own table, migration 0038, not a
 * channel_connections row) and separate from /hr/payroll (CLAUDE.md §14
 * task #33's existing gross-wage-calculation view, which stays read-only
 * and untouched by this pass) -- this page is where money actually moves,
 * that one is where hours get reviewed first.
 */
export default async function PayrollSettingsPage({ searchParams }: PayrollSettingsPageProps): Promise<ReactElement> {
  const authContext = await getAuthContext(await headers());
  if (!authContext) {
    redirect("/sign-in");
  }

  const pool = getAppPool();
  const tenantId = await resolveTenantId(pool, authContext.clerkUserId);
  const { connected, error } = await searchParams;

  if (!tenantId) {
    return (
      <main className="page">
        <h1>Payroll</h1>
        <p>No tenant is associated with this account yet.</p>
      </main>
    );
  }

  const connection = await getPayrollConnection(pool, tenantId);
  const isConnected = connection?.status === "active";
  const hasCompany = Boolean(connection?.checkCompanyId);

  // Only attempted once a Check company actually exists -- same "don't
  // make a live vendor call this page doesn't need yet" discipline
  // ChannelsSettingsPage's own eBay business-policies fetch follows.
  const onboardStatus = hasCompany ? await getCompanyOnboardStatus(pool, tenantId) : null;

  const employees = hasCompany
    ? await withTenant(pool, tenantId, (client) =>
        client
          .query<EmployeeLinkRow>(
            `SELECT id, name, role, check_employee_id FROM employees WHERE status = 'active' ORDER BY name`,
          )
          .then((r) => r.rows),
      )
    : [];
  const unlinkedEmployees = employees.filter((e) => !e.check_employee_id);
  const linkedEmployees = employees.filter((e) => e.check_employee_id);

  return (
    <main className="page">
      <h1>Payroll</h1>
      <p className="subtitle">
        Real payroll processing via Check (CLAUDE.md §0/§14.1) -- tax withholding, filings, and money movement,
        handled entirely inside Check&apos;s own hosted Components. Wiring is complete but UNVERIFIED against real
        Check infrastructure: no self-serve sandbox exists (a sales contact form was submitted -- see CLAUDE.md
        §14.1), so nothing below has round-tripped against sandbox.checkhq.com yet. Connecting will correctly fail
        here until a real API key exists.
      </p>

      {connected === "check" && <div className="alert alert-success">Check connected.</div>}
      {connected === "check_company" && <div className="alert alert-success">Check company created.</div>}
      {connected === "employee_linked" && <div className="alert alert-success">Employee linked to Check.</div>}
      {error?.startsWith("payroll_verify_failed") && (
        <div className="alert alert-danger">Connecting Check failed ({error}).</div>
      )}
      {error?.startsWith("payroll_company_create_failed") && (
        <div className="alert alert-danger">Creating the Check company failed ({error}).</div>
      )}
      {error?.startsWith("payroll_link_failed") && (
        <div className="alert alert-danger">Linking that employee to Check failed ({error}).</div>
      )}
      {error &&
        !error.startsWith("payroll_verify_failed") &&
        !error.startsWith("payroll_company_create_failed") &&
        !error.startsWith("payroll_link_failed") && <div className="alert alert-danger">{error}</div>}

      <h2>Check connection</h2>
      <div className="card">
        {connection ? (
          <div className="stack">
            <div className="row">
              <span className={isConnected ? "badge badge-success" : "badge badge-danger"}>{connection.status}</span>
              {connection.checkCompanyId && <span className="muted">company {connection.checkCompanyId}</span>}
            </div>
            <div className="muted">Connected since {new Date(connection.createdAt).toISOString()}</div>
            <form action="/api/payroll/connect" method="POST" className="stack" style={{ marginTop: 8 }}>
              <label>
                Sandbox API key (rotate/reconnect)
                <input type="password" name="apiKey" placeholder="Check sandbox API key" required />
              </label>
              <button type="submit">Reconnect Check</button>
            </form>
          </div>
        ) : (
          <form action="/api/payroll/connect" method="POST" className="stack" style={{ maxWidth: 420 }}>
            <p className="muted">
              No self-serve signup exists for Check -- request a sandbox key via checkhq.com&apos;s &quot;Get in
              touch&quot; contact form, then paste it here.
            </p>
            <label>
              Sandbox API key
              <input type="password" name="apiKey" placeholder="Check sandbox API key" required />
            </label>
            <button type="submit">Connect Check</button>
          </form>
        )}
      </div>

      {isConnected && !hasCompany && (
        <>
          <h2>Create your Check company</h2>
          <div className="card">
            <form action="/api/payroll/company/create" method="POST" className="stack" style={{ maxWidth: 480 }}>
              <label>
                Legal company name
                <input type="text" name="legalName" placeholder="Alltix Fulfillment LLC" required />
              </label>
              <label>
                Business type
                <select name="businessType" required defaultValue="">
                  <option value="" disabled>
                    Select a business type
                  </option>
                  <option value="llc">LLC</option>
                  <option value="sole_proprietorship">Sole proprietorship</option>
                  <option value="partnership">Partnership</option>
                  <option value="c_corporation">C corporation</option>
                  <option value="s_corporation">S corporation</option>
                </select>
              </label>
              <label>
                Trade name (optional)
                <input type="text" name="tradeName" placeholder="Alltix" />
              </label>
              <label>
                Payroll department email (optional)
                <input type="email" name="email" placeholder="payroll@example.com" />
              </label>
              <label>
                Payroll department phone (optional)
                <input type="text" name="phone" placeholder="+1 555 555 5555" />
              </label>
              <label>
                Pay frequency (optional)
                <select name="payFrequency" defaultValue="">
                  <option value="">Not set yet</option>
                  <option value="weekly">Weekly</option>
                  <option value="biweekly">Biweekly</option>
                  <option value="semimonthly">Semimonthly</option>
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                  <option value="annually">Annually</option>
                </select>
              </label>
              <button type="submit">Create Check company</button>
            </form>
          </div>
        </>
      )}

      {hasCompany && (
        <>
          <h2>Company onboarding</h2>
          <div className="card">
            {onboardStatus ? (
              <div className="stack">
                <div className="row">
                  <span
                    className={
                      onboardStatus.status === "completed"
                        ? "badge badge-success"
                        : onboardStatus.status === "blocking"
                          ? "badge badge-danger"
                          : "badge"
                    }
                  >
                    {onboardStatus.status}
                  </span>
                </div>
                {onboardStatus.remainingSteps.length > 0 && (
                  <div className="muted">Remaining steps: {onboardStatus.remainingSteps.join(", ")}</div>
                )}
              </div>
            ) : (
              <p className="muted">
                Onboard status could not be read from Check yet (expected until a real sandbox company exists).
              </p>
            )}
            <p style={{ marginTop: 8 }}>
              <a href="/settings/payroll/onboard/company">Launch company onboarding →</a>
            </p>
          </div>

          <h2>Run payroll</h2>
          <div className="card">
            <p className="muted">
              Requires at least one employee linked and onboarded below, a pay schedule set up in Check, and
              company onboarding marked &quot;completed&quot; above.
            </p>
            <p>
              <a href="/settings/payroll/run">Launch Run Payroll →</a>
            </p>
          </div>

          <h2>Employees</h2>
          <div className="card">
            {linkedEmployees.length > 0 && (
              <div className="stack" style={{ marginBottom: 16 }}>
                <h3>Linked to Check</h3>
                {linkedEmployees.map((e) => (
                  <div key={e.id} className="row">
                    <span>
                      {e.name} ({e.role})
                    </span>
                    <span className="muted">check employee {e.check_employee_id}</span>
                    <a href={`/settings/payroll/onboard/employee/${e.id}`}>Launch onboarding →</a>
                  </div>
                ))}
              </div>
            )}

            <h3>Not yet linked</h3>
            {unlinkedEmployees.length === 0 ? (
              <p className="empty">Every active employee is already linked to Check.</p>
            ) : (
              unlinkedEmployees.map((e) => (
                <form
                  key={e.id}
                  action="/api/payroll/employees/link"
                  method="POST"
                  className="row"
                  style={{ gap: 8, marginBottom: 8 }}
                >
                  <input type="hidden" name="employeeId" value={e.id} />
                  <span style={{ minWidth: 160 }}>
                    {e.name} ({e.role})
                  </span>
                  <input type="text" name="workplaceId" placeholder="Check workplace id" required />
                  <button type="submit">Link to Check</button>
                </form>
              ))
            )}
            <p className="muted" style={{ marginTop: 8 }}>
              Check Workplace resources aren&apos;t managed from this UI yet -- create one in Check&apos;s own
              Dashboard (or via the API) and paste its id above. See{" "}
              <a href="/hr">/hr</a> for the employee directory itself.
            </p>
          </div>
        </>
      )}
    </main>
  );
}
