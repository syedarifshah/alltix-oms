import type { NextRequest } from "next/server";
import { withTenant } from "@alltix/db";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

/** POST /api/rules/[id]/toggle -- flips one automation_rules row's
 *  `enabled` flag. RLS (tenant_isolation_automation_rules) is what actually
 *  stops this from touching another tenant's rule; the WHERE clause below
 *  is just the normal scoping every query in this app uses on top of that. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const user = await requireCurrentUser(req, getAppPool());
  if (!user) {
    return redirectWithError(req, "/rules", "not signed in");
  }

  const { id } = await ctx.params;

  try {
    const result = await withTenant(getAppPool(), user.tenantId, (client) =>
      client.query(
        `UPDATE automation_rules SET enabled = NOT enabled, updated_at = now() WHERE id = $1 AND tenant_id = $2`,
        [id, user.tenantId],
      ),
    );
    if (result.rowCount === 0) {
      return redirectWithError(req, "/rules", `Rule ${id} not found.`);
    }
  } catch (err) {
    return redirectWithError(req, "/rules", errorMessage(err));
  }

  return redirectTo(req, "/rules");
}
