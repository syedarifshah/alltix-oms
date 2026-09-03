import type { Pool, PoolClient } from "pg";
import { withTenant } from "@alltix/db";
import {
  DomainEvent,
  type AutomationRule,
  type AutomationRuleAction,
  type AutomationRuleCondition,
  type DomainEventEnvelope,
  type EventBus,
  type OrderReceivedPayload,
} from "@alltix/shared";

/** One rule considered against an event, with its match outcome. Kept
 *  separate from action resolution (see {@link RulesEngine.resolveActions})
 *  so condition matching stays a pure, easily golden-file-tested function --
 *  no DB, no conflict resolution, no I/O. */
export interface RuleEvaluation {
  rule: AutomationRule;
  matched: boolean;
}

/** One matched rule's action after priority-based conflict resolution.
 *  `applied: false` means this rule's conditions matched but a
 *  higher-priority rule's conflicting action of the same type won instead --
 *  still worth a rule_executions row (see its type doc comment). */
export interface ResolvedAction {
  rule: AutomationRule;
  action: AutomationRuleAction;
  applied: boolean;
}

function getByPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (current === null || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, obj);
}

/** `conditions` is an implicit AND list (CLAUDE.md §2.4's own example reads
 *  as one): every condition must match for the rule to match. Empty
 *  conditions matches unconditionally (a rule with no conditions applies to
 *  every event of its trigger_event). */
function matchesConditions(conditions: AutomationRuleCondition[], payload: unknown): boolean {
  return conditions.every((condition) => {
    const actual = getByPath(payload, condition.field);
    switch (condition.op) {
      case "eq":
        return actual === condition.value;
      case "in":
        return Array.isArray(condition.value) && condition.value.includes(actual);
      default:
        // An unrecognized operator can never match -- fail closed (a rule
        // that can never fire is a config bug to notice, not a rule that
        // silently matches everything).
        return false;
    }
  });
}

/**
 * Evaluates stored condition -> action `automation_rules` against incoming
 * domain events (CLAUDE.md §1). Deliberately built as its own module rather
 * than deferred — CLAUDE.md §11 calls out treating this as a "v2 feature" as
 * a common failure mode.
 *
 * Multiple-matching-rules semantics (CLAUDE.md doesn't specify this --
 * decided and pinned down here, not left implicit): every enabled rule whose
 * conditions match the event is considered "matched." Priority (lower
 * number = higher priority; automation_rules.priority) resolves conflicts
 * *per action type*, not per rule -- for each action type present across the
 * matched rules, only the highest-priority matching rule's action of that
 * type is applied; a lower-priority rule's action of a type no
 * higher-priority rule specified still applies. Equal-priority ties break by
 * created_at ascending (the rule made first wins -- an explicable story,
 * unlike an arbitrary id comparison). With only one action type implemented
 * (route_to_warehouse) today, this mostly matters as "the highest-priority
 * rule that sets a preferred warehouse wins, others are recorded as
 * matched-but-not-applied" -- but the algorithm is action-type-general, not
 * hardcoded to routing, so it doesn't need reworking when a second action
 * type is added.
 */
export class RulesEngine {
  constructor(private readonly pool: Pool) {}

  /** Registers this engine's order.received handler on `eventBus`. Called
   *  once during service wiring (by whatever constructs both an
   *  OrderService and a RulesEngine sharing the same bus) -- OrderService
   *  never references RulesEngine directly; this is the other half of that
   *  decoupling. */
  attach(eventBus: EventBus): void {
    eventBus.subscribe<OrderReceivedPayload>(DomainEvent.OrderReceived, (event) => this.handleOrderReceived(event));
  }

  async loadEnabledRules(tenantId: string, triggerEvent: string): Promise<AutomationRule[]> {
    return withTenant(this.pool, tenantId, (client) => this.loadEnabledRulesWithClient(client, tenantId, triggerEvent));
  }

  private async loadEnabledRulesWithClient(
    client: PoolClient,
    tenantId: string,
    triggerEvent: string,
  ): Promise<AutomationRule[]> {
    const result = await client.query<{
      id: string;
      tenant_id: string;
      name: string;
      trigger_event: string;
      conditions: AutomationRuleCondition[];
      actions: AutomationRuleAction[];
      priority: number;
      enabled: boolean;
      created_at: string;
    }>(
      `SELECT id, tenant_id, name, trigger_event, conditions, actions, priority, enabled, created_at
         FROM automation_rules
        WHERE tenant_id = $1 AND trigger_event = $2 AND enabled = true
        ORDER BY priority ASC, created_at ASC`,
      [tenantId, triggerEvent],
    );
    return result.rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      name: row.name,
      triggerEvent: row.trigger_event,
      conditions: row.conditions,
      actions: row.actions,
      priority: row.priority,
      enabled: row.enabled,
      createdAt: row.created_at,
    }));
  }

  /** Pure condition matching -- no DB, no conflict resolution, static since
   *  it depends on nothing instance-specific (easy to golden-file test in
   *  isolation). Returns every rule passed in with its match outcome, not
   *  just the matches, so a caller (or a test) can see the full picture
   *  including what didn't match and why. */
  static evaluate(event: DomainEventEnvelope, rules: AutomationRule[]): RuleEvaluation[] {
    return rules.map((rule) => ({ rule, matched: matchesConditions(rule.conditions, event.payload) }));
  }

  /** Priority-based conflict resolution over the matched subset of
   *  `evaluations` -- see this class's doc comment for the algorithm. Static
   *  for the same reason as evaluate(). Rules are assumed pre-sorted by
   *  (priority ASC, createdAt ASC) (loadEnabledRulesWithClient's ORDER BY
   *  does this); resolveActions re-sorts defensively so it's correct
   *  regardless of evaluate()'s input order too. */
  static resolveActions(evaluations: RuleEvaluation[]): ResolvedAction[] {
    const matched = evaluations
      .filter((e) => e.matched)
      .sort((a, b) => a.rule.priority - b.rule.priority || a.rule.createdAt.localeCompare(b.rule.createdAt));

    const wonActionTypes = new Set<string>();
    const resolved: ResolvedAction[] = [];

    for (const { rule } of matched) {
      for (const action of rule.actions) {
        const applied = !wonActionTypes.has(action.type);
        if (applied) wonActionTypes.add(action.type);
        resolved.push({ rule, action, applied });
      }
    }

    return resolved;
  }

  /**
   * The order.received subscriber (registered via {@link attach}). Loads
   * enabled rules for this trigger, evaluates and resolves them, executes
   * every *applied* action, and writes one rule_executions row per matched
   * rule/action pair (applied or not -- see RuleExecution's doc comment).
   *
   * A single action's execution failure (e.g. route_to_warehouse naming a
   * warehouse that doesn't exist) is caught, recorded in that row's `error`
   * column, and does not stop processing the rest -- order ingestion
   * staying up matters more than any one misconfigured rule, the same
   * reasoning EventBus.publish() applies one level up for a whole
   * subscriber's failure.
   */
  private async handleOrderReceived(event: DomainEventEnvelope<OrderReceivedPayload>): Promise<void> {
    const { tenantId, payload } = event;

    await withTenant(this.pool, tenantId, async (client) => {
      const rules = await this.loadEnabledRulesWithClient(client, tenantId, event.name);
      const resolved = RulesEngine.resolveActions(RulesEngine.evaluate(event, rules));

      for (const { rule, action, applied } of resolved) {
        let error: string | null = null;
        if (applied) {
          try {
            await this.executeAction(client, tenantId, payload.orderId, action);
          } catch (err) {
            error = err instanceof Error ? err.message : String(err);
          }
        }

        await client.query(
          `INSERT INTO rule_executions
             (tenant_id, automation_rule_id, order_id, trigger_event, matched, applied, actions, error)
           VALUES ($1, $2, $3, $4, true, $5, $6, $7)`,
          [tenantId, rule.id, payload.orderId, event.name, applied && !error, JSON.stringify([action]), error],
        );
      }
    });
  }

  /** Dispatches one applied action. Only 'route_to_warehouse' is
   *  implemented (CLAUDE.md §8 Phase 3: "order routing at minimum") --
   *  other action types (notifications, tagging, etc.) are future work, not
   *  built speculatively; an unrecognized type throws (caught by the caller
   *  and recorded as this row's error) rather than silently no-op-ing. */
  private async executeAction(
    client: PoolClient,
    tenantId: string,
    orderId: string,
    action: AutomationRuleAction,
  ): Promise<void> {
    if (action.type !== "route_to_warehouse") {
      throw new Error(`Unrecognized action type '${action.type}' -- not implemented`);
    }

    if (typeof action.value !== "string" || action.value.length === 0) {
      throw new Error(`route_to_warehouse requires a string location name, got ${JSON.stringify(action.value)}`);
    }

    const location = await client.query<{ id: string }>(
      `SELECT id FROM locations WHERE tenant_id = $1 AND name = $2 AND type = 'warehouse'`,
      [tenantId, action.value],
    );
    const locationId = location.rows[0]?.id;
    if (!locationId) {
      throw new Error(`route_to_warehouse: no warehouse location named '${action.value}' for tenant ${tenantId}`);
    }

    await client.query(`UPDATE orders SET preferred_location_id = $1, updated_at = now() WHERE id = $2 AND tenant_id = $3`, [
      locationId,
      orderId,
      tenantId,
    ]);
  }
}
