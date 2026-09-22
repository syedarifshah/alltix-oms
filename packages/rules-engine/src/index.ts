import type { Pool, PoolClient } from "pg";
import { withTenant } from "@alltix/db";
import {
  DomainEvent,
  isValidOrderTransition,
  sendEmail,
  type AutomationRule,
  type AutomationRuleAction,
  type AutomationRuleCondition,
  type DomainEventEnvelope,
  type EventBus,
  type OrderBackorderedPayload,
  type OrderReceivedPayload,
  type OrderStatus,
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

/** An email a `send_notification` action wants sent, built (pure, no I/O)
 *  during rule execution and actually dispatched afterward -- see
 *  {@link RulesEngine.handleOrderEvent}'s doc comment for why the send
 *  itself is deliberately outside that method's DB transaction. */
export interface RuleNotification {
  subject: string;
  text: string;
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
      // The mirror image of "in": there, `actual` is a scalar checked
      // against a list in `condition.value` (e.g. channel in [...]). Here,
      // `actual` (e.g. order.received's lineSkus, CLAUDE.md §8's "per-SKU
      // rule-based routing") is the array, and `condition.value` is the
      // single scalar being looked for in it (e.g. "does this order contain
      // SKU X"). Added specifically for that field, but not hardcoded to
      // it -- any array-valued field/scalar-value pair works the same way.
      case "contains":
        return Array.isArray(actual) && actual.includes(condition.value);
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
 * unlike an arbitrary id comparison). The algorithm is action-type-general,
 * not hardcoded to routing, so it didn't need reworking when a second
 * action type ('hold_order', see {@link executeAction}) was added, or a
 * third ('send_notification', same section).
 *
 * Two trigger events, not one: `order.received` (the original) and
 * `order.backordered` (added alongside `send_notification` -- a backorder
 * running out of stock everywhere is exactly the kind of thing a tenant
 * wants to hear about without watching `/orders` themselves). Both share
 * the same {@link handleOrderEvent} handler -- see its own doc comment for
 * why one generic handler covers any event whose payload carries an
 * `orderId`.
 */
export class RulesEngine {
  constructor(private readonly pool: Pool) {}

  /** Registers this engine's event handlers on `eventBus`. Called once
   *  during service wiring (by whatever constructs both an OrderService and
   *  a RulesEngine sharing the same bus) -- OrderService never references
   *  RulesEngine directly; this is the other half of that decoupling. Both
   *  `order.received` and `order.backordered` route through the same
   *  {@link handleOrderEvent} -- see its own doc comment. */
  attach(eventBus: EventBus): void {
    eventBus.subscribe<OrderReceivedPayload>(DomainEvent.OrderReceived, (event) => this.handleOrderEvent(event));
    eventBus.subscribe<OrderBackorderedPayload>(DomainEvent.OrderBackordered, (event) => this.handleOrderEvent(event));
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
   *  regardless of evaluate()'s input order too.
   *
   *  Tie-break uses `new Date(...)`, not `.localeCompare` on the raw value:
   *  AutomationRule.createdAt is typed `string`, but node-pg actually
   *  returns a real `Date` object for a TIMESTAMPTZ column at runtime (the
   *  same discrepancy already documented on the order detail page's own
   *  timeline sort) -- `.localeCompare` would throw the moment two matched
   *  rules actually need tie-breaking (equal priority, both matching the
   *  same event), which no test exercised before hold-order-integration.test.ts's
   *  two-rules-on-one-tenant scenario surfaced it. `new Date(x)` is a no-op
   *  for an already-Date `x`, so this sorts correctly regardless of which
   *  one a given rule's createdAt actually is. */
  static resolveActions(evaluations: RuleEvaluation[]): ResolvedAction[] {
    const matched = evaluations
      .filter((e) => e.matched)
      .sort(
        (a, b) => a.rule.priority - b.rule.priority || new Date(a.rule.createdAt).getTime() - new Date(b.rule.createdAt).getTime(),
      );

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
   * The shared subscriber for both `order.received` and `order.backordered`
   * (registered via {@link attach}) -- one generic handler rather than two
   * near-identical copies, since both events' payloads narrow to the one
   * thing this method actually needs, `orderId`, and every other step
   * (loading rules for `event.name`, evaluating/resolving, writing
   * `rule_executions`) is already fully generic across trigger events. Loads
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
   *
   * `send_notification` actions are collected into `pendingNotifications`
   * rather than dispatched inline from inside {@link executeAction} --
   * deliberately, and NOT sent until after the surrounding `withTenant`
   * transaction has committed. sendEmail() makes a real outbound HTTP
   * request; making that request while still holding open the same
   * transaction that's writing `rule_executions` (and, for a matched
   * `hold_order`, the order's own status) would tie this transaction's
   * lifetime -- and the connection it holds from the pool -- to an external
   * service's latency, for no benefit (email delivery has no bearing on
   * whether the rest of this transaction should commit). Same
   * "email is additive, not load-bearing" precedent
   * packages/scheduler/src/index.ts's recordSyncFailure() already
   * establishes by calling its own notifyTenantUsers() only after its
   * UPDATE's transaction returns -- this mirrors that, at the level of one
   * whole rule-execution transaction rather than one UPDATE. A consequence
   * worth being explicit about: a `send_notification` action's own
   * `rule_executions` row always records `applied: true, error: null` once
   * its message is built (building the message can't itself fail -- see
   * {@link buildRuleNotification}), regardless of whether the email actually
   * gets delivered afterward -- sendEmail() itself never throws and logs its
   * own failures, matching every other place in this codebase email is
   * fire-and-forget best-effort, not a tracked outcome.
   */
  private async handleOrderEvent(event: DomainEventEnvelope<{ orderId: string }>): Promise<void> {
    const { tenantId, payload } = event;
    const pendingNotifications: RuleNotification[] = [];

    await withTenant(this.pool, tenantId, async (client) => {
      const rules = await this.loadEnabledRulesWithClient(client, tenantId, event.name);
      const resolved = RulesEngine.resolveActions(RulesEngine.evaluate(event, rules));

      for (const { rule, action, applied } of resolved) {
        let error: string | null = null;
        if (applied) {
          try {
            const notification = await this.executeAction(client, tenantId, payload.orderId, action, rule, event.name);
            if (notification) pendingNotifications.push(notification);
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

    for (const notification of pendingNotifications) {
      await this.notifyTenantUsers(tenantId, notification.subject, notification.text);
    }
  }

  /** Dispatches one applied action. Three action types are implemented
   *  today: 'route_to_warehouse' (CLAUDE.md §8 Phase 3: "order routing at
   *  minimum"), 'hold_order' (places a matching order on_hold instead of
   *  letting it proceed toward allocation -- see {@link placeOrderOnHold}),
   *  and 'send_notification' (emails the tenant's own users -- see
   *  {@link buildRuleNotification} and {@link handleOrderEvent}'s own doc
   *  comment on why the actual send happens outside this method/transaction).
   *  Other action types (tagging, webhooks, etc.) are future work, not built
   *  speculatively; an unrecognized type throws (caught by the caller and
   *  recorded as this row's error) rather than silently no-op-ing. */
  private async executeAction(
    client: PoolClient,
    tenantId: string,
    orderId: string,
    action: AutomationRuleAction,
    rule: AutomationRule,
    triggerEvent: string,
  ): Promise<RuleNotification | void> {
    if (action.type === "hold_order") {
      return this.placeOrderOnHold(client, tenantId, orderId);
    }

    if (action.type === "send_notification") {
      return RulesEngine.buildRuleNotification(rule, triggerEvent, orderId, action);
    }

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

  /**
   * hold_order's effect: chains 'received' -> 'validated' -> 'on_hold',
   * both guarded UPDATEs issued directly on the same `client`/transaction
   * this whole rule execution already runs in -- deliberately NOT via
   * OrderService.transition() (@alltix/order-service), which would open its
   * own separate connection/transaction. That would let the order's status
   * change commit independently of, and out of sync with, this method's own
   * rule_executions bookkeeping write in {@link handleOrderReceived} -- the
   * same split-transaction risk allocateOrder/cancelOrder/simpleTransition
   * in OrderService all avoid by staying inline within one transaction.
   * Each step is still validated against isValidOrderTransition() --
   * the exact function OrderService.transition() itself checks -- so this
   * can never drift into an edge the state machine doesn't actually allow.
   *
   * Chains through 'validated' rather than adding a new 'received' ->
   * 'on_hold' edge: CLAUDE.md §3's diagram only draws on_hold branching off
   * 'validated', and changing that diagram is a separate scope decision
   * this pass doesn't make. The order is still 'received' when
   * order.received fires -- this handler runs *during*
   * OrderService.persistPulledOrders()'s publish() call, before that
   * method's own 'received' -> 'validated' -> 'allocated' auto-chain runs.
   * That method re-checks the order's actual status after publish()
   * returns and skips its own chain when a subscriber (this one) already
   * moved the order off 'received' -- see its own doc comment.
   *
   * Lands the order somewhere a human can act on: OrderService's existing
   * 'on_hold' -> 'validated' resume path (and the 'validated' -> 'allocated'
   * manual action next to it on the order detail page) already let staff
   * release a hold placed this way.
   *
   * Only meaningful for an `order.received`-triggered rule -- a rule that
   * puts `hold_order` on an `order.backordered` trigger will always fail
   * this method's own guarded UPDATE (the order is already 'backordered',
   * not 'received') and record that as this row's `error`, same as naming a
   * nonexistent warehouse to `route_to_warehouse` does. Deliberately not
   * specially validated/blocked at rule-creation time -- same "an
   * unrecognized/inapplicable config fails loud in rule_executions, it
   * doesn't get silently rejected upfront" philosophy this class already
   * applies to every other action.
   */
  private async placeOrderOnHold(client: PoolClient, tenantId: string, orderId: string): Promise<void> {
    const steps: ReadonlyArray<readonly [OrderStatus, OrderStatus]> = [
      ["received", "validated"],
      ["validated", "on_hold"],
    ];

    for (const [from, to] of steps) {
      if (!isValidOrderTransition(from, to)) {
        throw new Error(`hold_order: ${from} -> ${to} is not a valid order transition`);
      }

      const result = await client.query(
        `UPDATE orders SET status = $1, updated_at = now() WHERE id = $2 AND tenant_id = $3 AND status = $4`,
        [to, orderId, tenantId, from],
      );
      if (result.rowCount === 0) {
        throw new Error(`hold_order: order ${orderId} is not in status '${from}' -- refusing to continue (concurrent update?)`);
      }
    }
  }

  /**
   * Builds a `send_notification` action's email content -- pure, no I/O, so
   * it can't itself fail (see {@link handleOrderEvent}'s doc comment on what
   * that means for this action's own `rule_executions.error`). Static for
   * the same "no instance state needed" reason evaluate()/resolveActions()
   * are.
   *
   * `action.value` is optional: a string is used verbatim as the message
   * body (letting a tenant write "Restock SKU WIDGET-RED before Friday" or
   * similar instead of a generic line); omitted, `null`, or a
   * whitespace-only string falls back to a generic default referencing the
   * rule name/trigger/order so the email is never blank. Anything else
   * (a number, object, array) is a config mistake, not a valid "no custom
   * message" sentinel -- `executeAction`'s caller in {@link handleOrderEvent}
   * catches the thrown error and records it on this row the same way
   * route_to_warehouse's own value-shape validation does.
   */
  private static buildRuleNotification(
    rule: AutomationRule,
    triggerEvent: string,
    orderId: string,
    action: AutomationRuleAction,
  ): RuleNotification {
    if (action.value !== undefined && action.value !== null && typeof action.value !== "string") {
      throw new Error(`send_notification's value must be a string message or omitted, got ${JSON.stringify(action.value)}`);
    }
    const customMessage = typeof action.value === "string" && action.value.trim().length > 0 ? action.value.trim() : null;

    return {
      subject: `Automation alert: ${rule.name}`,
      text: [
        customMessage ?? `Your automation rule "${rule.name}" matched a ${triggerEvent} event for order ${orderId}.`,
        "",
        `View this order: /orders/${orderId}`,
      ].join("\n"),
    };
  }

  /**
   * Emails every one of this tenant's own `users` -- a near-literal fork of
   * packages/scheduler/src/index.ts's own notifyTenantUsers() (same query,
   * same "reuse the existing users table as the recipient list, no new
   * notification-preferences schema" reasoning, same reliance on migration
   * 0030_users_tenant_scoped_select_policy.sql's tenant-scoped SELECT policy
   * -- without it this SELECT silently returns zero rows under RLS, see
   * that migration's own doc comment for the real bug this already caused
   * once). Not shared/imported from @alltix/scheduler on purpose:
   * rules-engine has no existing dependency on scheduler (and shouldn't
   * gain one just for this -- scheduler is the cron/job-runner layer,
   * rules-engine is a domain-event subscriber, pulling one into the other's
   * dependency graph for a five-line query is the wrong direction), and the
   * query itself is small enough that duplicating it here is cheaper than
   * the abstraction would be -- same "not enough shared shape yet" call
   * this codebase's own channel connectors make repeatedly (CLAUDE.md
   * §4.2/§4.5's own "kept as parallel functions" notes).
   *
   * A tenant with zero users is a silent no-op via sendEmail()'s own
   * empty-recipients guard, not an error -- same reasoning as the scheduler
   * original.
   */
  private async notifyTenantUsers(tenantId: string, subject: string, message: string): Promise<void> {
    const recipients = await withTenant(this.pool, tenantId, (client) =>
      client.query<{ email: string }>(`SELECT DISTINCT email FROM users WHERE tenant_id = $1`, [tenantId]),
    );
    await sendEmail({
      to: recipients.rows.map((r) => r.email),
      subject,
      text: message,
    });
  }
}
