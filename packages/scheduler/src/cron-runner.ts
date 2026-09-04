import { schedule, type ScheduledTask } from "node-cron";
import type { Pool } from "pg";
import { runAmazonOrderSyncJob, type TenantSyncResult } from "./index.js";

// The "how it gets triggered" layer packages/scheduler/src/index.ts's own
// header comment flagged as separate, later infrastructure work -- this is
// that work, at the "nothing beyond local dev exists yet" stage: no Redis/
// BullMQ anywhere in this repo (checked before writing this), no
// Dockerfile/Terraform/CI-CD deploy step either, so there's no ECS
// scheduled task or EventBridge rule to hand this to yet. node-cron runs
// entirely in-process with zero external dependencies, which is the
// correct amount of infrastructure for "one process, one channel, no
// provisioned deployment target" -- BullMQ's repeatable jobs would need
// Redis, which isn't provisioned, and would be solving a distribution
// problem (multiple workers coordinating) this single-process stage
// doesn't have yet.
//
// Deliberately thin: runOnceWithRetry() and startAmazonOrderSyncScheduler()
// only decide *when* and *how many times* to call the already-sandbox-and-
// Postgres-proven runAmazonOrderSyncJob() -- none of its sync logic is
// touched or duplicated here. Swapping this file out for a real ECS
// scheduled task / EventBridge rule later means deleting this file and
// scripts/amazon-order-sync-scheduler.ts and pointing the external
// scheduler at scripts/amazon-order-sync-job.ts (the existing one-shot
// entrypoint) directly -- runAmazonOrderSyncJob() itself doesn't change.

const DEFAULT_CRON_EXPRESSION = "*/5 * * * *"; // every 5 minutes

// A per-run retry, not a per-tenant one: syncTenant() inside
// runAmazonOrderSyncJob() already catches every individual tenant's failure
// and returns it as a non-throwing result (see index.ts's syncTenant() doc
// comment), so a retry here only ever fires for a systemic failure of the
// whole pass (e.g. the admin pool's tenant-enumeration query itself
// failing) -- not for one seller's bad token, which the next scheduled
// tick will naturally retry anyway.
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 5_000;

export interface AmazonOrderSyncSchedulerOptions {
  /** The least-privilege app_user pool, passed straight through to
   *  runAmazonOrderSyncJob() -- see index.ts's SyncAmazonOrdersParams for
   *  why two separate pools exist. */
  appPool: Pool;
  /** The schema-owning pool, passed straight through -- same reasoning. */
  adminPool: Pool;
  /** Standard cron syntax (nodecron.com/cron-syntax) -- e.g. every 5
   *  minutes by default. Conservative on purpose: nothing in this codebase
   *  is rate-limit-aware yet (CLAUDE.md §4.4's real per-tenant/per-endpoint
   *  limiting doesn't exist until BullMQ replaces this), so the interval
   *  itself is the only thing currently keeping this polite to SP-API. */
  cronExpression?: string;
  timezone?: string;
  maxRetries?: number;
  retryDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeResults(results: TenantSyncResult[]) {
  return {
    tenantsProcessed: results.length,
    tenantsSucceeded: results.filter((r) => r.success).length,
    tenantsFailed: results.filter((r) => !r.success).length,
    totalOrdersInserted: results.reduce((sum, r) => sum + r.insertedOrderIds.length, 0),
    totalOrdersSkipped: results.reduce((sum, r) => sum + r.skippedExternalOrderIds.length, 0),
    tenantFailures: results.filter((r) => !r.success).map((r) => ({ tenantId: r.tenantId, error: r.error })),
  };
}

/**
 * Runs one sync pass, retrying only a systemic (whole-call) failure with a
 * short linear backoff, and logs one structured JSON line per attempt plus
 * the run's final outcome -- console.log/console.error rather than a
 * logging library, matching this codebase's existing basic-observability
 * level (CLAUDE.md §5's Datadog/Grafana+Prometheus/Sentry row is future
 * work, not wired up anywhere yet).
 */
export async function runOnceWithRetry(
  appPool: Pool,
  adminPool: Pool,
  maxRetries: number = DEFAULT_MAX_RETRIES,
  retryDelayMs: number = DEFAULT_RETRY_DELAY_MS,
): Promise<void> {
  const startedAt = Date.now();
  const runId = new Date(startedAt).toISOString();

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const results = await runAmazonOrderSyncJob(appPool, adminPool);
      console.log(
        JSON.stringify({
          event: "amazon_order_sync_run",
          runId,
          attempt,
          success: true,
          durationMs: Date.now() - startedAt,
          ...summarizeResults(results),
        }),
      );
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const willRetry = attempt <= maxRetries;
      console.error(
        JSON.stringify({
          event: "amazon_order_sync_run",
          runId,
          attempt,
          success: false,
          durationMs: Date.now() - startedAt,
          error: message,
          willRetry,
        }),
      );
      if (!willRetry) return;
      await sleep(retryDelayMs * attempt);
    }
  }
}

/**
 * Starts the recurring trigger. Returns the underlying node-cron
 * ScheduledTask so the caller (scripts/amazon-order-sync-scheduler.ts) can
 * stop() it on shutdown.
 *
 * noOverlap: true -- a full pass across every tenant could plausibly take
 * longer than the interval as tenant count grows; node-cron skips the next
 * tick instead of starting a second concurrent pass, which matters here
 * specifically because two overlapping passes could race to write the same
 * channel_connections.last_order_sync_at row for the same tenant.
 */
export function startAmazonOrderSyncScheduler(options: AmazonOrderSyncSchedulerOptions): ScheduledTask {
  const {
    appPool,
    adminPool,
    cronExpression = DEFAULT_CRON_EXPRESSION,
    timezone,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  } = options;

  const task = schedule(cronExpression, () => runOnceWithRetry(appPool, adminPool, maxRetries, retryDelayMs), {
    name: "amazon-order-sync",
    noOverlap: true,
    timezone,
  });

  task.on("execution:overlap", () => {
    console.warn(
      JSON.stringify({ event: "amazon_order_sync_skipped_overlap", at: new Date().toISOString() }),
    );
  });

  console.log(
    JSON.stringify({
      event: "amazon_order_sync_scheduler_started",
      cronExpression,
      timezone: timezone ?? "system default",
      at: new Date().toISOString(),
    }),
  );

  return task;
}
