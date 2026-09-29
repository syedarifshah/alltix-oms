// Pure-logic coverage for src/lib/platform-operator.ts's own
// parseOperatorAllowlist()/isPlatformOperatorEmail() -- no DB, no network,
// same "extract the pure decision, test it directly" precedent
// channel-flags.test.ts/reorder-threshold.test.ts both already set.
// requirePlatformOperator()/requirePlatformOperatorFromRequest() themselves
// need a real Postgres connection (withClerkUser()) and a real NextRequest
// respectively, so they're deliberately not covered here -- same "no DB-layer
// test suite for this migration/module, verified instead via tsc -b/next
// build/manual smoke test" precedent several other lib/ modules in this
// codebase already carry (e.g. reorder-threshold.ts's own DB-touching half).
//
// Run with: npm run test:platform-operator --workspace=@alltix/web

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOperatorAllowlist, isPlatformOperatorEmail } from "../src/lib/platform-operator.js";

test("parses a comma-separated list into a lowercase, trimmed set", () => {
  const allowlist = parseOperatorAllowlist("Arif@Example.com, ops@example.com");
  assert.equal(allowlist.has("arif@example.com"), true);
  assert.equal(allowlist.has("ops@example.com"), true);
  assert.equal(allowlist.size, 2);
});

test("trims whitespace around each entry", () => {
  const allowlist = parseOperatorAllowlist("  arif@example.com  ,  ops@example.com  ");
  assert.deepEqual([...allowlist].sort(), ["arif@example.com", "ops@example.com"]);
});

test("lowercases every entry", () => {
  const allowlist = parseOperatorAllowlist("ARIF@EXAMPLE.COM");
  assert.equal(allowlist.has("arif@example.com"), true);
  assert.equal(allowlist.has("ARIF@EXAMPLE.COM"), false);
});

test("drops empty entries from a trailing/doubled comma", () => {
  const allowlist = parseOperatorAllowlist("arif@example.com,,ops@example.com,");
  assert.deepEqual([...allowlist].sort(), ["arif@example.com", "ops@example.com"]);
});

test("returns an empty set for undefined, null, or blank input -- fails closed", () => {
  assert.equal(parseOperatorAllowlist(undefined).size, 0);
  assert.equal(parseOperatorAllowlist(null).size, 0);
  assert.equal(parseOperatorAllowlist("").size, 0);
  assert.equal(parseOperatorAllowlist("   ").size, 0);
});

test("isPlatformOperatorEmail matches case-insensitively against the allowlist", () => {
  const allowlist = parseOperatorAllowlist("arif@example.com");
  assert.equal(isPlatformOperatorEmail("Arif@Example.com", allowlist), true);
  assert.equal(isPlatformOperatorEmail("ARIF@EXAMPLE.COM", allowlist), true);
  assert.equal(isPlatformOperatorEmail("someone-else@example.com", allowlist), false);
});

test("isPlatformOperatorEmail is fail-closed against an empty allowlist", () => {
  const allowlist = parseOperatorAllowlist(undefined);
  assert.equal(isPlatformOperatorEmail("arif@example.com", allowlist), false);
});
