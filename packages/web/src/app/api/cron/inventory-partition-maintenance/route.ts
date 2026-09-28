import { NextResponse, type NextRequest } from "next/server";
import { ensureInventoryEventPartitions } from "@alltix/scheduler";
import { getAdminPool } from "@/lib/db";

export const dynamic = "force-dynamic";
// A handful of cheap DDL checks/creates (at most monthsAhead+1 of them),
// nowhere near the order-sync cron routes' 60s ceiling -- same "declare it
// explicitly rather than relying on the platform default" discipline every
// other /api/cron/* route in this codebase already follows.
export const maxDuration = 30;

/**
 * GET /api/cron/inventory-partition-maintenance -- daily run of
 * `ensureInventoryEventPartitions` (packages/scheduler/src/index.ts),
 * keeping a real monthly range partition of `inventory_events` (migration
 * 0044_inventory_events_partitioning.sql) ready 3 months ahead of "now" at
 * all times. Migration 0044's own DEFAULT partition is a safety net for
 * whatever this job hasn't gotten to yet, not a substitute for it -- see
 * that migration's own doc comment and this function's own doc comment for
 * why an ongoing job, not just the DEFAULT partition, is the real
 * mechanism.
 *
 * Same `CRON_SECRET` Bearer-token auth, `getAdminPool()` cross-tenant/
 * schema-owning-role justification (creating a partition is DDL, which
 * `app_user`'s own least-privilege grants don't allow), and
 * idempotency-by-construction (re-running this once the current window is
 * already covered just creates zero new partitions, never an error) as
 * every other `/api/cron/*` route in this codebase.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let createdPartitions: string[];
  try {
    createdPartitions = await ensureInventoryEventPartitions(getAdminPool());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Inventory event partition maintenance cron run failed:", message);
    return NextResponse.json({ error: "partition maintenance run failed", message }, { status: 500 });
  }

  return NextResponse.json({ createdPartitions });
}
