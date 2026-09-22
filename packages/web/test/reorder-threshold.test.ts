// Pure-logic coverage for src/lib/reorder-threshold.ts -- no DB, no network.
// Same "extract the pure decision, test it directly" precedent
// extractUsShippingZip/rankByDistanceToShippingZip set in
// packages/order-service/test/nearest-location-routing.test.ts, and
// @alltix/inventory-service's own forecast.test.ts sets for
// assessStockForecast.
//
// Run with: npm run test:reorder-threshold --workspace=@alltix/web

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReorderThresholdDays, MIN_REORDER_THRESHOLD_DAYS, MAX_REORDER_THRESHOLD_DAYS } from "../src/lib/reorder-threshold.js";

test("accepts a plain whole number within bounds", () => {
  assert.equal(parseReorderThresholdDays("14"), 14);
  assert.equal(parseReorderThresholdDays("1"), 1);
  assert.equal(parseReorderThresholdDays("365"), 365);
});

test("trims surrounding whitespace", () => {
  assert.equal(parseReorderThresholdDays("  21  "), 21);
});

test("rejects the boundary values just outside [MIN, MAX]", () => {
  assert.equal(parseReorderThresholdDays(String(MIN_REORDER_THRESHOLD_DAYS - 1)), null);
  assert.equal(parseReorderThresholdDays(String(MAX_REORDER_THRESHOLD_DAYS + 1)), null);
});

test("rejects zero and negative numbers", () => {
  assert.equal(parseReorderThresholdDays("0"), null);
  assert.equal(parseReorderThresholdDays("-5"), null);
});

test("rejects decimals", () => {
  assert.equal(parseReorderThresholdDays("14.5"), null);
});

test("rejects blank, whitespace-only, and non-numeric input without throwing", () => {
  assert.equal(parseReorderThresholdDays(""), null);
  assert.equal(parseReorderThresholdDays("   "), null);
  assert.equal(parseReorderThresholdDays("abc"), null);
  assert.equal(parseReorderThresholdDays("14abc"), null);
});

test("rejects a value with a leading plus sign or other non-digit characters", () => {
  assert.equal(parseReorderThresholdDays("+14"), null);
  assert.equal(parseReorderThresholdDays("1e2"), null);
});
