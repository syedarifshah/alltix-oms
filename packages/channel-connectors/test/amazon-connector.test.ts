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
import {
  parsePurchaseDate,
  AmazonConnector,
  SP_API_EU_SANDBOX_BASE_URL,
  SP_API_NA_SANDBOX_BASE_URL,
  SP_API_EU_PRODUCTION_BASE_URL,
  SP_API_NA_PRODUCTION_BASE_URL,
  SP_API_FE_PRODUCTION_BASE_URL,
} from "../src/amazon-connector.js";

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

// Regression coverage for preparing AmazonConnector for real production
// testing: isSandbox() gates every TEST_CASE_200/CreatedAfter-literal
// substitution in pullOrders()/getOrderItems()/confirmShipment(), so it
// must correctly distinguish both sandbox hosts from every production
// host -- a fake credentials object is enough here since the constructor
// makes no network call, only pullOrders()/confirmShipment() do.
const FAKE_CREDENTIALS = { clientId: "x", clientSecret: "x", refreshToken: "x", sellerId: "x" };

test("isSandbox() is true for the EU sandbox host", () => {
  assert.equal(new AmazonConnector(FAKE_CREDENTIALS, SP_API_EU_SANDBOX_BASE_URL).isSandbox(), true);
});

test("isSandbox() is true for the NA sandbox host too, not just EU", () => {
  assert.equal(new AmazonConnector(FAKE_CREDENTIALS, SP_API_NA_SANDBOX_BASE_URL).isSandbox(), true);
});

test("isSandbox() is false for every production host -- real dates and order ids must flow through unchanged", () => {
  assert.equal(new AmazonConnector(FAKE_CREDENTIALS, SP_API_EU_PRODUCTION_BASE_URL).isSandbox(), false);
  assert.equal(new AmazonConnector(FAKE_CREDENTIALS, SP_API_NA_PRODUCTION_BASE_URL).isSandbox(), false);
  assert.equal(new AmazonConnector(FAKE_CREDENTIALS, SP_API_FE_PRODUCTION_BASE_URL).isSandbox(), false);
});
