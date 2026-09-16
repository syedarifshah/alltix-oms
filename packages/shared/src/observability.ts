import * as Sentry from "@sentry/node";

/**
 * CLAUDE.md §5/§11's observability gap, closed for the non-web half of the
 * monorepo -- packages/web has its own, separate @sentry/nextjs wiring
 * (src/instrumentation.ts / src/instrumentation-client.ts), since Next.js
 * requires Sentry's Next-specific SDK and its own file conventions (see
 * that package's own comments for why). Everything that runs as a plain
 * Node process outside of Next -- the scheduler's node-cron loop, the
 * one-shot job scripts under /scripts -- goes through this module instead,
 * which wraps the plain @sentry/node SDK.
 *
 * DSN is deliberately left unset in .env.example (SENTRY_DSN) -- same
 * "wire it now, verify against a real account later" pattern already used
 * for every channel connector's credentials in this codebase.
 * Sentry.init() with no dsn is a confirmed, safe no-op: @sentry/core's
 * client logs a debug-only warning ("No DSN provided, client will not send
 * events") and never constructs a transport, so every captureError/
 * captureAlert call below stays inert until a real DSN is configured --
 * nothing here needs to branch on "is Sentry configured".
 *
 * Scope, deliberately narrow -- this does NOT hook a generic console.error
 * interceptor (@sentry/node ships captureConsoleIntegration for exactly
 * that, and it was considered). packages/scheduler/src/index.ts's own
 * recordSyncFailure()/recordRateLimitTrip() doc comments are explicit that
 * only the "[ALERT]"-tagged lines are meant to page anyone -- the
 * per-tenant/per-run console.error calls alongside them are intentionally
 * non-alerting (a single tenant's transient failure, logged but not
 * incident-worthy until it crosses CONSECUTIVE_FAILURE_ERROR_THRESHOLD). A
 * blanket console.error->Sentry hook would silently override that
 * distinction and flood Sentry with noise on the very first transient
 * failure of any tenant, any channel. Call captureAlert()/captureError()
 * explicitly at the specific call sites that were already deliberately
 * tagged "[ALERT]" or that represent a whole job run exhausting its
 * retries -- never as a blanket log interceptor.
 */

let initialized = false;

/**
 * Initializes the Sentry Node SDK for one backend process. Idempotent --
 * safe to call at the top of every entrypoint (scripts/*-job.ts,
 * scripts/*-scheduler.ts) without tracking elsewhere whether it already
 * ran; a second call in the same process is a no-op.
 *
 * `service` is attached as a tag on every event this process reports
 * (initialScope), so a single shared Sentry project can still distinguish
 * "scheduler:ebay" from "scheduler:amazon" without needing a separate
 * DSN/project per channel.
 */
export function initObservability(service: string): void {
  if (initialized) {
    return;
  }
  initialized = true;

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
    // Conservative default -- this fires from a handful of daily cron
    // ticks, not a high-traffic web request path, so full tracing costs
    // nothing to leave on. Revisit once a real DSN/volume exists.
    tracesSampleRate: 1.0,
    initialScope: {
      tags: { service },
    },
  });
}

/**
 * Reports an incident-worthy condition that isn't (or doesn't have) a
 * JavaScript Error -- the "[ALERT]"-tagged log lines in
 * packages/scheduler/src/index.ts (a channel connection flipping to
 * status='error', a rate-limit trip) are conditions detected from data,
 * not caught exceptions. Mirrors the console.error call already sitting
 * next to each call site; this does not replace that log line, it adds a
 * Sentry event alongside it.
 */
export function captureAlert(message: string, extra?: Record<string, unknown>): void {
  Sentry.captureMessage(message, { level: "error", extra });
}

/**
 * Reports a caught exception -- used where a whole job run has exhausted
 * its retries (cron-runner.ts's runXOnceWithRetry, the `!willRetry`
 * branch) or a one-shot job script's top-level main().catch(). Not used
 * for the per-tenant/per-item errors inside a run that the run itself
 * already tolerates and continues past (see this file's header comment).
 */
export function captureError(error: unknown, extra?: Record<string, unknown>): void {
  Sentry.captureException(error, { extra });
}

/**
 * Flushes queued Sentry events before a short-lived process exits.
 * Sentry.captureException/captureMessage enqueue events for async network
 * delivery -- they do not send synchronously -- so a one-shot script
 * (scripts/*-job.ts) that calls process.exit or simply reaches the end of
 * main() right after a capture can drop the event entirely if the process
 * dies before the delivery request completes. The long-running scheduler
 * scripts don't need this (the process stays alive for the next tick
 * regardless), but every one-shot job script's top-level catch/finally
 * does. Bounded timeout so a Sentry outage can never hang a cron job
 * indefinitely -- worst case this job run's failure just doesn't reach
 * Sentry, the way it wouldn't have before this module existed either.
 */
export async function flushObservability(timeoutMs = 2000): Promise<void> {
  await Sentry.flush(timeoutMs);
}
