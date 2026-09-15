import type { ReactElement } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { withTenant } from "@alltix/db";
import { getAppPool } from "@/lib/db";
import { getAuthContext } from "@/lib/auth-context";
import { resolveTenantId } from "@/lib/with-tenant-auth";

export const dynamic = "force-dynamic";

interface InventoryRow {
  product_id: string;
  location_id: string;
  internal_sku: string;
  product_name: string;
  location_name: string;
  on_hand: number;
  reserved: number;
  available: number;
  channel_buffer: Record<string, number>;
  updated_at: string;
}

interface LocationRow {
  id: string;
  name: string;
}

interface InventoryPageProps {
  searchParams: Promise<{ error?: string; transferred?: string }>;
}

type Risk = "zero" | "low" | "ok";

/** No spec pins down exactly what counts as "low" ATS -- this is a
 *  documented, simple heuristic, not a precise one: zero/negative available
 *  is always flagged, and otherwise a location/product is "low" once
 *  available stock wouldn't cover the sum of its configured per-channel
 *  safety buffers (CLAUDE.md §2.2's channel_buffer), falling back to a flat
 *  5-unit threshold when no buffer is configured at all so an unconfigured
 *  product doesn't silently read as always "ok". */
const LOW_STOCK_FALLBACK_THRESHOLD = 5;

function assessRisk(available: number, channelBuffer: Record<string, number>): Risk {
  if (available <= 0) return "zero";
  const bufferSum = Object.values(channelBuffer).reduce((sum, v) => sum + (typeof v === "number" ? v : 0), 0);
  const threshold = Math.max(bufferSum, LOW_STOCK_FALLBACK_THRESHOLD);
  return available <= threshold ? "low" : "ok";
}

function riskBadge(risk: Risk): ReactElement {
  if (risk === "zero") return <span className="badge badge-danger">OUT OF STOCK</span>;
  if (risk === "low") return <span className="badge badge-warning">LOW</span>;
  return <span className="badge badge-success">OK</span>;
}

/**
 * The ATS (available-to-sell) view (CLAUDE.md §2.2): on_hand/reserved/
 * available per product/location, with per-channel buffer visible and
 * oversell risk called out visually. Read-only, straight off
 * inventory_levels -- the derived rollup every allocation/pack mutation
 * already keeps current, per CLAUDE.md's "never let a channel adapter write
 * directly to inventory_levels" rule. Same auth/tenant pattern as every
 * other page in this app -- see src/app/orders/page.tsx's doc comment.
 */
export default async function InventoryPage({ searchParams }: InventoryPageProps): Promise<ReactElement> {
  const authContext = await getAuthContext(await headers());
  if (!authContext) {
    redirect("/sign-in");
  }

  const pool = getAppPool();
  const tenantId = await resolveTenantId(pool, authContext.clerkUserId);
  const { error, transferred } = await searchParams;
  if (!tenantId) {
    return (
      <main className="page">
        <h1>Inventory</h1>
        <p>No tenant is associated with this account yet.</p>
      </main>
    );
  }

  const { rows, locations } = await withTenant(pool, tenantId, async (client) => {
    const result = await client.query<InventoryRow>(
      `SELECT il.product_id, il.location_id, il.on_hand, il.reserved, il.available, il.channel_buffer, il.updated_at,
              p.internal_sku, p.name AS product_name, loc.name AS location_name
         FROM inventory_levels il
         JOIN products p ON p.id = il.product_id
         JOIN locations loc ON loc.id = il.location_id
        ORDER BY p.internal_sku, loc.name`,
    );
    // The full location list, not just the ones already showing up in
    // `rows` above -- a tenant should be able to transfer stock INTO a
    // location that has no inventory_levels row for anything yet
    // (InventoryService.transferStock() creates one on the fly), which the
    // inner-joined query above would never surface.
    const locationsResult = await client.query<LocationRow>(`SELECT id, name FROM locations ORDER BY name`);
    return { rows: result.rows, locations: locationsResult.rows };
  });

  // Every transferable product already has at least one inventory_levels
  // row (there's nothing to move otherwise) -- so the same `rows` this page
  // already fetches for the ATS table doubles as the transfer form's
  // product list, deduped by product_id, with no second query needed.
  const products = [...new Map(rows.map((r) => [r.product_id, { id: r.product_id, sku: r.internal_sku }])).values()].sort(
    (a, b) => a.sku.localeCompare(b.sku),
  );

  const outOfStockCount = rows.filter((r) => assessRisk(r.available, r.channel_buffer) === "zero").length;
  const lowStockCount = rows.filter((r) => assessRisk(r.available, r.channel_buffer) === "low").length;

  return (
    <main className="page">
      <h1>Inventory</h1>
      <p className="subtitle">Available-to-sell per product/location — the ledger-derived rollup, never edited directly.</p>

      {rows.length > 0 && (outOfStockCount > 0 || lowStockCount > 0) && (
        <div className="row" style={{ marginBottom: 16 }}>
          {outOfStockCount > 0 && <span className="badge badge-danger">{outOfStockCount} out of stock</span>}
          {lowStockCount > 0 && <span className="badge badge-warning">{lowStockCount} running low</span>}
        </div>
      )}

      {transferred === "1" && <div className="alert alert-success">Stock transferred.</div>}
      {error && <div className="alert alert-danger">{describeTransferError(error)}</div>}

      {products.length > 0 && locations.length >= 2 && (
        <details className="stack" style={{ marginBottom: 16 }}>
          <summary>Transfer stock</summary>
          <TransferStockForm products={products} locations={locations} />
        </details>
      )}

      {rows.length === 0 ? (
        <p className="empty">No inventory records yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>SKU</th>
                <th>Product</th>
                <th>Location</th>
                <th>On hand</th>
                <th>Reserved</th>
                <th>Available</th>
                <th>Channel buffer</th>
                <th>Risk</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const risk = assessRisk(row.available, row.channel_buffer);
                const bufferEntries = Object.entries(row.channel_buffer ?? {});
                return (
                  <tr key={`${row.product_id}:${row.location_id}`}>
                    <td className="mono">{row.internal_sku}</td>
                    <td>{row.product_name}</td>
                    <td>{row.location_name}</td>
                    <td>{row.on_hand}</td>
                    <td>{row.reserved}</td>
                    <td>
                      <strong>{row.available}</strong>
                    </td>
                    <td>
                      {bufferEntries.length === 0 ? (
                        <span className="muted">none</span>
                      ) : (
                        bufferEntries.map(([channel, qty]) => (
                          <span key={channel} className="badge" style={{ marginRight: 4 }}>
                            {channel}: {qty}
                          </span>
                        ))
                      )}
                    </td>
                    <td>{riskBadge(risk)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

/**
 * Plain HTML form, no client JS -- same convention as every other
 * page-driven mutation in this app (e.g. /products' "Add a product",
 * /settings/channels' connect forms). POSTs to /api/inventory/transfer,
 * which calls InventoryService.transferStock().
 *
 * Both location dropdowns list every location the tenant has, source and
 * destination alike -- deliberately not filtered down to "locations that
 * already stock the selected product," since that would need client-side
 * JS to react to the product dropdown's selection (this app has none, see
 * above) or a page reload per selection. An impossible combination (no
 * stock at the chosen source, or the same location picked twice) fails
 * server-side with a specific, friendly error instead -- same "verify
 * server-side, no client-side pre-filtering" tradeoff /settings/channels'
 * connect forms already make.
 */
function TransferStockForm({
  products,
  locations,
}: {
  products: Array<{ id: string; sku: string }>;
  locations: LocationRow[];
}): ReactElement {
  return (
    <form action="/api/inventory/transfer" method="POST" className="row" style={{ gap: 6, marginTop: 8, flexWrap: "wrap" }}>
      <select name="productId" required defaultValue="">
        <option value="" disabled>
          Product
        </option>
        {products.map((product) => (
          <option key={product.id} value={product.id}>
            {product.sku}
          </option>
        ))}
      </select>
      <select name="fromLocationId" required defaultValue="">
        <option value="" disabled>
          From location
        </option>
        {locations.map((location) => (
          <option key={location.id} value={location.id}>
            {location.name}
          </option>
        ))}
      </select>
      <select name="toLocationId" required defaultValue="">
        <option value="" disabled>
          To location
        </option>
        {locations.map((location) => (
          <option key={location.id} value={location.id}>
            {location.name}
          </option>
        ))}
      </select>
      <input type="number" name="quantity" min="1" step="1" placeholder="Quantity" required style={{ width: 100 }} />
      <button type="submit">Transfer stock</button>
    </form>
  );
}

function describeTransferError(error: string): string {
  if (error === "not signed in") return "You must be signed in to transfer stock.";
  if (error === "inventory_transfer_missing_fields") return "Choose a product, both locations, and a quantity before submitting.";
  if (error === "inventory_transfer_same_location") return "The source and destination locations must be different.";
  if (error === "inventory_transfer_invalid_quantity") return "Quantity must be a positive whole number.";
  if (error.startsWith("inventory_transfer_insufficient_stock:")) {
    return `Not enough available stock at the source location to transfer that much. (${error.slice(
      "inventory_transfer_insufficient_stock:".length,
    )})`;
  }
  if (error.startsWith("inventory_transfer_failed:")) {
    return `Could not transfer stock: ${error.slice("inventory_transfer_failed:".length)}`;
  }
  return error;
}
