import { Show, UserButton } from "@clerk/nextjs";
import { headers } from "next/headers";
import type { ReactElement } from "react";
import { ThemeToggle } from "@/components/theme-toggle";

/**
 * Static top nav across every page. Channel connectors (Amazon, Shopify)
 * still don't get their own nav entries -- they're configured from
 * /settings/channels, not a dedicated per-channel page -- but /products now
 * does (added alongside outbound Shopify listing creation) since it's a
 * page in its own right, not a channel settings screen.
 *
 * An async Server Component (not just a static one) so it can check the
 * same test-auth-bypass condition src/lib/auth-context.ts and src/proxy.ts
 * already gate on. That's not optional here: proxy.ts's isTestBypass skips
 * clerkMiddleware() entirely for a bypass request, and Clerk's own
 * <Show>/<UserButton> unconditionally assume clerkMiddleware() ran --
 * rendering them anyway throws "auth() was called but Clerk can't detect
 * usage of clerkMiddleware()" for *every* page in the tree, since Nav sits
 * in the root layout. This isn't a hypothetical: it's exactly the failure
 * mode a bypass-driven page-level test (as opposed to the existing
 * API-route-only e2e suite) hits immediately.
 */
export async function Nav(): Promise<ReactElement> {
  const requestHeaders = await headers();
  const isTestBypass =
    process.env.NODE_ENV !== "production" &&
    process.env.ALLTIX_TEST_AUTH_BYPASS === "true" &&
    requestHeaders.has("x-test-clerk-user-id");

  return (
    <nav className="nav">
      {/* "/" is now the public marketing home (src/app/(marketing)), not
          part of the authenticated app -- the brand link here goes to
          /orders instead so it stays inside the dashboard a signed-in user
          is already in, rather than bouncing them out to the marketing
          site. */}
      <a href="/orders" className="nav-brand">
        {/* eslint-disable-next-line @next/next/no-img-element -- same small,
            fixed brand mark as the marketing header/footer (see
            marketing-header.tsx); not worth next/image config for one file. */}
        <img src="/logo-mark.png" alt="" width={22} height={24} />
        AlltixOMS
      </a>
      <a href="/orders">Orders</a>
      <a href="/inventory">Inventory</a>
      <a href="/locations">Locations</a>
      <a href="/products">Products</a>
      <a href="/picklists">Picklists</a>
      <a href="/rules">Rules</a>
      <a href="/hr">HR</a>
      <a href="/hr/payroll">Payroll</a>
      <a href="/reports">Reports</a>
      <a href="/settings/billing">Billing</a>
      <a href="/settings/channels">Settings</a>
      {/* New Carrier Integration layer (Royal Mail, task #59) -- separate
          nav entry from "Settings" (which is /settings/channels, sales
          channels only) since a carrier is a structurally different kind
          of connection -- see settings/carriers/page.tsx's own doc
          comment. */}
      <a href="/settings/carriers">Carriers</a>
      {/* Real Check payroll-processor integration (CLAUDE.md §14.1, task
          #34) -- deliberately a separate nav entry from "/hr/payroll" above
          (task #33's existing gross-wage-calculation view): that one is a
          read-only report over tracked hours, this one is where money
          actually moves through Check's own hosted Components. See
          settings/payroll/page.tsx's own doc comment for the full split. */}
      <a href="/settings/payroll">Check Payroll</a>
      <a href="/settings/activity">Activity</a>
      <div className="nav-spacer" />
      <ThemeToggle />
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
    </nav>
  );
}
