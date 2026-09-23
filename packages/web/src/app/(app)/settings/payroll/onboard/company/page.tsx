import type { ReactElement } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { generateCompanyOnboardLink } from "@alltix/payroll-service";
import { getAppPool } from "@/lib/db";
import { getAuthContext } from "@/lib/auth-context";
import { resolveTenantId } from "@/lib/with-tenant-auth";

export const dynamic = "force-dynamic";

interface CompanyOnboardPageProps {
  searchParams: Promise<{ name?: string; title?: string; email?: string }>;
}

/**
 * Check Onboard component embedding point for a tenant's own Check Company
 * (CLAUDE.md §14.1, task #34's "wired but unverified" pass) -- the
 * "Onboard...Component embedding points" the build request named
 * explicitly.
 *
 * A plain Server Component GET page, not a client-side SDK mount --
 * consistent with this app's existing "no client-side JS for a mutation/
 * embed flow" convention (CLAUDE.md's Next.js conventions section; see
 * ChannelsSettingsPage's own forms) and with the simplest of Check's own
 * two confirmed embedding options (docs.checkhq.com/docs/embedding-a-component):
 * a raw `<iframe src="{componentLink}">`, skipping the optional
 * `component-initialize.js` CDN script + `window.CheckComponent.create()`
 * modal wrapper -- that script only adds a modal chrome/event-callback
 * layer around the exact same link this iframe already points at, and
 * isn't needed for a page whose entire purpose IS the embed (unlike, say,
 * launching it from inside a larger dashboard).
 *
 * The signer form below is a plain GET (not POST) so submitting it is just
 * a page navigation to this same route with searchParams set -- no
 * separate API route call/redirect cycle needed, and CRITICALLY it means a
 * page reload (browser refresh, or the user simply revisiting this URL) always
 * re-runs generateCompanyOnboardLink() and gets a brand-new link, which
 * Check's own docs are explicit is required ("Each page reload requires a
 * new Component URL to be generated for security purposes") -- a POST-then-
 * redirect-to-a-static-link page would tempt caching/bookmarking a link
 * that's only valid once.
 */
export default async function CompanyOnboardPage({ searchParams }: CompanyOnboardPageProps): Promise<ReactElement> {
  const authContext = await getAuthContext(await headers());
  if (!authContext) {
    redirect("/sign-in");
  }

  const pool = getAppPool();
  const tenantId = await resolveTenantId(pool, authContext.clerkUserId);
  if (!tenantId) {
    return (
      <main className="page">
        <h1>Check company onboarding</h1>
        <p>No tenant is associated with this account yet.</p>
      </main>
    );
  }

  const { name, title, email } = await searchParams;

  if (!name || !title || !email) {
    return (
      <main className="page">
        <h1>Check company onboarding</h1>
        <p className="subtitle">
          Check requires a signer&apos;s name, title, and email address to generate a Company Onboard link (collects
          your EIN, bank account via Plaid, state tax setup, and federal/state tax authorization signatures --
          CLAUDE.md §14.1). Your own company details never touch this app&apos;s database directly -- Check
          collects and stores them.
        </p>
        <form method="GET" className="stack" style={{ maxWidth: 420 }}>
          <label>
            Signer name
            <input type="text" name="name" placeholder="Jane Smith" required />
          </label>
          <label>
            Signer title
            <input type="text" name="title" placeholder="Owner" required />
          </label>
          <label>
            Signer email
            <input type="email" name="email" placeholder="jane@example.com" required />
          </label>
          <button type="submit">Launch company onboarding</button>
        </form>
        <p className="muted" style={{ marginTop: 16 }}>
          <a href="/settings/payroll">Back to Payroll settings</a>
        </p>
      </main>
    );
  }

  let componentLink: string | null = null;
  let linkError: string | null = null;
  try {
    const result = await generateCompanyOnboardLink(pool, tenantId, { name, title, email });
    componentLink = result.link;
  } catch (err) {
    linkError = err instanceof Error ? err.message : String(err);
  }

  return (
    <main className="page">
      <h1>Check company onboarding</h1>
      {linkError && (
        <div className="alert alert-danger">
          Could not generate a Check Onboard link: {linkError}. This is expected until a real, Check-verified
          sandbox API key and company exist (CLAUDE.md §14.1) -- <a href="/settings/payroll">reconnect Check</a> once
          you have one.
        </div>
      )}
      {componentLink && (
        <div className="stack">
          <p className="muted">
            This link is single-use and expires in 24 hours -- reload this page to generate a fresh one if it
            expires before you finish.
          </p>
          <iframe
            src={componentLink}
            title="Check company onboarding"
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
