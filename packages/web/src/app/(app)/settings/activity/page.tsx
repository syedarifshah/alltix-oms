import type { ReactElement } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { withTenant } from "@alltix/db";
import { getAppPool } from "@/lib/db";
import { getAuthContext } from "@/lib/auth-context";
import { resolveTenantId } from "@/lib/with-tenant-auth";

export const dynamic = "force-dynamic";

/** How many rows this page shows -- a plain LIMIT, no pagination UI yet
 *  (same "start simple" call /orders and /reports already made before
 *  either grew a real filter/pagination story). Ordered newest-first, so
 *  the cap just means "recent activity," not a hard retention limit --
 *  audit_log itself keeps every row forever (see migration
 *  0034_audit_log.sql's own append-only design). */
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

/**
 * Read-only activity feed over `audit_log` (migration 0034) -- CLAUDE.md §6's
 * "architect logging/access-control from day one" line, and the read half of
 * the write-only trail that instrumenting routes alone would leave nobody
 * able to actually see. Deliberately no filter/search UI yet, same "start
 * simple" call every other first-pass list page in this app makes.
 *
 * The join to `users` (for `actor_email`) only works because of this
 * migration's own second RLS policy, `tenant_scoped_read_users` -- see its
 * doc comment in the migration for why the table's original policy
 * (self-lookup only) couldn't already do this. A NULL actor_email means an
 * operator-run script (e.g. scripts/set-channel-flags.ts), not a missing
 * join -- see audit-log.ts's own doc comment on why user_id is nullable.
 */
export default async function ActivityPage(): Promise<ReactElement> {
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

  const rows = await withTenant(pool, tenantId, async (client) => {
    const result = await client.query<AuditLogRow>(
      `SELECT al.id, al.action, al.entity_type, al.entity_id, al.details, al.created_at,
              u.email AS actor_email
         FROM audit_log al
         LEFT JOIN users u ON u.id = al.user_id
        WHERE al.tenant_id = $1
        ORDER BY al.created_at DESC
        LIMIT $2`,
      [tenantId, ROW_LIMIT],
    );
    return result.rows;
  });

  return (
    <main className="page">
      <h1>Activity</h1>
      <p className="subtitle">
        The last {ROW_LIMIT} tracked changes for your account -- who created or toggled a rule, changed a setting,
        and when. Not every action in the app is tracked yet; see CLAUDE.md&apos;s &quot;Audit Log&quot; section for
        which ones are.
      </p>

      {rows.length === 0 ? (
        <p className="empty">No tracked activity yet.</p>
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
    </main>
  );
}
