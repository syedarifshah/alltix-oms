import type { ReactElement } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { withTenant } from "@alltix/db";
import { getAppPool } from "@/lib/db";
import { getAuthContext } from "@/lib/auth-context";
import { resolveTenantId } from "@/lib/with-tenant-auth";

export const dynamic = "force-dynamic";

/** How many rows one page shows. Ordered newest-first; "Show older" (below)
 *  pages back through history via a keyset cursor on `created_at`, not
 *  OFFSET -- same reasoning CLAUDE.md's own rate-limit-window cleanup job
 *  gives for not scanning a growing table by position: audit_log keeps
 *  every row forever (migration 0034's append-only design), so this table
 *  only grows, and an OFFSET-based "page 2" would get more expensive, and
 *  more likely to skip/duplicate a row under concurrent writes, the further
 *  back a tenant pages. */
const ROW_LIMIT = 200;

interface AuditLogRow {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
  actor_email: string | null;
}

/** "rule.created" -> "Rule created"; "settings.reorder_threshold_changed" ->
 *  "Settings reorder threshold changed". Every action string in this
 *  codebase follows the same dot-namespaced, underscore-separated
 *  convention (see audit-log.ts's own doc comment) -- this is a generic
 *  formatter, not a per-action lookup table, so a new instrumented route
 *  needs no change here to render sensibly. */
function describeAction(action: string): string {
  const words = action.replace(/[._]/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Parses `?before=` into a Date, or null for "no cursor, first page" --
 *  rejects anything that doesn't round-trip through `new Date(...)`, the
 *  same "trust the guarded query, not the raw input" posture every other
 *  searchParams-driven filter in this app takes (see OrdersPage's own
 *  `validFilter` for the precedent) rather than letting a malformed value
 *  reach the query and silently match nothing. */
function parseBeforeCursor(raw: string | undefined): Date | null {
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

interface ActivityPageProps {
  searchParams: Promise<{ entityType?: string; before?: string }>;
}

/**
 * Read-only activity feed over `audit_log` (migration 0034) -- CLAUDE.md §6's
 * "architect logging/access-control from day one" line, and the read half of
 * the write-only trail that instrumenting routes alone would leave nobody
 * able to actually see.
 *
 * Filter tabs by `entity_type` (below) are derived from what's actually in
 * THIS tenant's own audit_log, not a hardcoded list -- entity_type is free
 * text, same reasoning `action`/`describeAction()` already document, and a
 * hardcoded list would need editing every time a new instrumented route
 * introduces a new one (order.transitioned/picklist.created/
 * inventory.transferred all landed in the same pass that added this filter,
 * for exactly that reason). Same `?status=` searchParams-driven tab pattern
 * OrdersPage already established, not a client-side filter -- this page
 * still works with no client JS.
 *
 * "Show older" pages backward via a `before` keyset cursor on `created_at`
 * (see ROW_LIMIT's own doc comment for why not OFFSET), carrying the current
 * `entityType` filter along so paging doesn't silently reset it.
 *
 * The join to `users` (for `actor_email`) only works because of this
 * migration's own second RLS policy, `tenant_scoped_read_users` -- see its
 * doc comment in the migration for why the table's original policy
 * (self-lookup only) couldn't already do this. A NULL actor_email means an
 * operator-run script (e.g. scripts/set-channel-flags.ts), not a missing
 * join -- see audit-log.ts's own doc comment on why user_id is nullable.
 */
export default async function ActivityPage({ searchParams }: ActivityPageProps): Promise<ReactElement> {
  const authContext = await getAuthContext(await headers());
  if (!authContext) {
    redirect("/sign-in");
  }

  const pool = getAppPool();
  const tenantId = await resolveTenantId(pool, authContext.clerkUserId);

  if (!tenantId) {
    return (
      <main className="page">
        <h1>Activity</h1>
        <p>No tenant is associated with this account yet.</p>
      </main>
    );
  }

  const { entityType, before: beforeRaw } = await searchParams;
  const beforeCursor = parseBeforeCursor(beforeRaw);

  const { rows, entityTypes, entityTypeFilter } = await withTenant(pool, tenantId, async (client) => {
    const entityTypesResult = await client.query<{ entity_type: string }>(
      `SELECT DISTINCT entity_type FROM audit_log WHERE tenant_id = $1 ORDER BY entity_type`,
      [tenantId],
    );
    const knownEntityTypes = entityTypesResult.rows.map((r) => r.entity_type);
    const entityTypeFilter = entityType && knownEntityTypes.includes(entityType) ? entityType : null;

    const result = await client.query<AuditLogRow>(
      `SELECT al.id, al.action, al.entity_type, al.entity_id, al.details, al.created_at,
              u.email AS actor_email
         FROM audit_log al
         LEFT JOIN users u ON u.id = al.user_id
        WHERE al.tenant_id = $1
          AND ($2::text IS NULL OR al.entity_type = $2)
          AND ($3::timestamptz IS NULL OR al.created_at < $3)
        ORDER BY al.created_at DESC
        LIMIT $4`,
      [tenantId, entityTypeFilter, beforeCursor, ROW_LIMIT],
    );
    return { rows: result.rows, entityTypes: knownEntityTypes, entityTypeFilter };
  });

  const lastRow = rows[rows.length - 1];
  const tabHref = (type: string | null) => (type ? `/settings/activity?entityType=${encodeURIComponent(type)}` : "/settings/activity");
  const olderHref =
    lastRow && rows.length === ROW_LIMIT
      ? // node-pg returns a `timestamptz` column as a real Date, not a string
        // (this file's own AuditLogRow['created_at']: string annotation
        // predates this cursor and is optimistic about that -- `new Date(...)`
        // below normalizes either way rather than trusting it) -- explicitly
        // formatted as ISO so the cursor round-trips through parseBeforeCursor
        // exactly, regardless of the runtime type.
        `/settings/activity?before=${encodeURIComponent(new Date(lastRow.created_at).toISOString())}${
          entityTypeFilter ? `&entityType=${encodeURIComponent(entityTypeFilter)}` : ""
        }`
      : null;

  return (
    <main className="page">
      <h1>Activity</h1>
      <p className="subtitle">
        Tracked changes for your account -- who created or toggled a rule, transitioned an order, generated a
        picklist, transferred stock, or changed a setting, and when. Not every action in the app is tracked yet; see
        CLAUDE.md&apos;s &quot;Audit Log&quot; section for which ones are.
        {beforeCursor && " Showing activity before " + beforeCursor.toISOString() + "."}
      </p>

      {entityTypes.length > 0 && (
        <div className="tabs">
          <a href={tabHref(null)} className={`tab ${entityTypeFilter === null ? "active" : ""}`}>
            All
          </a>
          {entityTypes.map((type) => (
            <a key={type} href={tabHref(type)} className={`tab ${entityTypeFilter === type ? "active" : ""}`}>
              {type}
            </a>
          ))}
        </div>
      )}

      {rows.length === 0 ? (
        <p className="empty">No tracked activity{entityTypeFilter ? ` for '${entityTypeFilter}'` : ""} yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Entity</th>
                <th>Who</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{new Date(row.created_at).toISOString()}</td>
                  <td>{describeAction(row.action)}</td>
                  <td className="muted">
                    {row.entity_type}
                    {row.entity_id ? ` (${row.entity_id})` : ""}
                  </td>
                  <td>{row.actor_email ?? "system (operator script)"}</td>
                  <td className="muted">{row.details ? JSON.stringify(row.details) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {olderHref && (
        <p>
          <a href={olderHref}>Show older activity →</a>
        </p>
      )}
    </main>
  );
}
