// Golden-file tests (CLAUDE.md §7) for RulesEngine.evaluate() -- pure
// condition matching, fixed event input -> expected match output. Covers
// every operator/shape this pass implements: eq, in, dotted-path field
// access, multi-condition AND semantics, empty-conditions-matches-
// unconditionally, and an unrecognized operator failing closed. No DB.
//
// Run with: npm run test --workspace=@alltix/rules-engine -- evaluate-golden

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AutomationRule, DomainEventEnvelope } from "@alltix/shared";
import { RulesEngine } from "../src/index.js";

function makeRule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: "rule-1",
    tenantId: "tenant-1",
    name: "Test Rule",
    triggerEvent: "order.received",
    conditions: [],
    actions: [],
    priority: 100,
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeEvent(payload: unknown): DomainEventEnvelope {
  return { name: "order.received", tenantId: "tenant-1", occurredAt: "2026-01-01T00:00:00.000Z", payload };
}

test("eq: matches when the field equals the condition's value", () => {
  const rule = makeRule({ conditions: [{ field: "channel", op: "eq", value: "amazon" }] });
  const event = makeEvent({ channel: "amazon" });
  assert.deepEqual(RulesEngine.evaluate(event, [rule]), [{ rule, matched: true }]);
});

test("eq: does not match when the field differs", () => {
  const rule = makeRule({ conditions: [{ field: "channel", op: "eq", value: "amazon" }] });
  const event = makeEvent({ channel: "walmart" });
  assert.equal(RulesEngine.evaluate(event, [rule])[0]?.matched, false);
});

test("in: matches when the field's value is a member of the condition's array", () => {
  const rule = makeRule({ conditions: [{ field: "channel", op: "in", value: ["amazon", "walmart"] }] });
  assert.equal(RulesEngine.evaluate(makeEvent({ channel: "walmart" }), [rule])[0]?.matched, true);
  assert.equal(RulesEngine.evaluate(makeEvent({ channel: "shopify" }), [rule])[0]?.matched, false);
});

test("dotted-path field access reaches into nested objects", () => {
  const rule = makeRule({ conditions: [{ field: "shippingAddress.state", op: "eq", value: "CA" }] });
  assert.equal(
    RulesEngine.evaluate(makeEvent({ shippingAddress: { state: "CA" } }), [rule])[0]?.matched,
    true,
  );
  assert.equal(
    RulesEngine.evaluate(makeEvent({ shippingAddress: { state: "NY" } }), [rule])[0]?.matched,
    false,
  );
});

test("dotted-path access into a missing/null intermediate object doesn't throw, just doesn't match", () => {
  const rule = makeRule({ conditions: [{ field: "shippingAddress.state", op: "eq", value: "CA" }] });
  assert.equal(RulesEngine.evaluate(makeEvent({ shippingAddress: null }), [rule])[0]?.matched, false);
  assert.equal(RulesEngine.evaluate(makeEvent({}), [rule])[0]?.matched, false);
});

test("multiple conditions are ANDed -- every condition must match", () => {
  const rule = makeRule({
    conditions: [
      { field: "channel", op: "eq", value: "amazon" },
      { field: "shippingAddress.state", op: "eq", value: "CA" },
    ],
  });
  assert.equal(
    RulesEngine.evaluate(makeEvent({ channel: "amazon", shippingAddress: { state: "CA" } }), [rule])[0]?.matched,
    true,
    "both conditions match",
  );
  assert.equal(
    RulesEngine.evaluate(makeEvent({ channel: "amazon", shippingAddress: { state: "NY" } }), [rule])[0]?.matched,
    false,
    "one condition fails",
  );
});

test("a rule with no conditions matches unconditionally", () => {
  const rule = makeRule({ conditions: [] });
  assert.equal(RulesEngine.evaluate(makeEvent({ anything: "at all" }), [rule])[0]?.matched, true);
});

test("an unrecognized operator fails closed -- never matches", () => {
  const rule = makeRule({ conditions: [{ field: "channel", op: "contains", value: "ama" }] });
  assert.equal(RulesEngine.evaluate(makeEvent({ channel: "amazon" }), [rule])[0]?.matched, false);
});

test("evaluate() returns every rule with its own outcome, not just the matches", () => {
  const matching = makeRule({ id: "matches", conditions: [{ field: "channel", op: "eq", value: "amazon" }] });
  const nonMatching = makeRule({ id: "no-match", conditions: [{ field: "channel", op: "eq", value: "walmart" }] });
  const results = RulesEngine.evaluate(makeEvent({ channel: "amazon" }), [matching, nonMatching]);
  assert.deepEqual(
    results.map((r) => ({ id: r.rule.id, matched: r.matched })),
    [
      { id: "matches", matched: true },
      { id: "no-match", matched: false },
    ],
  );
});
