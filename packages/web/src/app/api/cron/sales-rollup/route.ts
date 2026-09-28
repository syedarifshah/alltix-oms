import { NextResponse, type NextRequest } from "next/server";
import { rollupDailySales } from "@alltix/scheduler";
import { getAdminPool } from "@/lib/db";

export const dynamic = "force-dynamic";
// A handful of GROUP BY aggregate queries over a short trailing window
// (default 3 days, see rollupDailySales' own SALES_ROLLUP_RECOMPUTE_DAYS),
// not a full-history scan -- nowhere near the order-sync cron routes' own
// ceiling, but declared explicitly anyway, same "don't leave this implicit"
// discipline every other /api/cron/* route in this codebase already
// follows.
export const maxDuration = 30;

/**
 * GET /api/cron/sales-rollup -- daily recompute of
 * `daily_channel_sales_rollups`/`daily_product_sales_rollups` (migration
 * 0045), the pragmatic v1 CLAUDE.md §8 Phase 4 built once its own recorded
 * revisit trigger for a real CDC-fed reporting store fired (real
 * contracts, 30,000+ orders/week). See `rollupDailySales`'s own doc
 * comment (packages/scheduler/src/index.ts) for why this recomputes a
 * trailing window rather than just "yesterday," and for the honest
 * limitation on a very-late cancellation of an old order.
 *
 * Same `CRON_SECRET` Bearer-token auth, `getAdminPool()` cross-tenant
 * justification (this aggregates across every tenant in one query, and
 * `app_user` has no write grant on either rollup table at all), and
 * idempotency-by-construction (re-running this for an already-current
 * window just recomputes the same numbers, never an error) as every other
 * `/api/cron/*` route in this codebase.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await rollupDailySales(getAdminPool());
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Sales rollup cron run failed:", message);
    return NextResponse.json({ error: "sales rollup run failed", message }, { status: 500 });
  }
}
