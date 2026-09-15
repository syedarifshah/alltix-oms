import type { NextRequest } from "next/server";
import { withTenant } from "@alltix/db";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

/**
 * POST /api/locations/[id]/rename -- the /locations page's inline rename
 * form. Only `name` is editable here, deliberately -- `type` stays fixed
 * once a location is created (see /locations page's own doc comment for
 * why: allocateOrder() filters allocation candidates by `type = 'warehouse'`
 * and a rule's route_to_warehouse action can already be pointing at this
 * location's id, so silently reclassifying it away from 'warehouse' later
 * could break an in-flight allocation or a saved rule in a way that's hard
 * to trace back to "someone edited a location"). There is deliberately no
 * delete -- same "a location is a workflow record, not something the app
 * ever removes" precedent as orders/picklists elsewhere in this app; it's
 * also referenced by inventory_levels/picklists/orders.preferred_location_id
 * with no ON DELETE behavior, so a real delete would need to reckon with
 * all of that first.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const user = await requireCurrentUser(req, getAppPool());
  if (!user) {
    return redirectWithError(req, "/locations", "not signed in");
  }

  const { id } = await ctx.params;
  const formData = await req.formData();
  const name = String(formData.get("name") ?? "").trim();

  if (!name) {
    return redirectWithError(req, "/locations", "location_missing_fields");
  }

  try {
    const result = await withTenant(getAppPool(), user.tenantId, (client) =>
      client.query(`UPDATE locations SET name = $1, updated_at = now() WHERE id = $2 AND tenant_id = $3`, [
        name,
        id,
        user.tenantId,
      ]),
    );
    if (result.rowCount === 0) {
      return redirectWithError(req, "/locations", "location_not_found");
    }
  } catch (err) {
    return redirectWithError(req, "/locations", `location_rename_failed:${errorMessage(err)}`);
  }

  return redirectTo(req, "/locations?location_renamed=1");
}
