import type { ReactElement } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { withTenant } from "@alltix/db";
import type { AutomationRuleAction, AutomationRuleCondition } from "@alltix/shared";
import { getAppPool } from "@/lib/db";
import { getAuthContext } from "@/lib/auth-context";
import { resolveTenantId } from "@/lib/with-tenant-auth";

export const dynamic = "force-dynamic";

interface RuleRow {
  id: string;
  name: string;
  trigger_event: string;
  conditions: AutomationRuleCondition[];
  actions: AutomationRuleAction[];
  priority: number;
  enabled: boolean;
  created_at: string;
  last_applied: boolean | null;
  last_matched: boolean | null;
  last_error: string | null;
  last_executed_at: string | null;
  last_order_id: string | null;
}

function formatCondition(c: AutomationRuleCondition): string {
  return `${c.field} ${c.op} ${JSON.stringify(c.value)}`;
}

function formatAction(a: AutomationRuleAction): string {
  return `${a.type} → ${JSON.stringify(a.value)}`;
}

interface RulesPageProps {
  searchParams: Promise<{ error?: string }>;
}

/**
 * View/manage automation_rules (CLAUDE.md §1 Rules/Automation Engine --
 * "build it early, not as a v2 feature"). Only trigger_event
 * 'order.received' and action type 'route_to_warehouse' are actually
 * implemented by RulesEngine today (see packages/rules-engine/src/index.ts)
 * -- the create form below doesn't hard-restrict those fields (a rule for an
 * unimplemented trigger/action is harmless to store, just inert), but the
 * defaults point at what actually works, and this page says so plainly
 * rather than implying more automation exists than does. Conditions/actions
 * are edited as raw JSON, per this pass's explicit scope call -- a visual
 * condition/action builder is future work.
 */
export default async function RulesPage({ searchParams }: RulesPageProps): Promise<ReactElement> {
  const authContext = await getAuthContext(await headers());
  if (!authContext) {
    redirect("/sign-in");
  }

  const pool = getAppPool();
  const tenantId = await resolveTenantId(pool, authContext.clerkUserId);
  const { error } = await searchParams;

  if (!tenantId) {
    return (
      <main className="page">
        <h1>Rules</h1>
        <p>No tenant is associated with this account yet.</p>
      </main>
    );
  }

  const rules = await withTenant(pool, tenantId, async (client) => {
    const result = await client.query<RuleRow>(
      `SELECT ar.id, ar.name, ar.trigger_event, ar.conditions, ar.actions, ar.priority, ar.enabled, ar.created_at,
              le.applied AS last_applied, le.matched AS last_matched, le.error AS last_error,
              le.created_at AS last_executed_at, le.order_id AS last_order_id
         FROM automation_rules ar
         LEFT JOIN LATERAL (
           SELECT applied, matched, error, created_at, order_id
             FROM rule_executions re
            WHERE re.automation_rule_id = ar.id
            ORDER BY re.created_at DESC
            LIMIT 1
         ) le ON true
        ORDER BY ar.priority ASC, ar.created_at ASC`,
    );
    return result.rows;
  });

  return (
    <main className="page">
      <h1>Rules</h1>
      <p className="subtitle">
        Order-routing automation (order.received → route_to_warehouse). Lower priority number wins when two enabled
        rules&apos; actions of the same type conflict.
      </p>

      {error && <div className="alert alert-danger">{decodeURIComponent(error)}</div>}

      {rules.length === 0 ? (
        <p className="empty">No rules yet.</p>
      ) : (
        <div className="stack">
          {rules.map((rule) => (
            <div className="card" key={rule.id}>
              <div className="row">
                <strong>{rule.name}</strong>
                <span className="badge">{rule.trigger_event}</span>
                <span className="badge">priority {rule.priority}</span>
                <span className={rule.enabled ? "badge badge-success" : "badge"}>{rule.enabled ? "enabled" : "disabled"}</span>
                <form action={`/api/rules/${rule.id}/toggle`} method="POST">
                  <button type="submit" className="secondary">
                    {rule.enabled ? "Disable" : "Enable"}
                  </button>
                </form>
              </div>

              <div style={{ marginTop: 10 }}>
                <div className="muted">Conditions (all must match):</div>
                {rule.conditions.length === 0 ? (
                  <div className="muted">— none, matches every event —</div>
                ) : (
                  <ul>
                    {rule.conditions.map((c, i) => (
                      <li key={i} className="mono">
                        {formatCondition(c)}
                      </li>
                    ))}
                  </ul>
                )}

                <div className="muted">Actions:</div>
                <ul>
                  {rule.actions.map((a, i) => (
                    <li key={i} className="mono">
                      {formatAction(a)}
                    </li>
                  ))}
                </ul>

                <details>
                  <summary>Raw JSON</summary>
                  <pre>{JSON.stringify({ conditions: rule.conditions, actions: rule.actions }, null, 2)}</pre>
                </details>
              </div>

              <div className="muted" style={{ marginTop: 10 }}>
                {rule.last_executed_at ? (
                  <>
                    Last ran {new Date(rule.last_executed_at).toISOString()} against order{" "}
                    <a href={`/orders/${rule.last_order_id}`}>{rule.last_order_id?.slice(0, 8)}</a>:{" "}
                    {!rule.last_matched ? "did not match" : rule.last_applied ? "applied" : "matched, not applied"}
                    {rule.last_error ? ` — error: ${rule.last_error}` : ""}
                  </>
                ) : (
                  "Never evaluated yet."
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <h2>New rule</h2>
      <form action="/api/rules" method="POST" className="card stack">
        <div className="form-row">
          <label htmlFor="name">Name</label>
          <input id="name" type="text" name="name" required />
        </div>
        <div className="row">
          <div className="form-row">
            <label htmlFor="triggerEvent">Trigger event</label>
            <input id="triggerEvent" type="text" name="triggerEvent" defaultValue="order.received" required />
          </div>
          <div className="form-row">
            <label htmlFor="priority">Priority (lower = higher priority)</label>
            <input id="priority" type="number" name="priority" defaultValue={100} required />
          </div>
          <div className="form-row">
            <label htmlFor="enabled">Enabled</label>
            <input id="enabled" type="checkbox" name="enabled" defaultChecked />
          </div>
        </div>
        <div className="form-row">
          <label htmlFor="conditions">Conditions — JSON array of field/op/value objects, e.g.:</label>
          <pre className="mono" style={{ margin: 0 }}>
            {`[{"field": "channel", "op": "eq", "value": "amazon"}]`}
          </pre>
          <textarea id="conditions" name="conditions" rows={3} defaultValue="[]" className="mono" />
        </div>
        <div className="form-row">
          <label htmlFor="actions">
            Actions (JSON array — only &quot;route_to_warehouse&quot; is implemented, value = a warehouse location
            name)
          </label>
          <textarea
            id="actions"
            name="actions"
            rows={3}
            defaultValue={'[{"type":"route_to_warehouse","value":""}]'}
            className="mono"
          />
        </div>
        <div>
          <button type="submit">Create rule</button>
        </div>
      </form>
    </main>
  );
}
