import type { Pool, PoolClient } from "pg";
import { withTenant } from "@alltix/db";

/**
 * Per-tenant, per-route API rate limiting -- CLAUDE.md §6's Security &
 * Compliance list flagged this as unaddressed: "a buggy customer
 * integration script can otherwise take the platform down." See CLAUDE.md's
 * "API Rate Limiting" section for the full design and the honest scope note
 * (this protects today's session-authenticated mutation routes, not a
 * future API-key-authenticated public API, which doesn't exist yet).
 *
 * Fixed one-minute window, backed by migration
 * 0033_api_rate_limit_windows.sql's `api_rate_limit_windows` table --
 * deliberately not a token bucket or a Redis-backed sliding window, same
 * "don't stand up infra a single self-testing tenant hasn't earned yet"
 * call this codebase already makes for BullMQ/Redis (§4.4) and Kafka (§1).
 */

const WINDOW_MS = 60_000;

/** Requests/minute/tenant/route when a caller doesn't pass its own limit --
 *  generous enough that no normal human clicking through this app's own
 *  forms should ever hit it, tight enough to stop a stuck retry loop or a
 *  runaway script well before it can meaningfully load the database. */
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;

export class RateLimitExceededError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super(`Rate limit exceeded -- retry after ${retryAfterSeconds}s`);
    this.name = "RateLimitExceededError";
  }
}

/** The single message every rate-limited route redirects back with --
 *  short, human, and generic on purpose (unlike this app's usual per-code
 *  error messages) since there's nothing route-specific the tenant can act
 *  on beyond "wait and retry." */
export const RATE_LIMIT_ERROR_MESSAGE = "Too many requests -- please wait a moment and try again.";

/** Pure -- floors `nowMs` down to the start of its containing window, so
 *  every request within the same minute maps to the same `window_start`
 *  and therefore the same table row. Exported/tested directly (see
 *  test/rate-limit.test.ts) -- same "extract the pure decision, test it
 *  directly" precedent reorder-threshold.ts and channel-flags.ts's own
 *  filterKnownChannels set. */
export function computeWindowStart(nowMs: number, windowMs: number = WINDOW_MS): number {
  return Math.floor(nowMs / windowMs) * windowMs;
}

/** Pure -- how long (rounded up, minimum 1s so a caller never sees
 *  "retry after 0 seconds") until `windowStartMs`'s window closes and a
 *  fresh one starts. */
export function computeRetryAfterSeconds(windowStartMs: number, windowMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((windowStartMs + windowMs - nowMs) / 1000));
}

/**
 * Atomically records one request against (`tenantId`, `routeKey`)'s current
 * window and throws {@link RateLimitExceededError} once `limitPerMinute` is
 * exceeded -- the INSERT ... ON CONFLICT DO UPDATE is a single round trip,
 * so two genuinely concurrent requests from the same tenant/route can't both
 * read a stale count and both slip through, the same "handle concurrency at
 * the database, not the application SELECT" discipline CLAUDE.md's own
 * allocation/transfer code (§2.2, §3) and the HR module's clock-in fix
 * (§14) already apply elsewhere.
 *
 * Takes an already-tenant-scoped `client` (an open withTenant/withTenantAuth
 * transaction) -- see {@link checkRateLimit} for the pool-level convenience
 * most callers in this codebase actually want, mirroring channel-flags.ts's
 * own isChannelEnabled/isChannelEnabledForTenant split.
 */
export async function recordRequestAndCheckRateLimit(
  client: PoolClient,
  tenantId: string,
  routeKey: string,
  limitPerMinute: number = DEFAULT_RATE_LIMIT_PER_MINUTE,
): Promise<void> {
  const now = Date.now();
  const windowStart = computeWindowStart(now);
  const result = await client.query<{ request_count: number }>(
    `INSERT INTO api_rate_limit_windows (tenant_id, route_key, window_start, request_count)
     VALUES ($1, $2, to_timestamp($3 / 1000.0), 1)
     ON CONFLICT (tenant_id, route_key, window_start)
       DO UPDATE SET request_count = api_rate_limit_windows.request_count + 1
     RETURNING request_count`,
    [tenantId, routeKey, windowStart],
  );
  const count = result.rows[0]!.request_count;
  if (count > limitPerMinute) {
    throw new RateLimitExceededError(computeRetryAfterSeconds(windowStart, WINDOW_MS, Date.now()));
  }
}

/**
 * Pool-level convenience for the ~30 mutation routes in this codebase that
 * use `requireCurrentUser` rather than `withTenantAuth` (see with-tenant-
 * auth.ts's own doc comments for why those routes don't already have an
 * open tenant-scoped client to reuse {@link recordRequestAndCheckRateLimit}
 * with directly) -- opens and closes its own short-lived `withTenant`
 * transaction, same shape as channel-flags.ts's own
 * isChannelEnabledForTenant.
 *
 * Returns the error instead of throwing it, so each caller renders its own
 * route-appropriate redirect (every route in this app already has a
 * different "back to" path -- there's no single shared response shape to
 * return here the way a JSON API could).
 */
export async function checkRateLimit(
  pool: Pool,
  tenantId: string,
  routeKey: string,
  limitPerMinute?: number,
): Promise<RateLimitExceededError | null> {
  try {
    await withTenant(pool, tenantId, (client) =>
      recordRequestAndCheckRateLimit(client, tenantId, routeKey, limitPerMinute),
    );
    return null;
  } catch (err) {
    if (err instanceof RateLimitExceededError) {
      return err;
    }
    throw err;
  }
}
