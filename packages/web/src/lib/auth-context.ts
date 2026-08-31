import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";

export interface AuthContext {
  clerkUserId: string;
}

/**
 * Resolves the authenticated caller's Clerk user id for this request.
 *
 * Test-only bypass: when both `NODE_ENV !== "production"` AND the explicit
 * opt-in `ALLTIX_TEST_AUTH_BYPASS=true` are set, a request may identify
 * itself via the `x-test-clerk-user-id` header instead of a real Clerk
 * session. This exists so the tenant-isolation end-to-end test
 * (test/tenant-isolation.e2e.test.ts) can drive two distinct, concurrent,
 * *real* HTTP requests against a running Next.js server without needing live
 * Clerk credentials in CI. `next build`/`next start` force NODE_ENV to
 * "production" regardless of what's passed in, so this path is structurally
 * unreachable in a production deployment even if the env var were set by
 * mistake -- the test server must run via `next dev` instead. Never widen
 * this gate to also trust the header in production.
 */
export async function getAuthContext(req: NextRequest): Promise<AuthContext | null> {
  if (process.env.NODE_ENV !== "production" && process.env.ALLTIX_TEST_AUTH_BYPASS === "true") {
    const testUserId = req.headers.get("x-test-clerk-user-id");
    if (testUserId) {
      return { clerkUserId: testUserId };
    }
  }

  const { userId } = await auth();
  if (!userId) {
    return null;
  }
  return { clerkUserId: userId };
}
