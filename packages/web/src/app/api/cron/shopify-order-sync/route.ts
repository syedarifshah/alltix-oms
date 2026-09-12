import { NextResponse, type NextRequest } from "next/server";
import { runShopifyOrderSyncJob, type TenantSyncResult } from "@alltix/scheduler";
import { getAppPool, getAdminPool } from "@/lib/db";

export const dynamic = "force-dynamic";
// Same 60s ceiling reasoning as api/cron/amazon-order-sync/route.ts -- the
// largest maxDuration that deploys unchanged on every current Vercel plan.
export const maxDuration = 60;

/**
 * GET /api/cron/shopify-order-sync -- the Shopify counterpart to
 * api/cron/amazon-order-sync/route.ts (see that file's doc comment for the
 * full reasoning). Same gap this closes: packages/scheduler/src/index.ts's
 * runShopifyOrderSyncJob and scripts/shopify-order-sync-{job,scheduler}.ts
 * exist, but nothing on Vercel's serverless platform ever invokes a
 * long-running node-cron process -- this route plus its `crons` entry in
 * vercel.json is the actual production trigger; the node-cron scripts stay
 * useful only for a non-serverless host that can run a long-lived process.
 *
 * A separate route (not a shared "?channel=" query param on the Amazon
 * route) for the same reason packages/scheduler keeps the two sync
 * functions parallel rather than merged -- see syncShopifyOrders's doc
 * comment: not enough shared shape yet, and each channel's own Vercel Cron
 * schedule/CRON_SECRET-gated invocation should be independently
 * inspectable in Vercel's dashboard and logs.
 *
 * Auth/idempotency: identical contract to the Amazon route -- Vercel's
 * CRON_SECRET Bearer-token mechanism, and safe to invoke more than once
 * concurrently (syncShopifyTenant reads last_order_sync_at and
 * persistPulledOrders is idempotent on (tenant_id, channel,
 * external_order_id)).
 */
export async function GET(req: NextRequest): Promise<Response> {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let results: TenantSyncResult[];
  try {
    results = await runShopifyOrderSyncJob(getAppPool(), getAdminPool());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Shopify order sync cron run failed before any tenant was synced:", message);
    return NextResponse.json({ error: "sync run failed", message }, { status: 500 });
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success);
  for (const failure of failed) {
    console.error(`Shopify order sync cron: tenant ${failure.tenantId} failed:`, failure.error);
  }

  return NextResponse.json({
    tenantsSynced: results.length,
    succeeded,
    failed: failed.length,
    insertedOrders: results.reduce((sum, r) => sum + r.insertedOrderIds.length, 0),
  });
}
