// Golden-file tests (CLAUDE.md §7) for RulesEngine.resolveActions() -- the
// multiple-matching-rules semantics pinned down for this pass: every
// matched rule's non-conflicting actions apply; for actions of the same
// type across multiple matched rules, only the highest-priority (lowest
// priority number) rule's action applies, with equal-priority ties broken
// by createdAt ascending (earliest-created rule wins). No DB.
//
// Run with: npm run test --workspace=@alltix/rules-engine -- resolve-actions-priority

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AutomationRule } from "@alltix/shared";
import { RulesEngine, type RuleEvaluation } from "../src/index.js";

function makeRule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: "rule",
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

function matched(rule: AutomationRule): RuleEvaluation {
  return { rule, matched: true };
}

function unmatched(rule: AutomationRule): RuleEvaluation {
  return { rule, matched: false };
}

test("a single matched rule's action is applied", () => {
  const rule = makeRule({ actions: [{ type: "route_to_warehouse", value: "WH-1" }] });
  const resolved = RulesEngine.resolveActions([matched(rule)]);
  assert.deepEqual(resolved, [{ rule, action: { type: "route_to_warehouse", value: "WH-1" }, applied: true }]);
});

test("an unmatched rule contributes nothing, even if it has actions", () => {
  const rule = makeRule({ actions: [{ type: "route_to_warehouse", value: "WH-1" }] });
  assert.deepEqual(RulesEngine.resolveActions([unmatched(rule)]), []);
});

test("two matched rules with different action types both apply -- no conflict", () => {
  const routeRule = makeRule({ id: "route-rule", actions: [{ type: "route_to_warehouse", value: "WH-1" }] });
  const otherRule = makeRule({ id: "other-rule", actions: [{ type: "some_future_action", value: "x" }] });
  const resolved = RulesEngine.resolveActions([matched(routeRule), matched(otherRule)]);
  assert.deepEqual(
    resolved.map((r) => ({ ruleId: r.rule.id, applied: r.applied })),
    [
      { ruleId: "route-rule", applied: true },
      { ruleId: "other-rule", applied: true },
    ],
  );
});

test("two matched rules with the same action type conflict: the higher-priority (lower number) rule wins", () => {
  const highPriority = makeRule({
    id: "high-priority",
    priority: 10,
    actions: [{ type: "route_to_warehouse", value: "WH-1" }],
  });
  const lowPriority = makeRule({
    id: "low-priority",
    priority: 200,
    actions: [{ type: "route_to_warehouse", value: "WH-2" }],
  });

  // Order in the input list shouldn't matter -- resolveActions sorts.
  const resolved = RulesEngine.resolveActions([matched(lowPriority), matched(highPriority)]);
  assert.deepEqual(
    resolved.map((r) => ({ ruleId: r.rule.id, value: r.action.value, applied: r.applied })),
    [
      { ruleId: "high-priority", value: "WH-1", applied: true },
      { ruleId: "low-priority", value: "WH-2", applied: false },
    ],
  );
});

test("equal-priority conflicting rules: the earlier-created rule wins (tie-break by createdAt, not id)", () => {
  const madeFirst = makeRule({
    id: "z-rule-but-first", // deliberately sorts last alphabetically/by id
    priority: 50,
    createdAt: "2026-01-01T00:00:00.000Z",
    actions: [{ type: "route_to_warehouse", value: "WH-1" }],
  });
  const madeSecond = makeRule({
    id: "a-rule-but-second", // deliberately sorts first alphabetically/by id
    priority: 50,
    createdAt: "2026-01-02T00:00:00.000Z",
    actions: [{ type: "route_to_warehouse", value: "WH-2" }],
  });

  const resolved = RulesEngine.resolveActions([matched(madeSecond), matched(madeFirst)]);
  assert.deepEqual(
    resolved.map((r) => ({ ruleId: r.rule.id, applied: r.applied })),
    [
      { ruleId: "z-rule-but-first", applied: true },
      { ruleId: "a-rule-but-second", applied: false },
    ],
    "the rule created first wins despite sorting after the other rule by id",
  );
});

test("a disabled rule never reaches resolveActions at all (loadEnabledRules filters it), so it's absent, not present-and-unapplied", () => {
  // resolveActions only sees what evaluate() was given; a disabled rule is
  // never loaded in the first place (loadEnabledRulesWithClient's WHERE
  // enabled = true). This test documents that boundary rather than
  // re-testing SQL -- see order-received-integration.test.ts for the real,
  // end-to-end proof against Postgres.
  const enabledRule = makeRule({ id: "enabled", actions: [{ type: "route_to_warehouse", value: "WH-1" }] });
  const resolved = RulesEngine.resolveActions([matched(enabledRule)]);
  assert.equal(resolved.length, 1);
});

test("a rule with multiple actions contributes each independently to conflict resolution", () => {
  const rule = makeRule({
    actions: [
      { type: "route_to_warehouse", value: "WH-1" },
      { type: "some_future_action", value: "x" },
    ],
  });
  const resolved = RulesEngine.resolveActions([matched(rule)]);
  assert.equal(resolved.length, 2);
  assert.ok(resolved.every((r) => r.applied));
});
