import type { ReactElement } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { withTenant } from "@alltix/db";
import type { LocationType } from "@alltix/shared";
import { getAppPool } from "@/lib/db";
import { getAuthContext } from "@/lib/auth-context";
import { resolveTenantId } from "@/lib/with-tenant-auth";

export const dynamic = "force-dynamic";

interface LocationRow {
  id: string;
  name: string;
  type: LocationType;
  created_at: string;
  product_count: string;
  total_on_hand: string;
}

interface LocationsPageProps {
  searchParams: Promise<{ error?: string; location_created?: string; location_renamed?: string }>;
}

const LOCATION_TYPE_OPTIONS: Array<{ value: LocationType; label: string }> = [
  { value: "warehouse", label: "Warehouse" },
  { value: "3pl", label: "3PL" },
  { value: "fba", label: "FBA (Amazon)" },
  { value: "wfs", label: "WFS (Walmart)" },
];

/**
 * Locations management -- until this page existed, a tenant only ever had
 * exactly one location, lazily auto-created as a side effect of the first
 * Shopify catalog sync (packages/scheduler's CATALOG_SYNC_LOCATION_NAME);
 * there was no way to add a second warehouse, a real 3PL, or an FBA/WFS
 * placeholder without a manual SQL insert. That capped the value of two
 * things already built: InventoryService.transferStock() (CLAUDE.md §2.2,
 * /inventory's own "Transfer stock" form only renders once a tenant has 2+
 * locations) and the rules engine's route_to_warehouse action (needs a real
 * location id to point at). Create + rename only -- see the rename route's
 * own doc comment for why `type` is fixed after creation and why there's no
 * delete.
 *
 * The product/stock columns are a read-only summary straight off
 * inventory_levels (CLAUDE.md §2.2's derived rollup) -- purely informational,
 * so a tenant can see what's actually sitting at a location before deciding
 * where to route or transfer next; this page never writes to that table
 * itself.
 *
 * Same auth/tenant pattern as every other page in this app -- see
 * src/app/orders/page.tsx's doc comment.
 */
export default async function LocationsPage({ searchParams }: LocationsPageProps): Promise<ReactElement> {
  const authContext = await getAuthContext(await headers());
  if (!authContext) {
    redirect("/sign-in");
  }

  const pool = getAppPool();
  const tenantId = await resolveTenantId(pool, authContext.clerkUserId);
  const { error, location_created: locationCreated, location_renamed: locationRenamed } = await searchParams;

  if (!tenantId) {
    return (
      <main className="page">
        <h1>Locations</h1>
        <p>No tenant is associated with this account yet.</p>
      </main>
    );
  }

  const locations = await withTenant(pool, tenantId, async (client) => {
    const result = await client.query<LocationRow>(
      `SELECT loc.id, loc.name, loc.type, loc.created_at,
              count(il.product_id)::text AS product_count,
              coalesce(sum(il.on_hand), 0)::text AS total_on_hand
         FROM locations loc
         LEFT JOIN inventory_levels il ON il.location_id = loc.id
        GROUP BY loc.id
        ORDER BY loc.created_at`,
    );
    return result.rows;
  });

  return (
    <main className="page">
      <h1>Locations</h1>
      <p className="subtitle">Warehouses, 3PLs, and FBA/WFS placeholders you can allocate, pick, and transfer stock between.</p>

      {locationCreated === "1" && <div className="alert alert-success">Location added.</div>}
      {locationRenamed === "1" && <div className="alert alert-success">Location renamed.</div>}
      {error && <div className="alert alert-danger">{describeError(error)}</div>}

      <details className="stack" style={{ marginBottom: 16 }}>
        <summary>Add a location</summary>
        <form action="/api/locations/create" method="POST" className="row" style={{ gap: 6, marginTop: 8 }}>
          <input type="text" name="name" placeholder="Main Warehouse" required />
          <select name="type" required defaultValue="warehouse">
            {LOCATION_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button type="submit">Add location</button>
        </form>
      </details>

      {locations.length === 0 ? (
        <p className="empty">No locations yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Products</th>
                <th>Total on hand</th>
                <th>Created</th>
                <th>Rename</th>
              </tr>
            </thead>
            <tbody>
              {locations.map((location) => (
                <tr key={location.id}>
                  <td>{location.name}</td>
                  <td>
                    <span className="badge">{location.type}</span>
                  </td>
                  <td>{location.product_count}</td>
                  <td>{location.total_on_hand}</td>
                  <td>{new Date(location.created_at).toISOString()}</td>
                  <td>
                    <RenameLocationForm locationId={location.id} currentName={location.name} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

/** Plain HTML form, no client JS -- same convention as every other
 *  page-driven mutation in this app. Always visible (not a toggled "edit
 *  mode") since there's no client JS here to toggle it with; defaultValue
 *  pre-fills the current name so submitting with no changes is a no-op
 *  rename, not an accidental blank-out. */
function RenameLocationForm({ locationId, currentName }: { locationId: string; currentName: string }): ReactElement {
  return (
    <form action={`/api/locations/${locationId}/rename`} method="POST" className="row" style={{ gap: 6 }}>
      <input type="text" name="name" defaultValue={currentName} required style={{ width: 140 }} />
      <button type="submit">Rename</button>
    </form>
  );
}

function describeError(error: string): string {
  if (error === "location_missing_fields") return "Enter a name (and a type, if you're adding a location) before submitting.";
  if (error === "location_invalid_type") return "Choose one of the listed location types.";
  if (error === "location_not_found") return "That location could not be found.";
  if (error.startsWith("location_create_failed:")) {
    return `Could not add that location: ${error.slice("location_create_failed:".length)}`;
  }
  if (error.startsWith("location_rename_failed:")) {
    return `Could not rename that location: ${error.slice("location_rename_failed:".length)}`;
  }
  return error;
}
