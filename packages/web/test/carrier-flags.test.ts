// Pure-logic coverage for src/lib/carrier-flags.ts -- no DB, no network.
// A near-literal mirror of channel-flags.test.ts, since carrier-flags.ts
// itself deliberately mirrors channel-flags.ts's own shape.
//
// Run with: npm run test:carrier-flags --workspace=@alltix/web

import { test } from "node:test";
import assert from "node:assert/strict";
import { filterKnownCarriers, ALL_CARRIERS } from "../src/lib/carrier-flags.js";

test("passes through every recognized carrier unchanged", () => {
  assert.deepEqual(filterKnownCarriers(["royal_mail", "evri"]), ["royal_mail", "evri"]);
  assert.deepEqual(filterKnownCarriers([...ALL_CARRIERS]), [...ALL_CARRIERS]);
});

test("drops unrecognized values rather than passing them through", () => {
  assert.deepEqual(filterKnownCarriers(["dpd", "not_a_real_carrier"]), ["dpd"]);
  assert.deepEqual(filterKnownCarriers(["totally_bogus"]), []);
});

test("drops 'hermes' even though carrier_connections' own CHECK constraint still allows it -- no connector exists for it", () => {
  assert.deepEqual(filterKnownCarriers(["royal_mail", "hermes"]), ["royal_mail"]);
});

test("returns an empty array for an empty input", () => {
  assert.deepEqual(filterKnownCarriers([]), []);
});

test("preserves order and duplicates -- callers only ever check .includes()", () => {
  assert.deepEqual(filterKnownCarriers(["dpd", "royal_mail", "dpd"]), ["dpd", "royal_mail", "dpd"]);
});

test("is case-sensitive -- 'DPD' is not the same as 'dpd'", () => {
  assert.deepEqual(filterKnownCarriers(["DPD", "Dpd"]), []);
});
