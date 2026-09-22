import type { PoolClient } from "pg";

/**
 * General-purpose audit trail -- CLAUDE.md §6's "architect logging/access-
 * control from day one" line, closed for the highest-value mutations (see
 * CLAUDE.md's "Audit Log" section for the full design and which routes are
 * instrumented). Backed by migration 0034_audit_log.sql's `audit_log`
 * table.
 *
 * Deliberately takes an already-open, tenant-scoped `client` rather than a
 * pool-level convenience the way channel-flags.ts/rate-limit.ts each offer
 * one -- every route this is wired into already does its own mutation via
 * `withTenant(pool, tenantId, (client) => client.query(...))`, so recording
 * the audit row through that SAME client, in the SAME transaction, is what
 * makes it atomic with the mutation it describes: if the mutation rolls
 * back, so does the audit row, and there is never a committed audit entry
 * for a mutation that didn't actually happen. A pool-level convenience
 * would only invite a SEPARATE transaction -- deliberately not offered
 * here so a future caller can't reach for the easy version and lose that
 * guarantee by accident.
 */
export interface AuditEvent {
  tenantId: string;
  /** null for an operator-run script with no signed-in Clerk session (see
   *  the migration's own doc comment on user_id) -- never invent a
   *  placeholder user row to avoid passing null here. */
  userId: string | null;
  /** Dot-namespaced, e.g. "rule.created", "settings.reorder_threshold_changed"
   *  -- see the migration's own doc comment on why this is free text. */
  action: string;
  entityType: string;
  entityId?: string | null;
  details?: Record<string, unknown> | null;
}

export async function recordAuditEvent(client: PoolClient, event: AuditEvent): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (tenant_id, user_id, action, entity_type, entity_id, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      event.tenantId,
      event.userId,
      event.action,
      event.entityType,
      event.entityId ?? null,
      event.details ? JSON.stringify(event.details) : null,
    ],
  );
}
