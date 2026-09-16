import { NextResponse, type NextRequest } from "next/server";
import { runTemuOrderSyncJob, type TenantSyncResult } from "@alltix/scheduler";
import { getAppPool, getAdminPool } from "@/lib/db";

export const dynamic = "force-dynamic";
// Same 60s ceiling reasoning as the other four cron routes -- the largest
// maxDuration that deploys unchanged on every current Vercel plan.
export const maxDuration = 60;

/**
 * GET /api/cron/temu-order-sync -- the Temu counterpart to
 * api/cron/ebay-order-sync/route.ts (see that file's doc comment for the
 * full reasoning, which applies unchanged here). Same gap this closes:
 * packages/scheduler/src/index.ts's runTemuOrderSyncJob and
 * scripts/temu-order-sync-{job,scheduler}.ts exist, but nothing on Vercel's
 * serverless platform ever invokes a long-running node-cron process -- this
 * route plus its `crons` entry in vercel.json is the actual production
 * trigger.
 *
 * A separate route from the other four, for the same reason
 * packages/scheduler keeps all five sync functions parallel rather than
 * merged -- see syncEbayOrders's doc comment.
 *
 * Auth/idempotency: identical contract to the other four cron routes --
 * Vercel's CRON_SECRET Bearer-token mechanism, and safe to invoke more than
 * once concurrently (syncTemuTenant reads last_order_sync_at and
 * persistPulledOrders is idempotent on (tenant_id, channel,
 * external_order_id)).
 *
 * UNVERIFIED IN PRACTICE, more so than any other channel's cron route --
 * every tenant this discovers (if any) will currently fail at
 * createTemuConnectorFromChannelConnection()/pullOrders() until a real
 * Temu connection exists (no Temu credentials of any kind exist anywhere
 * in this codebase yet -- see TemuConnector's own class doc comment), at
 * which point this route's own per-tenant error isolation (see
 * runTemuOrderSyncJob) means a failure here shows up as a normal `failed`
 * count in the JSON response below, not a 500.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let results: TenantSyncResult[];
  try {
    results = await runTemuOrderSyncJob(getAppPool(), getAdminPool());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Temu order sync cron run failed before any tenant was synced:", message);
    return NextResponse.json({ error: "sync run failed", message }, { status: 500 });
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success);
  for (const failure of failed) {
    console.error(`Temu order sync cron: tenant ${failure.tenantId} failed:`, failure.error);
  }

  return NextResponse.json({
    tenantsSynced: results.length,
    succeeded,
    failed: failed.length,
    insertedOrders: results.reduce((sum, r) => sum + r.insertedOrderIds.length, 0),
  });
}
