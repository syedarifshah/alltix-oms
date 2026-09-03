-- Expand-only, backward-compatible (CLAUDE.md §9): nullable, no backfill
-- needed. Set by the rules engine's route_to_warehouse action while an
-- order is still 'received' (before allocation); allocateOrder() allocates
-- against this location instead of its default choice when it's present.
ALTER TABLE orders ADD COLUMN preferred_location_id UUID REFERENCES locations (id);

-- One row per rule *evaluation attempt* against a matched event, not just
-- successful ones -- so "why did/didn't order X route to WH-2" is
-- answerable after the fact, and isn't lost once automation_rules itself is
-- later edited. See RuleExecution in packages/shared/src/types.ts and
-- RulesEngine.evaluate()/executeActions().
CREATE TABLE rule_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  automation_rule_id UUID NOT NULL REFERENCES automation_rules (id),
  order_id UUID NOT NULL REFERENCES orders (id),
  trigger_event TEXT NOT NULL,
  matched BOOLEAN NOT NULL,
  applied BOOLEAN NOT NULL,
  actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_rule_executions_tenant_id ON rule_executions (tenant_id);
CREATE INDEX idx_rule_executions_order_id ON rule_executions (tenant_id, order_id);
CREATE INDEX idx_rule_executions_rule_id ON rule_executions (tenant_id, automation_rule_id);

ALTER TABLE rule_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rule_executions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_rule_executions ON rule_executions
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Audit log: no UPDATE/DELETE grant, same reasoning as inventory_events.
GRANT SELECT, INSERT ON rule_executions TO app_user;
