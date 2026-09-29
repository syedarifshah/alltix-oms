import { Show, UserButton } from "@clerk/nextjs";
import { headers } from "next/headers";
import type { ReactElement } from "react";
import {
  DashboardIcon,
  InventoryIcon,
  OrdersIcon,
  ChannelsIcon,
  AutomationIcon,
  FulfillmentIcon,
  AnalyticsIcon,
  SettingsIcon,
  ProductsIcon,
  PeopleIcon,
  PayrollIcon,
  AdminIcon,
} from "@/components/icons";
import { getAppPool } from "@/lib/db";
import { getAuthContext } from "@/lib/auth-context";
import { requirePlatformOperator } from "@/lib/platform-operator";

/**
 * Sidebar nav for the whole authenticated app -- replaced the previous
 * single-row top nav as part of the v1 visual redesign (see
 * app/globals.css's "app shell" section and app/(app)/layout.tsx, which
 * wraps this in the new .app-shell/.app-main/.topbar structure). Every
 * route this used to link to still exists at the exact same path; this is
 * a navigation/labeling change only, not a routing change:
 *
 *   Dashboard  -> /dashboard (new page, see that route's own doc comment)
 *   Inventory  -> /inventory (unchanged)
 *   Orders     -> /orders (unchanged)
 *   Channels   -> /channels (promoted to a top-level route; /settings/channels
 *                still resolves via redirect() for any bookmarked link)
 *   Automation -> /rules (relabeled only -- same route, same rules engine)
 *   Fulfillment-> /picklists (relabeled only -- same route, same 4 sections)
 *   Analytics  -> /reports (relabeled only -- same route, same rollup data)
 *   Settings   -> /settings (new tabbed shell wrapping locations, billing,
 *                carriers, Check payroll, and activity -- see that route's
 *                own doc comment)
 *   Products/HR/Payroll -> unchanged; kept in their own second group since
 *                the reference design this redesign follows has no
 *                equivalent module for them (Arif's own instruction: keep
 *                every existing feature, only change how it looks).
 *
 * Still an async Server Component for the same reason as before (the
 * test-auth-bypass check below needs `headers()`, and rendering Clerk's
 * <Show>/<UserButton> unconditionally would throw under that bypass -- see
 * the original version of this comment, preserved here since the reasoning
 * is unchanged by the visual redesign).
 */
export async function Nav(): Promise<ReactElement> {
  const requestHeaders = await headers();
  const isTestBypass =
    process.env.NODE_ENV !== "production" &&
    process.env.ALLTIX_TEST_AUTH_BYPASS === "true" &&
    requestHeaders.has("x-test-clerk-user-id");

  // Platform-operator "Admin" link -- deliberately resolved here, in the
  // sidebar itself, rather than pushed down into a shared layout-level
  // guard: every other nav item is a plain, unconditional link, and this is
  // the one link in this whole nav that must NOT render for an ordinary
  // signed-in tenant user. lib/platform-operator.ts's own
  // requirePlatformOperator() already does the real work (parses
  // PLATFORM_OPERATOR_EMAILS, looks up the signed-in user's own row, checks
  // their email against the allowlist) -- this just calls it with the same
  // clerkUserId getAuthContext() already resolves for the test-bypass check
  // above. A signed-out visitor (no authContext) or the test-auth-bypass
  // path (no real Clerk session to resolve a DB user from) both simply see
  // no Admin link, the same "fail closed, render nothing" behavior
  // requirePlatformOperator() itself already guarantees for a non-operator.
  let isPlatformOperator = false;
  if (!isTestBypass) {
    const authContext = await getAuthContext(requestHeaders);
    if (authContext) {
      const operator = await requirePlatformOperator(getAppPool(), authContext.clerkUserId);
      isPlatformOperator = operator !== null;
    }
  }

  return (
    <aside className="sidebar">
      <a href="/dashboard" className="sidebar-brand">
        {/* eslint-disable-next-line @next/next/no-img-element -- same small,
            fixed brand mark as before (see marketing-header.tsx); not worth
            next/image config for one file. */}
        <img src="/logo-mark.png" alt="" width={22} height={24} />
        AlltixOMS
      </a>

      <nav className="sidebar-nav" aria-label="Main">
        <div className="sidebar-section-label">Operations</div>
        <SidebarLink href="/dashboard" icon={<DashboardIcon />} label="Dashboard" />
        <SidebarLink href="/inventory" icon={<InventoryIcon />} label="Inventory" />
        <SidebarLink href="/orders" icon={<OrdersIcon />} label="Orders" />
        <SidebarLink href="/channels" icon={<ChannelsIcon />} label="Channels" />
        <SidebarLink href="/rules" icon={<AutomationIcon />} label="Automation" />
        <SidebarLink href="/picklists" icon={<FulfillmentIcon />} label="Fulfillment" />
        <SidebarLink href="/reports" icon={<AnalyticsIcon />} label="Analytics" />
        <SidebarLink href="/settings" icon={<SettingsIcon />} label="Settings" />

        <div className="sidebar-section-label">Catalog &amp; team</div>
        <SidebarLink href="/products" icon={<ProductsIcon />} label="Products" />
        <SidebarLink href="/hr" icon={<PeopleIcon />} label="HR" />
        <SidebarLink href="/hr/payroll" icon={<PayrollIcon />} label="Payroll" />

        {isPlatformOperator && (
          <>
            <div className="sidebar-section-label">Platform</div>
            <SidebarLink href="/admin" icon={<AdminIcon />} label="Admin" />
          </>
        )}
      </nav>
    </aside>
  );
}

/**
 * Auth control, rendered in the top bar (see app/(app)/layout.tsx) rather
 * than the sidebar -- kept as its own small async Server Component (same
 * test-auth-bypass reasoning as Nav above, duplicated rather than shared
 * since the two live in different parts of the tree and each `headers()`
 * call is just a context read, not I/O) so the sidebar itself stays purely
 * navigational, matching where a real SaaS product usually puts account
 * controls (top-right) rather than the previous single-row nav's
 * trailing-edge placement. Used to also render a light/dark theme toggle
 * here (components/theme-toggle.tsx) -- removed as part of the gold/plum/
 * cream palette pass (CLAUDE.md §20's own follow-up), which fixed the app
 * to a single look with no toggle, per Arif's own explicit choice.
 */
export async function TopBarControls(): Promise<ReactElement> {
  const requestHeaders = await headers();
  const isTestBypass =
    process.env.NODE_ENV !== "production" &&
    process.env.ALLTIX_TEST_AUTH_BYPASS === "true" &&
    requestHeaders.has("x-test-clerk-user-id");

  return (
    <div className="row" style={{ gap: 12 }}>
      {isTestBypass ? (
        <span className="muted">test session</span>
      ) : (
        <>
          <Show when="signed-in">
            <UserButton />
          </Show>
          <Show when="signed-out">
            <a href="/sign-in">Sign in</a>
          </Show>
        </>
      )}
    </div>
  );
}

/**
 * A plain <a> styled as a sidebar row -- deliberately NOT highlighting the
 * "current page" (that would need either a client component reading
 * usePathname(), or every page passing its own route down to this Server
 * Component; neither is worth it for a visual redesign that changes no
 * behavior). The hover/active CSS states in globals.css still apply on
 * :hover; "active" here only ever means ":hover", not "current route".
 */
function SidebarLink({ href, icon, label }: { href: string; icon: ReactElement; label: string }): ReactElement {
  return (
    <a href={href} className="sidebar-link">
      {icon}
      {label}
    </a>
  );
}
