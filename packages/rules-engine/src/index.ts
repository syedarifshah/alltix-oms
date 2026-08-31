import type { Pool } from "pg";
import { withTenant } from "@alltix/db";
import type {
  AutomationRule,
  AutomationRuleAction,
  DomainEventEnvelope,
} from "@alltix/shared";

/**
 * Evaluates stored condition -> action `automation_rules` against incoming
 * domain events (CLAUDE.md §1). Deliberately built as its own module rather
 * than deferred — CLAUDE.md §11 calls out treating this as a "v2 feature" as
 * a common failure mode. Skeleton only: no condition matching or action
 * dispatch is implemented yet.
 */
export class RulesEngine {
  constructor(private readonly pool: Pool) {}

  async loadEnabledRules(tenantId: string, triggerEvent: string): Promise<AutomationRule[]> {
    return withTenant(this.pool, tenantId, async () => {
      void triggerEvent;
      throw new Error("RulesEngine.loadEnabledRules: not implemented");
    });
  }

  /** Returns the actions from every rule whose conditions all match the event. */
  evaluate(event: DomainEventEnvelope, rules: AutomationRule[]): AutomationRuleAction[] {
    void event;
    void rules;
    throw new Error("RulesEngine.evaluate: not implemented");
  }
}
