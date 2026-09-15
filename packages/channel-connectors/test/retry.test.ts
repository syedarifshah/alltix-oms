// Unit tests for fetchWithBackoff/RateLimitExhaustedError -- no network, no
// real timers. global.fetch is stubbed per test (restored in a `finally`,
// same discipline as any other global-mutating test in this repo) and
// `sleep` is injected via RetryOptions specifically so these tests run in
// milliseconds instead of actually waiting out backoff delays -- see
// retry.ts's own header comment for why the real delays are intentionally
// short but still not something a unit test should sit through.
//
// Run with: npm run test --workspace=@alltix/channel-connectors

import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchWithBackoff, RateLimitExhaustedError } from "../src/retry.js";

function jsonResponse(status: number, body: unknown = {}, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

/** Records every delay fetchWithBackoff asks it to wait, without actually
 *  waiting -- lets a test assert "it backed off N times" and "it respected
 *  Retry-After" without a single real setTimeout. */
function recordingSleep(delays: number[]): (ms: number) => Promise<void> {
  return async (ms: number) => {
    delays.push(ms);
  };
}

test("fetchWithBackoff returns the response unchanged on a first-try 200", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount++;
    return jsonResponse(200, { ok: true });
  }) as typeof fetch;

  try {
    const response = await fetchWithBackoff("https://example.test/orders");
    assert.equal(response.status, 200);
    assert.equal(callCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchWithBackoff passes through a non-retryable error status (e.g. 403) without retrying", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount++;
    return jsonResponse(403, { error: "forbidden" });
  }) as typeof fetch;

  try {
    const response = await fetchWithBackoff("https://example.test/orders");
    assert.equal(response.status, 403);
    assert.equal(callCount, 1, "a 403 is not retryable -- must not retry");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchWithBackoff retries a 429 and succeeds once the underlying call recovers", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount++;
    if (callCount < 3) return jsonResponse(429, { error: "throttled" });
    return jsonResponse(200, { ok: true });
  }) as typeof fetch;

  const delays: number[] = [];
  try {
    const response = await fetchWithBackoff("https://example.test/orders", undefined, { sleep: recordingSleep(delays) });
    assert.equal(response.status, 200);
    assert.equal(callCount, 3);
    assert.equal(delays.length, 2, "one sleep between each of the 2 failed attempts and the next try");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchWithBackoff retries a 503 the same as a 429", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount++;
    if (callCount < 2) return jsonResponse(503, {});
    return jsonResponse(200, {});
  }) as typeof fetch;

  try {
    const response = await fetchWithBackoff("https://example.test/orders", undefined, { sleep: recordingSleep([]) });
    assert.equal(response.status, 200);
    assert.equal(callCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchWithBackoff throws RateLimitExhaustedError after maxAttempts of sustained 429s, carrying the last status", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount++;
    return jsonResponse(429, { error: "throttled" });
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => fetchWithBackoff("https://example.test/orders", undefined, { maxAttempts: 3, sleep: recordingSleep([]) }),
      (err: unknown) => {
        assert.ok(err instanceof RateLimitExhaustedError);
        assert.equal(err.status, 429);
        return true;
      },
    );
    assert.equal(callCount, 3, "must have made exactly maxAttempts tries, no more");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchWithBackoff retries a thrown network error and can still recover", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount++;
    if (callCount < 2) throw new TypeError("fetch failed: ECONNRESET");
    return jsonResponse(200, {});
  }) as typeof fetch;

  try {
    const response = await fetchWithBackoff("https://example.test/orders", undefined, { sleep: recordingSleep([]) });
    assert.equal(response.status, 200);
    assert.equal(callCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchWithBackoff throws RateLimitExhaustedError with status=null after sustained network errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed: ECONNRESET");
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => fetchWithBackoff("https://example.test/orders", undefined, { maxAttempts: 2, sleep: recordingSleep([]) }),
      (err: unknown) => {
        assert.ok(err instanceof RateLimitExhaustedError);
        assert.equal(err.status, null);
        assert.equal(err.retryAfterMs, null);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchWithBackoff honors a seconds-form Retry-After header when it exceeds the computed backoff", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount++;
    if (callCount === 1) return jsonResponse(429, {}, { "retry-after": "7" });
    return jsonResponse(200, {});
  }) as typeof fetch;

  const delays: number[] = [];
  try {
    const response = await fetchWithBackoff("https://example.test/orders", undefined, {
      sleep: recordingSleep(delays),
      baseDelayMs: 1,
      maxDelayMs: 2,
    });
    assert.equal(response.status, 200);
    assert.equal(delays.length, 1);
    assert.ok(delays[0]! >= 7000, `expected the 7s Retry-After to dominate a ~1-2ms computed backoff, got ${delays[0]}ms`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("RateLimitExhaustedError surfaces the final Retry-After when exhausted", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse(429, {}, { "retry-after": "30" })) as typeof fetch;

  try {
    await assert.rejects(
      () => fetchWithBackoff("https://example.test/orders", undefined, { maxAttempts: 2, sleep: recordingSleep([]) }),
      (err: unknown) => {
        assert.ok(err instanceof RateLimitExhaustedError);
        assert.equal(err.retryAfterMs, 30000);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchWithBackoff with maxAttempts=1 behaves like plain fetch (never retries)", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount++;
    return jsonResponse(429, {});
  }) as typeof fetch;

  try {
    await assert.rejects(() =>
      fetchWithBackoff("https://example.test/orders", undefined, { maxAttempts: 1, sleep: recordingSleep([]) }),
    );
    assert.equal(callCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
