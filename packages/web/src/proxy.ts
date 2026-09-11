import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";

// This file uses Next's current "Proxy" file convention (the renamed,
// non-deprecated successor to middleware.ts -- see
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md).
// As of this Next.js version, Proxy defaults to the Node.js runtime, so it
// *can* reach Postgres. It still only gates identity here, though: it and
// each route handler are separate invocations with no way to hand a live
// `pg` transaction between them, so the actual per-request work described in
// the project's tenant-isolation requirements -- resolving tenant_id and
// running `SET LOCAL app.tenant_id` inside a transaction before any query --
// has to wrap the handler itself. That's `withTenantAuth` in
// src/lib/with-tenant-auth.ts, applied to every route under src/app/api.
// Treat that wrapper as the real "auth + tenant middleware" for API
// requests; this file is only the identity gate in front of it.

// PAGE routes that must stay reachable without signing in. Critically, these
// still go THROUGH clerkGuard below (unlike isClerkExemptRoute) -- every page
// renders inside the root layout's <ClerkProvider>, which calls Clerk's own
// auth() internally to resolve initial auth state for hydration, and auth()
// throws "auth() was called but Clerk can't detect usage of clerkMiddleware()"
// for ANY request that never went through clerkMiddleware(), even when the
// page itself never calls auth(). That's exactly what broke the production
// site after "/" was added here and given a hard bypass (NextResponse.next()
// before clerkGuard ever ran) -- production logs showed a 500 on every GET /
// with that precise Clerk error. The fix is Clerk's own recommended pattern:
// run clerkMiddleware() for every page, and only call auth.protect()
// conditionally (see clerkGuard below) instead of skipping the middleware.
const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  // Legal pages must be reachable without signing in -- Google's OAuth
  // consent screen links to these directly (Branding page requires a
  // Privacy Policy / Terms of Service URL before the app can be published
  // out of Testing mode), and a logged-out visitor should be able to read
  // them before ever creating an account.
  "/privacy",
  "/terms",
  // Public marketing site (src/app/(marketing)) -- Home, Why AlltixOMS,
  // Pricing, Book a Demo. "/" used to be gated (it fell through to
  // clerkGuard's auth.protect() like any other route), which is exactly why
  // a signed-out visit to the site landed straight on the Clerk sign-in wall
  // instead of a real marketing page. The dashboard itself stays fully
  // gated -- only these routes are exempt from auth.protect().
  "/",
  "/why-alltixoms",
  "/pricing",
  "/book-a-demo",
]);

// Routes that must never even invoke clerkGuard -- clerkGuard validates the
// publishable/secret key format on *every* invocation, unconditionally,
// before it even runs the handler, so anything that (a) needs to work
// without real Clerk keys (health check, this app's e2e test bypass covers
// the rest) or (b) is a route handler with no page/ClerkProvider anywhere in
// its response -- true of all three below -- belongs here instead of on
// isPublicRoute, or it 500s whenever Clerk isn't configured with real keys.
const isClerkExemptRoute = createRouteMatcher([
  "/api/webhooks(.*)",
  "/api/health",
  // "Book a Demo" lead-capture endpoint (src/app/api/leads/demo-request) --
  // submitted by anonymous prospects who don't have a Clerk session at all.
  "/api/leads(.*)",
  // Vercel Cron invocation (src/app/api/cron/amazon-order-sync) -- carries
  // no Clerk session at all (it's Vercel's own scheduler calling in, not a
  // signed-in user), and has its own separate auth via the CRON_SECRET
  // bearer token the route checks itself. Without this exemption,
  // clerkGuard's auth.protect() 404s every invocation before the route
  // handler ever runs -- Clerk's documented behavior for a failed
  // auth.protect() on a non-page request is a 404, not a redirect, which is
  // exactly the "Status: 404" Vercel's own cron logs showed here: this
  // route was reachable and correctly deployed, clerkGuard just never let
  // Vercel's cron caller reach it.
  "/api/cron(.*)",
]);

const clerkGuard = clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

/**
 * Test-only escape hatch: when both `NODE_ENV !== "production"` AND the
 * explicit opt-in `ALLTIX_TEST_AUTH_BYPASS=true` are set, a request carrying
 * `x-test-clerk-user-id` skips Clerk entirely, the same way a public route
 * does, since the e2e test intentionally runs without live Clerk
 * credentials. Mirrors the same gate used in src/lib/auth-context.ts; never
 * widen either one to trust this header in production. `next build`/`next
 * start` force NODE_ENV to "production" regardless of what's configured, so
 * this is structurally unreachable in a deployed build even if the env var
 * were set by mistake.
 */
function isTestBypass(req: NextRequest): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.ALLTIX_TEST_AUTH_BYPASS === "true" &&
    req.headers.has("x-test-clerk-user-id")
  );
}

export default function proxy(...args: Parameters<typeof clerkGuard>): ReturnType<typeof clerkGuard> {
  const [req] = args;
  if (isClerkExemptRoute(req) || isTestBypass(req)) {
    return NextResponse.next() as ReturnType<typeof clerkGuard>;
  }
  return clerkGuard(...args);
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip)).*)",
    "/(api|trpc)(.*)",
  ],
};