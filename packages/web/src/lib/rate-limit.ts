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

/**
 * IP-scoped counterpart to {@link checkRateLimit}/{@link recordRequestAndCheckRateLimit}
 * -- for `leads/demo-request`, this app's one real public, unauthenticated
 * mutation route (CLAUDE.md §16's own "fourth pass" note flagged it as a
 * real, still-open gap: there's no `tenantId` to key a window by for an
 * anonymous visitor, so it needs a structurally different table --
 * migration 0036_public_ip_rate_limit_windows.sql -- and a structurally
 * different limit, not a reuse of `DEFAULT_RATE_LIMIT_PER_MINUTE`).
 *
 * No `withTenant()` wrapper -- unlike every tenant-scoped table in this
 * schema, `public_ip_rate_limit_windows` has no `app.tenant_id` to `SET
 * LOCAL`, and its own RLS policy is `USING (true)` (see that migration's own
 * comment) precisely because there's no tenant to scope by, so a plain
 * pool-level query is correct here, not a narrower version of
 * `checkRateLimit` -- same "no withTenant/withClerkUser, direct app_user
 * query" shape `leads/demo-request`'s own `demo_requests` INSERT already
 * uses for the identical reason.
 */
export async function checkIpRateLimit(
  pool: Pool,
  ipAddress: string,
  routeKey: string,
  limitPerMinute: number = DEFAULT_PUBLIC_RATE_LIMIT_PER_MINUTE,
): Promise<RateLimitExceededError | null> {
  const now = Date.now();
  const windowStart = computeWindowStart(now);
  const result = await pool.query<{ request_count: number }>(
    `INSERT INTO public_ip_rate_limit_windows (ip_address, route_key, window_start, request_count)
     VALUES ($1, $2, to_timestamp($3 / 1000.0), 1)
     ON CONFLICT (ip_address, route_key, window_start)
       DO UPDATE SET request_count = public_ip_rate_limit_windows.request_count + 1
     RETURNING request_count`,
    [ipAddress, routeKey, windowStart],
  );
  const count = result.rows[0]!.request_count;
  if (count > limitPerMinute) {
    return new RateLimitExceededError(computeRetryAfterSeconds(windowStart, WINDOW_MS, Date.now()));
  }
  return null;
}

/** Requests/minute/IP/route for `checkIpRateLimit` callers that don't pass
 *  their own limit -- deliberately much tighter than
 *  `DEFAULT_RATE_LIMIT_PER_MINUTE` (120). That default is sized for a real,
 *  already-signed-in tenant's own browser clicking through this app's own
 *  forms; this one is sized for a public, unauthenticated marketing-site
 *  form reachable by anyone, including a script -- a real prospect submits
 *  once, maybe retries a couple of times after fixing a validation error,
 *  never dozens of times a minute. */
export const DEFAULT_PUBLIC_RATE_LIMIT_PER_MINUTE = 5;

/**
 * Best-effort extraction of the requester's own IP address from standard
 * proxy headers. `NextRequest` has no built-in `.ip` property in this
 * Next.js version -- confirmed directly against the installed package's own
 * `request.d.ts` before writing this, not assumed from training data (an
 * older Next.js did have one; this app's pinned 16.3.3, per
 * `packages/web/AGENTS.md`'s own warning, doesn't). Takes a plain `Headers`
 * object rather than a whole `NextRequest` specifically so this stays a
 * pure, directly-testable function with no Next.js/edge-runtime import
 * needed in its own test file -- same "extract the pure decision, test it
 * directly" precedent `computeWindowStart`/`extractUsShippingZip` already
 * set; a route calls it as `getClientIp(req.headers)`.
 *
 * `x-forwarded-for` is a comma-separated client-then-proxies chain -- the
 * FIRST entry is the original client, not the last -- and it's the header
 * Vercel's own edge network sets (confirmed against Vercel's own docs
 * before writing this). Falls back to `x-real-ip` (some other proxies only
 * set this one), then a fixed placeholder string when neither header exists
 * at all (e.g. local dev with nothing in front) -- every such request
 * shares one bucket rather than the route breaking outright, a known,
 * accepted narrowing for an environment this limiter was never trying to
 * protect in the first place.
 *
 * Honest limitation, not silently assumed: this trusts whatever the
 * outermost proxy in front of this app reports, which is only
 * trustworthy when that proxy is one a client can't bypass. On Vercel
 * (this app's actual deployment target, CLAUDE.md §5) that's true --
 * Vercel's edge network sets `x-forwarded-for` itself and strips/
 * overwrites whatever a client sent -- but a self-hosted deployment with
 * no trusted reverse proxy in front would let a client set this header
 * directly and dodge the limit entirely. Not defended against here, since
 * it isn't this app's real deployment shape.
 */
export function getClientIp(headers: Headers): string {
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = headers.get("x-real-ip");
  if (realIp) {
    const trimmed = realIp.trim();
    if (trimmed) return trimmed;
  }
  return "unknown";
}
