import { Show, UserButton } from "@clerk/nextjs";
import { headers } from "next/headers";
import type { ReactElement } from "react";

/**
 * Static top nav across every page. Amazon-only MVP (CLAUDE.md §0): no
 * Walmart/Shopify/eBay entries here on purpose.
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
      <a href="/" className="nav-brand">
        alltix-oms
      </a>
      <a href="/orders">Orders</a>
      <a href="/inventory">Inventory</a>
      <a href="/picklists">Picklists</a>
      <a href="/rules">Rules</a>
      <a href="/settings/billing">Billing</a>
      <a href="/settings/channels">Settings</a>
      <div className="nav-spacer" />
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
