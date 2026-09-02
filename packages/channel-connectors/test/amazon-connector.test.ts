// Regression test for the /orders "Placed At" column showing
// 1970-01-19T03:58:30.000Z for real Amazon sandbox orders. Traced the raw
// value straight from the SP-API sandbox (bypassing this connector) and
// confirmed it returns that exact PurchaseDate on every TEST_CASE_200
// order -- not something normalizeAmazonOrder, persistPulledOrders(), or
// the /orders page corrupts. parsePurchaseDate() is the guard added at
// ingestion so that implausible upstream dates become null (rendered as
// "—") instead of being stored and displayed as if they were real.
//
// Run with: npm run test --workspace=@alltix/channel-connectors

import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePurchaseDate } from "../src/amazon-connector.js";

test("rejects the SP-API sandbox's own known-bad canned PurchaseDate", () => {
  assert.equal(parsePurchaseDate("1970-01-19T03:58:30Z"), null);
});

test("rejects any date before Amazon's third-party marketplace existed", () => {
  assert.equal(parsePurchaseDate("1999-12-31T23:59:59Z"), null);
});

test("rejects a non-date string", () => {
  assert.equal(parsePurchaseDate("not-a-date"), null);
});

test("accepts a real, recent-ish ISO 8601 purchase date unchanged", () => {
  const real = "2024-03-15T10:30:00.000Z";
  assert.equal(parsePurchaseDate(real), real);
});
