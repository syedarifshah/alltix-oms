import type { NextRequest } from "next/server";
import { withTenant } from "@alltix/db";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

/**
 * POST /api/locations/[id]/set-postal-code -- the /locations page's inline
 * "Set ZIP" form, a separate route from ./rename rather than one more field
 * bolted onto that form: rename's own doc comment is specifically about why
 * `name` is the only thing it edits, and postal_code is an orthogonal,
 * always-optional concept (see migration 0027_locations_postal_code.sql)
 * with nothing in common with the type-immutability reasoning that route
 * documents.
 *
 * Feeds OrderService's own `rankByDistanceToShippingZip` (CLAUDE.md §8 Phase
 * 4's "nearest-location-by-shipping-address routing") -- an empty submission
 * clears it back to null (unknown distance, the pre-existing
 * oldest-created-first fallback), same as create's own `|| null` handling,
 * rather than rejecting a blank value outright.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const user = await requireCurrentUser(req, getAppPool());
  if (!user) {
    return redirectWithError(req, "/locations", "not signed in");
  }

  const { id } = await ctx.params;
  const formData = await req.formData();
  const postalCode = String(formData.get("postalCode") ?? "").trim() || null;

  try {
    const result = await withTenant(getAppPool(), user.tenantId, (client) =>
      client.query(`UPDATE locations SET postal_code = $1, updated_at = now() WHERE id = $2 AND tenant_id = $3`, [
        postalCode,
        id,
        user.tenantId,
      ]),
    );
    if (result.rowCount === 0) {
      return redirectWithError(req, "/locations", "location_not_found");
    }
  } catch (err) {
    return redirectWithError(req, "/locations", `location_postal_code_failed:${errorMessage(err)}`);
  }

  return redirectTo(req, "/locations?location_postal_code_set=1");
}
