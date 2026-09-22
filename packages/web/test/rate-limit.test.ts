// Pure-logic coverage for src/lib/rate-limit.ts's window/retry-after math --
// no DB, no network. Same "extract the pure decision, test it directly"
// precedent reorder-threshold.test.ts and channel-flags.test.ts set.
//
// Run with: npm run test:rate-limit --workspace=@alltix/web

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeWindowStart, computeRetryAfterSeconds } from "../src/lib/rate-limit.js";

const ONE_MINUTE = 60_000;

test("computeWindowStart floors to the start of the containing minute", () => {
  // 2024-01-01T00:00:00.000Z
  const windowStartMs = Date.UTC(2024, 0, 1, 0, 0, 0, 0);
  assert.equal(computeWindowStart(windowStartMs, ONE_MINUTE), windowStartMs);
  assert.equal(computeWindowStart(windowStartMs + 1, ONE_MINUTE), windowStartMs);
  assert.equal(computeWindowStart(windowStartMs + 59_999, ONE_MINUTE), windowStartMs);
  assert.equal(computeWindowStart(windowStartMs + 60_000, ONE_MINUTE), windowStartMs + ONE_MINUTE);
});

test("two requests in the same minute map to the same window", () => {
  const first = Date.UTC(2024, 0, 1, 12, 30, 5, 0);
  const second = Date.UTC(2024, 0, 1, 12, 30, 55, 0);
  assert.equal(computeWindowStart(first, ONE_MINUTE), computeWindowStart(second, ONE_MINUTE));
});

test("a request one minute later maps to a different window", () => {
  const first = Date.UTC(2024, 0, 1, 12, 30, 5, 0);
  const second = Date.UTC(2024, 0, 1, 12, 31, 5, 0);
  assert.notEqual(computeWindowStart(first, ONE_MINUTE), computeWindowStart(second, ONE_MINUTE));
});

test("computeRetryAfterSeconds rounds up to the next whole second", () => {
  const windowStart = 0;
  // Window closes at 60_000ms; 100ms in, 59_900ms remain -> 59.9s -> 60s.
  assert.equal(computeRetryAfterSeconds(windowStart, ONE_MINUTE, 100), 60);
  // 59_500ms in, 500ms remain -> 0.5s -> rounds up to 1s.
  assert.equal(computeRetryAfterSeconds(windowStart, ONE_MINUTE, 59_500), 1);
});

test("computeRetryAfterSeconds never returns less than 1, even right at window close", () => {
  const windowStart = 0;
  assert.equal(computeRetryAfterSeconds(windowStart, ONE_MINUTE, 60_000), 1);
  assert.equal(computeRetryAfterSeconds(windowStart, ONE_MINUTE, 65_000), 1);
});
