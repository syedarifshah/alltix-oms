import type { PoolClient } from "pg";

/**
 * General-purpose audit trail -- CLAUDE.md §6's "architect logging/access-
 * control from day one" line (see CLAUDE.md's "Audit Log" section for the
 * full design and which routes/services are instrumented). Backed by
 * migration 0034_audit_log.sql's `audit_log` table.
 *
 * Lives in @alltix/db, not packages/web/src/lib (where it was originally
 * built) -- audit coverage grew from four web-route call sites to also
 * cover OrderService/WarehouseService/InventoryService's own methods (see
 * CLAUDE.md's "Audit Log" section, "Coverage" paragraph), and those three
 * packages don't depend on @alltix/web (nor should they start to, just for
 * this). @alltix/db is the one package every one of them (and web itself)
 * already depends on, so this is the natural shared home -- not a new
 * dependency edge, just moving a leaf function to where its callers
 * actually are.
 *
 * Deliberately takes an already-open, tenant-scoped `client` rather than a
 * pool-level convenience the way channel-flags.ts/rate-limit.ts each offer
 * one -- every call site this is wired into already does its own mutation
 * via `withTenant(pool, tenantId, (client) => client.query(...))`, so
 * recording the audit row through that SAME client, in the SAME
 * transaction, is what makes it atomic with the mutation it describes: if
 * the mutation rolls back, so does the audit row, and there is never a
 * committed audit entry for a mutation that didn't actually happen. A
 * pool-level convenience would only invite a SEPARATE transaction --
 * deliberately not offered here so a future caller can't reach for the
 * easy version and lose that guarantee by accident.
 */
export interface AuditEvent {
  tenantId: string;
  /** null for an operator-run script or a system-initiated action with no
   *  signed-in Clerk session (see the migration's own doc comment on
   *  user_id) -- never invent a placeholder user row to avoid passing null
   *  here. A service-layer call with no human actor in the loop (an
   *  internal auto-validate/auto-allocate step, a webhook-triggered
   *  cancellation) is exactly this case, same as an operator script. */
  userId: string | null;
  /** Dot-namespaced, e.g. "rule.created", "order.transitioned" -- see the
   *  migration's own doc comment on why this is free text. */
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
