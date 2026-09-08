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
const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/webhooks(.*)",
  "/api/health",
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
  // a signed-out visit to www.alltixoms.com landed straight on the Clerk
  // sign-in wall instead of a real marketing page. The dashboard itself
  // stays fully gated -- only these four public-facing routes are exempt.
  "/",
  "/why-alltixoms",
  "/pricing",
  "/book-a-demo",
  // "Book a Demo" lead-capture endpoint (src/app/api/leads/demo-request) --
  // submitted by anonymous prospects who don't have a Clerk session at all.
  "/api/leads(.*)",
]);

// clerkGuard validates the publishable/secret key format on *every*
// invocation, unconditionally, before it even looks at isPublicRoute -- so a
// public route (health check, sign-in/up pages, the Clerk webhook) must
// never be routed into it at all, not just exempted from auth.protect(),
// or it 500s even for genuinely public requests whenever Clerk isn't
// configured with real keys (e.g. this app's e2e test).
const clerkGuard = clerkMiddleware(async (auth) => {
  await auth.protect();
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
  if (isPublicRoute(req) || isTestBypass(req)) {
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
