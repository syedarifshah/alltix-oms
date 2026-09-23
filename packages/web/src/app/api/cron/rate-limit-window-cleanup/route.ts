import { NextResponse, type NextRequest } from "next/server";
import { cleanupRateLimitWindows } from "@alltix/scheduler";
import { getAdminPool } from "@/lib/db";

export const dynamic = "force-dynamic";
// A single DELETE, not a per-tenant loop with external API calls -- nowhere
// near the order-sync cron routes' 60s ceiling, but declared explicitly
// anyway rather than relying on the (shorter) platform default, same "don't
// leave this implicit" discipline those routes already follow.
export const maxDuration = 30;

/**
 * GET /api/cron/rate-limit-window-cleanup -- daily sweep of expired rows
 * from BOTH `api_rate_limit_windows` (migration 0033, tenant-scoped) and
 * `public_ip_rate_limit_windows` (migration 0036, IP-scoped, for
 * `leads/demo-request`), via `cleanupRateLimitWindows`
 * (packages/scheduler/src/index.ts). Migration 0033's own comment named
 * this exact cleanup as deferred, cheap future work "once it's worth
 * writing" -- see that function's own doc comment for why it's worth
 * writing now (CLAUDE.md §16 covers every mutation route in the app, not
 * just the original nine) and for why the IP-scoped table shares this same
 * job rather than getting a second one.
 *
 * Same CRON_SECRET Bearer-token auth, `getAdminPool()` cross-tenant-
 * operation justification, and idempotency-by-construction (re-running
 * this against an already-clean table just deletes zero rows, never an
 * error) as every other /api/cron/* route in this codebase.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let deletedCount: number;
  try {
    deletedCount = await cleanupRateLimitWindows(getAdminPool());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Rate limit window cleanup cron run failed:", message);
    return NextResponse.json({ error: "cleanup run failed", message }, { status: 500 });
  }

  return NextResponse.json({ deletedCount });
}
