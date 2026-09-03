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
export default async function InventoryPage(): Promise<ReactElement> {
  const authContext = await getAuthContext(await headers());
  if (!authContext) {
    redirect("/sign-in");
  }

  const pool = getAppPool();
  const tenantId = await resolveTenantId(pool, authContext.clerkUserId);
  if (!tenantId) {
    return (
      <main className="page">
        <h1>Inventory</h1>
        <p>No tenant is associated with this account yet.</p>
      </main>
    );
  }

  const rows = await withTenant(pool, tenantId, async (client) => {
    const result = await client.query<InventoryRow>(
      `SELECT il.product_id, il.location_id, il.on_hand, il.reserved, il.available, il.channel_buffer, il.updated_at,
              p.internal_sku, p.name AS product_name, loc.name AS location_name
         FROM inventory_levels il
         JOIN products p ON p.id = il.product_id
         JOIN locations loc ON loc.id = il.location_id
        ORDER BY p.internal_sku, loc.name`,
    );
    return result.rows;
  });

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
