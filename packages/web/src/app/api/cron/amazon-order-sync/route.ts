import { NextResponse, type NextRequest } from "next/server";
import { runAmazonOrderSyncJob, type TenantSyncResult } from "@alltix/scheduler";
import { getAppPool, getAdminPool } from "@/lib/db";

export const dynamic = "force-dynamic";
// Sequential per-tenant Amazon API calls (packages/scheduler/src/index.ts's
// own doc comment) can run long as tenant count grows. 60s is the largest
// value that deploys unchanged on every current Vercel plan (Hobby functions
// were raised to a 60s ceiling; Pro/Enterprise allow more) -- raise this
// once real tenant volume needs it rather than guessing ahead of it.
export const maxDuration = 60;

/**
 * GET /api/cron/amazon-order-sync -- the trigger packages/scheduler/src/
 * index.ts and scripts/amazon-order-sync-job.ts's own header comments
 * flagged as separate, later infrastructure work: "nothing in this repo
 * provisions [a recurring trigger] (no Vercel Cron config, no ECS
 * scheduled-task Terraform)." This route plus its `crons` entry in
 * vercel.json is that infrastructure -- the sync logic itself
 * (runAmazonOrderSyncJob) is untouched, this only supplies the missing
 * "invoke it on a cadence" piece that previously only existed as
 * `npm run amazon:order-sync-scheduler`, a long-running node-cron process
 * nothing was actually running on Vercel's serverless platform.
 *
 * Auth: Vercel's documented CRON_SECRET mechanism (see
 * https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs) --
 * Vercel sends `Authorization: Bearer ${CRON_SECRET}` automatically on every
 * invocation it makes; anyone else calling this path without that header
 * gets 401. CRON_SECRET must be set in the Vercel project's environment
 * variables (see .env.example) for this to work at all -- a missing secret
 * fails closed (401), never open.
 *
 * Idempotency: safe to invoke more than once concurrently or in quick
 * succession. syncTenant() (packages/scheduler/src/index.ts) reads
 * `last_order_sync_at` and only pulls orders since then, and
 * OrderService.persistPulledOrders() is itself idempotent on
 * (tenant_id, channel, external_order_id) -- a duplicate/overlapping
 * invocation re-pulls the same window and skips orders already persisted
 * rather than double-inserting them. This matters because Vercel's cron
 * delivery is best-effort and can occasionally invoke the same scheduled
 * run more than once (see the docs link above).
 */
export async function GET(req: NextRequest): Promise<Response> {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let results: TenantSyncResult[];
  try {
    results = await runAmazonOrderSyncJob(getAppPool(), getAdminPool());
  } catch (err) {
    // A failure of the enumeration query itself (see getAdminPool()'s doc
    // comment) or something else systemic -- syncTenant() already catches
    // and reports every per-tenant failure without throwing, so reaching
    // here means the whole pass never got to run, not that one tenant's
    // sync failed.
    const message = err instanceof Error ? err.message : String(err);
    console.error("Amazon order sync cron run failed before any tenant was synced:", message);
    return NextResponse.json({ error: "sync run failed", message }, { status: 500 });
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success);
  for (const failure of failed) {
    console.error(`Amazon order sync cron: tenant ${failure.tenantId} failed:`, failure.error);
  }

  return NextResponse.json({
    tenantsSynced: results.length,
    succeeded,
    failed: failed.length,
    insertedOrders: results.reduce((sum, r) => sum + r.insertedOrderIds.length, 0),
  });
}
