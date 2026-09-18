import { schedule, type ScheduledTask } from "node-cron";
import type { Pool } from "pg";
import { captureError } from "@alltix/shared";
import {
  runAmazonOrderSyncJob,
  runShopifyOrderSyncJob,
  runWalmartOrderSyncJob,
  runEbayOrderSyncJob,
  runTemuOrderSyncJob,
  runTikTokOrderSyncJob,
  type TenantSyncResult,
} from "./index.js";

// captureError() below is called only once a run has exhausted every retry
// (the `!willRetry` branch) -- a whole sync job failing systemically
// (DB down, every credential rejected, an unhandled bug) is a materially
// different, rarer, more urgent signal than one attempt's transient
// failure, which is expected often enough (a marketplace's momentary 503)
// that reporting every attempt would be noise. See
// packages/shared/src/observability.ts's own header comment for why this
// module doesn't use a blanket console.error->Sentry hook instead.

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
 * level. Structured logs remain the record of every attempt; a Sentry
 * event (captureError(), see the import above) additionally fires once a
 * run has exhausted its retries -- CLAUDE.md §5/§8 Phase 4's "Observability
 * dashboards" is no longer future work, see @alltix/shared's
 * observability.ts.
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
      if (!willRetry) {
        captureError(err, { event: "amazon_order_sync_run", runId, attempt });
        return;
      }
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

// -- Shopify counterparts. Kept as parallel functions, not a generic
// "startChannelOrderSyncScheduler(channel, runJob)" abstraction, for the
// same reason index.ts's syncShopifyOrders doc comment gives: not enough
// shared shape to justify it yet with only two channels wired this way,
// and each channel's own event name (amazon_order_sync_run vs.
// shopify_order_sync_run) needs to stay distinguishable in logs either way.

const DEFAULT_SHOPIFY_CRON_EXPRESSION = "*/5 * * * *"; // every 5 minutes, same conservative default as Amazon's

export interface ShopifyOrderSyncSchedulerOptions {
  appPool: Pool;
  adminPool: Pool;
  cronExpression?: string;
  timezone?: string;
  maxRetries?: number;
  retryDelayMs?: number;
}

/** Shopify counterpart to {@link runOnceWithRetry} -- see its doc comment
 *  for the retry contract (systemic-failure-only; a single tenant's
 *  failure is already caught and returned as a non-throwing result inside
 *  runShopifyOrderSyncJob's own syncShopifyTenant). */
export async function runShopifyOnceWithRetry(
  appPool: Pool,
  adminPool: Pool,
  maxRetries: number = DEFAULT_MAX_RETRIES,
  retryDelayMs: number = DEFAULT_RETRY_DELAY_MS,
): Promise<void> {
  const startedAt = Date.now();
  const runId = new Date(startedAt).toISOString();

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const results = await runShopifyOrderSyncJob(appPool, adminPool);
      console.log(
        JSON.stringify({
          event: "shopify_order_sync_run",
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
          event: "shopify_order_sync_run",
          runId,
          attempt,
          success: false,
          durationMs: Date.now() - startedAt,
          error: message,
          willRetry,
        }),
      );
      if (!willRetry) {
        captureError(err, { event: "shopify_order_sync_run", runId, attempt });
        return;
      }
      await sleep(retryDelayMs * attempt);
    }
  }
}

/** Shopify counterpart to {@link startAmazonOrderSyncScheduler} -- same
 *  noOverlap reasoning (two overlapping passes could race to write the
 *  same tenant's channel_connections.last_order_sync_at row). A separate
 *  node-cron task from Amazon's, so the two channels' polling cadences can
 *  be tuned independently and one channel's scheduler can be started
 *  without the other. */
export function startShopifyOrderSyncScheduler(options: ShopifyOrderSyncSchedulerOptions): ScheduledTask {
  const {
    appPool,
    adminPool,
    cronExpression = DEFAULT_SHOPIFY_CRON_EXPRESSION,
    timezone,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  } = options;

  const task = schedule(cronExpression, () => runShopifyOnceWithRetry(appPool, adminPool, maxRetries, retryDelayMs), {
    name: "shopify-order-sync",
    noOverlap: true,
    timezone,
  });

  task.on("execution:overlap", () => {
    console.warn(
      JSON.stringify({ event: "shopify_order_sync_skipped_overlap", at: new Date().toISOString() }),
    );
  });

  console.log(
    JSON.stringify({
      event: "shopify_order_sync_scheduler_started",
      cronExpression,
      timezone: timezone ?? "system default",
      at: new Date().toISOString(),
    }),
  );

  return task;
}

// -- Walmart counterparts. Same parallel-function call as Shopify's above --
// still not enough shared shape to justify a generic abstraction with three
// channels wired this way, and walmart_order_sync_run needs to stay its own
// distinguishable log event same as the other two.

const DEFAULT_WALMART_CRON_EXPRESSION = "*/5 * * * *"; // every 5 minutes, same conservative default as Amazon/Shopify's

export interface WalmartOrderSyncSchedulerOptions {
  appPool: Pool;
  adminPool: Pool;
  cronExpression?: string;
  timezone?: string;
  maxRetries?: number;
  retryDelayMs?: number;
}

/** Walmart counterpart to {@link runShopifyOnceWithRetry} -- see its doc
 *  comment for the retry contract (systemic-failure-only; a single tenant's
 *  failure is already caught and returned as a non-throwing result inside
 *  runWalmartOrderSyncJob's own syncWalmartTenant). */
export async function runWalmartOnceWithRetry(
  appPool: Pool,
  adminPool: Pool,
  maxRetries: number = DEFAULT_MAX_RETRIES,
  retryDelayMs: number = DEFAULT_RETRY_DELAY_MS,
): Promise<void> {
  const startedAt = Date.now();
  const runId = new Date(startedAt).toISOString();

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const results = await runWalmartOrderSyncJob(appPool, adminPool);
      console.log(
        JSON.stringify({
          event: "walmart_order_sync_run",
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
          event: "walmart_order_sync_run",
          runId,
          attempt,
          success: false,
          durationMs: Date.now() - startedAt,
          error: message,
          willRetry,
        }),
      );
      if (!willRetry) {
        captureError(err, { event: "walmart_order_sync_run", runId, attempt });
        return;
      }
      await sleep(retryDelayMs * attempt);
    }
  }
}

/** Walmart counterpart to {@link startShopifyOrderSyncScheduler} -- same
 *  noOverlap reasoning (two overlapping passes could race to write the same
 *  tenant's channel_connections.last_order_sync_at row). A separate
 *  node-cron task from Amazon's and Shopify's, so all three channels'
 *  polling cadences can be tuned independently and started/stopped on their
 *  own. */
export function startWalmartOrderSyncScheduler(options: WalmartOrderSyncSchedulerOptions): ScheduledTask {
  const {
    appPool,
    adminPool,
    cronExpression = DEFAULT_WALMART_CRON_EXPRESSION,
    timezone,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  } = options;

  const task = schedule(cronExpression, () => runWalmartOnceWithRetry(appPool, adminPool, maxRetries, retryDelayMs), {
    name: "walmart-order-sync",
    noOverlap: true,
    timezone,
  });

  task.on("execution:overlap", () => {
    console.warn(
      JSON.stringify({ event: "walmart_order_sync_skipped_overlap", at: new Date().toISOString() }),
    );
  });

  console.log(
    JSON.stringify({
      event: "walmart_order_sync_scheduler_started",
      cronExpression,
      timezone: timezone ?? "system default",
      at: new Date().toISOString(),
    }),
  );

  return task;
}

// -- eBay counterparts. Same parallel-function call as Shopify's/Walmart's
// above -- still not enough shared shape to justify a generic abstraction
// with four channels wired this way, and ebay_order_sync_run needs to stay
// its own distinguishable log event same as the other three.

const DEFAULT_EBAY_CRON_EXPRESSION = "*/5 * * * *"; // every 5 minutes, same conservative default as the other three

export interface EbayOrderSyncSchedulerOptions {
  appPool: Pool;
  adminPool: Pool;
  cronExpression?: string;
  timezone?: string;
  maxRetries?: number;
  retryDelayMs?: number;
}

/** eBay counterpart to {@link runWalmartOnceWithRetry} -- see its doc
 *  comment for the retry contract (systemic-failure-only; a single tenant's
 *  failure is already caught and returned as a non-throwing result inside
 *  runEbayOrderSyncJob's own syncEbayTenant). */
export async function runEbayOnceWithRetry(
  appPool: Pool,
  adminPool: Pool,
  maxRetries: number = DEFAULT_MAX_RETRIES,
  retryDelayMs: number = DEFAULT_RETRY_DELAY_MS,
): Promise<void> {
  const startedAt = Date.now();
  const runId = new Date(startedAt).toISOString();

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const results = await runEbayOrderSyncJob(appPool, adminPool);
      console.log(
        JSON.stringify({
          event: "ebay_order_sync_run",
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
          event: "ebay_order_sync_run",
          runId,
          attempt,
          success: false,
          durationMs: Date.now() - startedAt,
          error: message,
          willRetry,
        }),
      );
      if (!willRetry) {
        captureError(err, { event: "ebay_order_sync_run", runId, attempt });
        return;
      }
      await sleep(retryDelayMs * attempt);
    }
  }
}

/** eBay counterpart to {@link startWalmartOrderSyncScheduler} -- same
 *  noOverlap reasoning (two overlapping passes could race to write the same
 *  tenant's channel_connections.last_order_sync_at row). A separate
 *  node-cron task from the other three, so all four channels' polling
 *  cadences can be tuned independently and started/stopped on their own. */
export function startEbayOrderSyncScheduler(options: EbayOrderSyncSchedulerOptions): ScheduledTask {
  const {
    appPool,
    adminPool,
    cronExpression = DEFAULT_EBAY_CRON_EXPRESSION,
    timezone,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  } = options;

  const task = schedule(cronExpression, () => runEbayOnceWithRetry(appPool, adminPool, maxRetries, retryDelayMs), {
    name: "ebay-order-sync",
    noOverlap: true,
    timezone,
  });

  task.on("execution:overlap", () => {
    console.warn(JSON.stringify({ event: "ebay_order_sync_skipped_overlap", at: new Date().toISOString() }));
  });

  console.log(
    JSON.stringify({
      event: "ebay_order_sync_scheduler_started",
      cronExpression,
      timezone: timezone ?? "system default",
      at: new Date().toISOString(),
    }),
  );

  return task;
}

// -- Temu counterparts. Same parallel-function call as the other three
// above -- still not enough shared shape to justify a generic abstraction
// with five channels wired this way, and temu_order_sync_run needs to stay
// its own distinguishable log event same as the other four.

const DEFAULT_TEMU_CRON_EXPRESSION = "*/5 * * * *"; // every 5 minutes, same conservative default as the other four

export interface TemuOrderSyncSchedulerOptions {
  appPool: Pool;
  adminPool: Pool;
  cronExpression?: string;
  timezone?: string;
  maxRetries?: number;
  retryDelayMs?: number;
}

/** Temu counterpart to {@link runEbayOnceWithRetry} -- see its doc comment
 *  for the retry contract (systemic-failure-only; a single tenant's failure
 *  is already caught and returned as a non-throwing result inside
 *  runTemuOrderSyncJob's own syncTemuTenant). */
export async function runTemuOnceWithRetry(
  appPool: Pool,
  adminPool: Pool,
  maxRetries: number = DEFAULT_MAX_RETRIES,
  retryDelayMs: number = DEFAULT_RETRY_DELAY_MS,
): Promise<void> {
  const startedAt = Date.now();
  const runId = new Date(startedAt).toISOString();

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const results = await runTemuOrderSyncJob(appPool, adminPool);
      console.log(
        JSON.stringify({
          event: "temu_order_sync_run",
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
          event: "temu_order_sync_run",
          runId,
          attempt,
          success: false,
          durationMs: Date.now() - startedAt,
          error: message,
          willRetry,
        }),
      );
      if (!willRetry) {
        captureError(err, { event: "temu_order_sync_run", runId, attempt });
        return;
      }
      await sleep(retryDelayMs * attempt);
    }
  }
}

/** Temu counterpart to {@link startEbayOrderSyncScheduler} -- same
 *  noOverlap reasoning (two overlapping passes could race to write the same
 *  tenant's channel_connections.last_order_sync_at row). A separate
 *  node-cron task from the other four, so all five channels' polling
 *  cadences can be tuned independently and started/stopped on their own. */
export function startTemuOrderSyncScheduler(options: TemuOrderSyncSchedulerOptions): ScheduledTask {
  const {
    appPool,
    adminPool,
    cronExpression = DEFAULT_TEMU_CRON_EXPRESSION,
    timezone,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  } = options;

  const task = schedule(cronExpression, () => runTemuOnceWithRetry(appPool, adminPool, maxRetries, retryDelayMs), {
    name: "temu-order-sync",
    noOverlap: true,
    timezone,
  });

  task.on("execution:overlap", () => {
    console.warn(JSON.stringify({ event: "temu_order_sync_skipped_overlap", at: new Date().toISOString() }));
  });

  console.log(
    JSON.stringify({
      event: "temu_order_sync_scheduler_started",
      cronExpression,
      timezone: timezone ?? "system default",
      at: new Date().toISOString(),
    }),
  );

  return task;
}

// -- TikTok Shop counterparts. Same parallel-function call as the other
// five above -- still not enough shared shape to justify a generic
// abstraction with six channels wired this way, and
// tiktok_order_sync_run needs to stay its own distinguishable log event
// same as the other five.

const DEFAULT_TIKTOK_CRON_EXPRESSION = "*/5 * * * *"; // every 5 minutes, same conservative default as the other five

export interface TikTokOrderSyncSchedulerOptions {
  appPool: Pool;
  adminPool: Pool;
  cronExpression?: string;
  timezone?: string;
  maxRetries?: number;
  retryDelayMs?: number;
}

/** TikTok counterpart to {@link runTemuOnceWithRetry} -- see its doc comment
 *  for the retry contract (systemic-failure-only; a single tenant's failure
 *  is already caught and returned as a non-throwing result inside
 *  runTikTokOrderSyncJob's own syncTikTokTenant). */
export async function runTikTokOnceWithRetry(
  appPool: Pool,
  adminPool: Pool,
  maxRetries: number = DEFAULT_MAX_RETRIES,
  retryDelayMs: number = DEFAULT_RETRY_DELAY_MS,
): Promise<void> {
  const startedAt = Date.now();
  const runId = new Date(startedAt).toISOString();

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const results = await runTikTokOrderSyncJob(appPool, adminPool);
      console.log(
        JSON.stringify({
          event: "tiktok_order_sync_run",
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
          event: "tiktok_order_sync_run",
          runId,
          attempt,
          success: false,
          durationMs: Date.now() - startedAt,
          error: message,
          willRetry,
        }),
      );
      if (!willRetry) {
        captureError(err, { event: "tiktok_order_sync_run", runId, attempt });
        return;
      }
      await sleep(retryDelayMs * attempt);
    }
  }
}

/** TikTok counterpart to {@link startTemuOrderSyncScheduler} -- same
 *  noOverlap reasoning (two overlapping passes could race to write the same
 *  tenant's channel_connections.last_order_sync_at row). A separate
 *  node-cron task from the other five, so all six channels' polling
 *  cadences can be tuned independently and started/stopped on their own. */
export function startTikTokOrderSyncScheduler(options: TikTokOrderSyncSchedulerOptions): ScheduledTask {
  const {
    appPool,
    adminPool,
    cronExpression = DEFAULT_TIKTOK_CRON_EXPRESSION,
    timezone,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  } = options;

  const task = schedule(cronExpression, () => runTikTokOnceWithRetry(appPool, adminPool, maxRetries, retryDelayMs), {
    name: "tiktok-order-sync",
    noOverlap: true,
    timezone,
  });

  task.on("execution:overlap", () => {
    console.warn(JSON.stringify({ event: "tiktok_order_sync_skipped_overlap", at: new Date().toISOString() }));
  });

  console.log(
    JSON.stringify({
      event: "tiktok_order_sync_scheduler_started",
      cronExpression,
      timezone: timezone ?? "system default",
      at: new Date().toISOString(),
    }),
  );

  return task;
}
