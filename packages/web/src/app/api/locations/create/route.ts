import type { NextRequest } from "next/server";
import { withTenant } from "@alltix/db";
import type { LocationType } from "@alltix/shared";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

/** locations.type's CHECK constraint (migration 0002), duplicated here as a
 *  literal array rather than importing packages/db/migrations SQL -- same
 *  "validate against a real TS union before ever hitting the DB" reasoning
 *  every other form-POST route in this app follows (e.g. /api/products/create's
 *  unique-violation handling), so a bad value gets a friendly redirect
 *  error instead of a raw Postgres constraint-violation message. */
const LOCATION_TYPES: readonly LocationType[] = ["warehouse", "3pl", "fba", "wfs"];

/**
 * POST /api/locations/create -- the /locations page's "Add a location" form.
 * Until this route existed, the only way a tenant got a second location was
 * indirectly: packages/scheduler's Shopify catalog sync lazily creates
 * exactly one default warehouse the first time it needs somewhere to seed
 * stock (see CATALOG_SYNC_LOCATION_NAME in packages/scheduler/src/index.ts)
 * -- there was no way to add a *second* one (a real 3PL, an FBA/WFS
 * placeholder, or just a second physical warehouse) without a manual SQL
 * insert. That directly capped the value of InventoryService.transferStock()
 * (CLAUDE.md §2.2) -- its own /inventory form only renders once a tenant has
 * 2+ locations -- and of the rules engine's route_to_warehouse action, which
 * needs somewhere real to route to.
 *
 * Same form-POST-then-redirect-with-?error= shape as every other
 * page-driven mutation in this app.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireCurrentUser(req, getAppPool());
  if (!user) {
    return redirectWithError(req, "/locations", "not signed in");
  }

  const formData = await req.formData();
  const name = String(formData.get("name") ?? "").trim();
  const type = String(formData.get("type") ?? "").trim();

  if (!name || !type) {
    return redirectWithError(req, "/locations", "location_missing_fields");
  }
  if (!LOCATION_TYPES.includes(type as LocationType)) {
    return redirectWithError(req, "/locations", "location_invalid_type");
  }

  try {
    await withTenant(getAppPool(), user.tenantId, (client) =>
      client.query(`INSERT INTO locations (tenant_id, name, type) VALUES ($1, $2, $3)`, [user.tenantId, name, type]),
    );
  } catch (err) {
    return redirectWithError(req, "/locations", `location_create_failed:${errorMessage(err)}`);
  }

  return redirectTo(req, "/locations?location_created=1");
}
