/**
 * CLAUDE.md §4.4's "exponential backoff + circuit breaker per channel
 * connection" piece, for the IN-PROCESS half of it -- the cross-run half
 * (skip a connection entirely for a while once it's been sustained-rate-
 * limited) lives in packages/scheduler/src/index.ts's recordRateLimitTrip()/
 * RATE_LIMIT_COOLDOWN_MS, which this module hands the signal to. See this
 * file's header comment in packages/scheduler for why neither half is a
 * real BullMQ+Redis token-bucket queue: this app runs on Vercel Hobby with
 * no persistent process and no Redis anywhere in the stack, so "central
 * job queue" would mean standing up brand-new paid infrastructure for a
 * single self-testing tenant. What's here instead is the part of §4.4 that
 * *does* fit a stateless serverless function: retry a single call a few
 * times before giving up, and hand the caller a distinguishable reason for
 * giving up so it can decide whether to also skip future runs.
 */

/**
 * Thrown by {@link fetchWithBackoff} once it gives up on a retryable
 * outcome (a 429/503 response, or a thrown network error) after exhausting
 * every attempt -- a distinct, recognizable type so a caller
 * (packages/scheduler's syncXTenant() functions) can tell "this connection
 * is actively being throttled or the marketplace is down, trip the circuit
 * breaker" apart from every other kind of failure (a 400/403/404, a bad
 * response body, anything else a connector already has its own specific
 * error message for) without parsing error text.
 */
export class RateLimitExhaustedError extends Error {
  constructor(
    message: string,
    /** The last HTTP status seen, or null if every attempt failed at the
     *  network level (no response ever came back to have a status). */
    public readonly status: number | null,
    /** The last retryable response's Retry-After header, converted to
     *  milliseconds -- null if none was ever present or parseable. A
     *  caller tripping the cross-run circuit breaker uses this to honor a
     *  marketplace's own stated cooldown when it's longer than the
     *  default, rather than guessing. */
    public readonly retryAfterMs: number | null,
  ) {
    super(message);
    this.name = "RateLimitExhaustedError";
  }
}

export interface RetryOptions {
  /** Total attempts, including the first -- not "retries" (so 1 means
   *  "never retry, behave exactly like plain fetch"). */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  isRetryableStatus?: (status: number) => boolean;
  /** Injectable purely for tests -- real callers never pass this. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 500;
// Kept deliberately short (a few seconds' worth of total possible retry
// time across all attempts), not tuned to actually ride out a marketplace's
// real rate-limit window -- a Vercel serverless function has its own tight
// execution-time budget (10s on Hobby by default), so sleeping for a long
// Retry-After INSIDE one invocation risks the function itself timing out
// before ever reaching the "give up and trip the circuit breaker" path.
// Sustained throttling is meant to be absorbed by the cross-run cooldown
// (packages/scheduler's recordRateLimitTrip(), NOT bound by one function's
// execution time), not by waiting longer here.
const DEFAULT_MAX_DELAY_MS = 4000;

function defaultIsRetryableStatus(status: number): boolean {
  return status === 429 || status === 503;
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Full-jitter exponential backoff -- a uniformly random delay between 0
 *  and min(maxDelayMs, baseDelayMs * 2^attempt), the formula AWS's own
 *  Architecture Blog recommends specifically to avoid many callers backing
 *  off in lockstep and re-colliding on the next attempt. `attempt` is
 *  0-indexed: the delay before the *second* overall attempt uses attempt=0. */
function computeBackoffMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.random() * cap;
}

/** A response's Retry-After header, in milliseconds -- null if absent or
 *  unparseable. Handles both forms the HTTP spec allows: a delay in whole
 *  seconds (what Amazon SP-API and Walmart's API both document sending on
 *  a 429), and an HTTP-date. */
function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

/**
 * A drop-in replacement for `fetch()`: identical behavior for a request
 * that succeeds, or fails with anything other than a retryable status (see
 * {@link RetryOptions.isRetryableStatus}, default 429/503) or a thrown
 * network error -- every connector's own existing `if (!response.ok)`
 * handling, error-message formatting, and body parsing is completely
 * unchanged in every case except one. Only a *sustained* retryable failure
 * (still retryable after `maxAttempts` tries) behaves differently: instead
 * of handing back the still-bad Response the way plain fetch would, this
 * throws {@link RateLimitExhaustedError}.
 *
 * A captured Retry-After header (see {@link retryAfterMs}) takes precedence
 * over the computed exponential-backoff delay when it's larger -- honoring
 * what the marketplace actually asked for beats guessing, when it told us.
 */
export async function fetchWithBackoff(input: string | URL, init?: RequestInit, options: RetryOptions = {}): Promise<Response> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const isRetryableStatus = options.isRetryableStatus ?? defaultIsRetryableStatus;
  const sleep = options.sleep ?? defaultSleep;

  let lastNetworkError: unknown = null;
  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const computedDelay = computeBackoffMs(attempt - 1, baseDelayMs, maxDelayMs);
      const requestedDelay = lastResponse ? retryAfterMs(lastResponse) : null;
      await sleep(Math.max(computedDelay, requestedDelay ?? 0));
    }

    try {
      const response = await fetch(input, init);
      if (!isRetryableStatus(response.status)) {
        return response;
      }
      lastResponse = response;
      lastNetworkError = null;
    } catch (err) {
      lastNetworkError = err;
      lastResponse = null;
    }
  }

  if (lastResponse) {
    throw new RateLimitExhaustedError(
      `Giving up on ${String(input)} after ${maxAttempts} attempts -- still receiving HTTP ${lastResponse.status}`,
      lastResponse.status,
      retryAfterMs(lastResponse),
    );
  }
  throw new RateLimitExhaustedError(
    `Giving up on ${String(input)} after ${maxAttempts} attempts -- ` +
      `${lastNetworkError instanceof Error ? lastNetworkError.message : String(lastNetworkError)}`,
    null,
    null,
  );
}
