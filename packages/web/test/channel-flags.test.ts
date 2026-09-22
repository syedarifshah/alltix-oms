// Pure-logic coverage for src/lib/channel-flags.ts -- no DB, no network.
// Same "extract the pure decision, test it directly" precedent
// reorder-threshold.test.ts and @alltix/order-service's own
// nearest-location-routing.test.ts set.
//
// Run with: npm run test:channel-flags --workspace=@alltix/web

import { test } from "node:test";
import assert from "node:assert/strict";
import { filterKnownChannels, ALL_CHANNELS } from "../src/lib/channel-flags.js";

test("passes through every recognized channel unchanged", () => {
  assert.deepEqual(filterKnownChannels(["amazon", "shopify"]), ["amazon", "shopify"]);
  assert.deepEqual(filterKnownChannels([...ALL_CHANNELS]), [...ALL_CHANNELS]);
});

test("drops unrecognized values rather than passing them through", () => {
  assert.deepEqual(filterKnownChannels(["amazon", "not_a_real_channel"]), ["amazon"]);
  assert.deepEqual(filterKnownChannels(["totally_bogus"]), []);
});

test("returns an empty array for an empty input", () => {
  assert.deepEqual(filterKnownChannels([]), []);
});

test("preserves order and duplicates -- callers only ever check .includes()", () => {
  assert.deepEqual(filterKnownChannels(["tiktok", "amazon", "tiktok"]), ["tiktok", "amazon", "tiktok"]);
});

test("is case-sensitive -- 'Amazon' is not the same as 'amazon'", () => {
  assert.deepEqual(filterKnownChannels(["Amazon", "AMAZON"]), []);
});
