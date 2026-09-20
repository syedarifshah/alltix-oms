// Proves the pure stock-forecasting functions (CLAUDE.md §8 Phase 5's
// "stock forecasting" line, v1 scope) -- computeDailyVelocity,
// computeDaysOfStockRemaining, assessStockForecast. Pure functions, no DB
// access, same "unit-tested without a live Postgres" precedent
// extractUsShippingZip/rankByDistanceToShippingZip already set in
// packages/order-service/test/nearest-location-routing.test.ts.
//
// Run with: npm run test --workspace=@alltix/inventory-service -- forecast

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeDailyVelocity,
  computeDaysOfStockRemaining,
  assessStockForecast,
  DEFAULT_REORDER_THRESHOLD_DAYS,
} from "../src/index.js";

test("computeDailyVelocity divides units sold by the window length", () => {
  assert.equal(computeDailyVelocity(60, 30), 2);
  assert.equal(computeDailyVelocity(7, 7), 1);
  assert.equal(computeDailyVelocity(1, 3), 1 / 3);
});

test("computeDailyVelocity returns 0 for zero units sold", () => {
  assert.equal(computeDailyVelocity(0, 30), 0);
});

test("computeDailyVelocity guards against a non-positive windowDays rather than dividing by zero/negative", () => {
  assert.equal(computeDailyVelocity(10, 0), 0);
  assert.equal(computeDailyVelocity(10, -5), 0);
});

test("computeDaysOfStockRemaining divides available by daily velocity", () => {
  assert.equal(computeDaysOfStockRemaining(30, 2), 15);
  assert.equal(computeDaysOfStockRemaining(10, 3), 10 / 3);
});

test("computeDaysOfStockRemaining returns 0 (not null) when available is already zero", () => {
  assert.equal(computeDaysOfStockRemaining(0, 2), 0);
});

test("computeDaysOfStockRemaining returns 0 when available is negative (oversold)", () => {
  assert.equal(computeDaysOfStockRemaining(-5, 2), 0);
});

test("computeDaysOfStockRemaining returns null (not Infinity) when there's no recent sales velocity", () => {
  assert.equal(computeDaysOfStockRemaining(50, 0), null);
});

test("computeDaysOfStockRemaining prioritizes the already-out case over the no-velocity case when both are true", () => {
  // available <= 0 AND dailyVelocity <= 0 -- "already out" is the more
  // useful, more certain answer, so it wins rather than falling through to
  // "unknown."
  assert.equal(computeDaysOfStockRemaining(0, 0), 0);
});

test("assessStockForecast combines velocity + days-remaining + the reorder-soon flag", () => {
  // 100 available, 50 units sold over 10 days -> 5/day -> 20 days remaining.
  const result = assessStockForecast(100, 50, 10, 14);
  assert.equal(result.dailyVelocity, 5);
  assert.equal(result.daysRemaining, 20);
  assert.equal(result.reorderSoon, false); // 20 > 14
});

test("assessStockForecast flags reorderSoon when daysRemaining is at or below the threshold", () => {
  // 20 available, 20 units sold over 10 days -> 2/day -> 10 days remaining, threshold 14.
  const result = assessStockForecast(20, 20, 10, 14);
  assert.equal(result.daysRemaining, 10);
  assert.equal(result.reorderSoon, true);
});

test("assessStockForecast treats exactly-at-threshold as reorderSoon (boundary is inclusive)", () => {
  // 140 available, 10/day -> exactly 14 days remaining, threshold 14.
  const result = assessStockForecast(140, 100, 10, 14);
  assert.equal(result.daysRemaining, 14);
  assert.equal(result.reorderSoon, true);
});

test("assessStockForecast never flags reorderSoon when daysRemaining is null (no recent sales)", () => {
  const result = assessStockForecast(50, 0, 30, 14);
  assert.equal(result.daysRemaining, null);
  assert.equal(result.reorderSoon, false);
});

test("assessStockForecast defaults reorderThresholdDays to DEFAULT_REORDER_THRESHOLD_DAYS when omitted", () => {
  // 10 available, 1/day -> 10 days remaining -- below the 14-day default.
  const withDefault = assessStockForecast(10, 10, 10);
  assert.equal(withDefault.daysRemaining, 10);
  assert.equal(withDefault.reorderSoon, true);
  assert.equal(DEFAULT_REORDER_THRESHOLD_DAYS, 14);
});

test("assessStockForecast flags reorderSoon for an already-out-of-stock item regardless of velocity", () => {
  const result = assessStockForecast(0, 5, 10, 14);
  assert.equal(result.daysRemaining, 0);
  assert.equal(result.reorderSoon, true);
});
