import type { ReactElement } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { withTenant } from "@alltix/db";
import { getAppPool } from "@/lib/db";
import { getAuthContext } from "@/lib/auth-context";
import { resolveTenantId } from "@/lib/with-tenant-auth";

export const dynamic = "force-dynamic";

interface AllocatedOrderRow {
  id: string;
  external_order_id: string;
  channel: string;
  placed_at: string | null;
}

interface PicklistLineJoinRow {
  picklist_id: string;
  picklist_status: string;
  assigned_to: string | null;
  location_name: string;
  line_id: string | null;
  quantity_requested: number | null;
  quantity_picked: number | null;
  line_status: string | null;
  internal_sku: string | null;
  product_name: string | null;
  order_id: string | null;
  external_order_id: string | null;
  order_status: string | null;
}

interface PicklistLineView {
  lineId: string;
  quantityRequested: number;
  quantityPicked: number;
  status: string;
  sku: string;
  productName: string;
  orderId: string;
  externalOrderId: string;
  orderStatus: string;
}

interface PicklistView {
  id: string;
  status: string;
  assignedTo: string | null;
  locationName: string;
  lines: PicklistLineView[];
}

function groupPicklists(rows: PicklistLineJoinRow[]): PicklistView[] {
  const byId = new Map<string, PicklistView>();
  for (const row of rows) {
    let pk = byId.get(row.picklist_id);
    if (!pk) {
      pk = { id: row.picklist_id, status: row.picklist_status, assignedTo: row.assigned_to, locationName: row.location_name, lines: [] };
      byId.set(row.picklist_id, pk);
    }
    if (row.line_id) {
      pk.lines.push({
        lineId: row.line_id,
        quantityRequested: row.quantity_requested ?? 0,
        quantityPicked: row.quantity_picked ?? 0,
        status: row.line_status ?? "pending",
        sku: row.internal_sku ?? "—",
        productName: row.product_name ?? "—",
        orderId: row.order_id ?? "",
        externalOrderId: row.external_order_id ?? "—",
        orderStatus: row.order_status ?? "—",
      });
    }
  }
  return [...byId.values()];
}

interface PickingOrderRow {
  id: string;
  external_order_id: string;
  channel: string;
  pending_count: string;
  total_lines: string;
}

interface PackedOrderRow {
  id: string;
  external_order_id: string;
  channel: string;
}

interface PicklistsPageProps {
  searchParams: Promise<{ error?: string }>;
}

/**
 * The warehouse/picklist workflow as an actual click-through flow, not just
 * an API (CLAUDE.md §1 Warehouse/Fulfillment; backend in
 * @alltix/warehouse-service). Every mutation here (generate/claim/record
 * pick/pack/ship) posts to a Route Handler under src/app/api that calls the
 * real WarehouseService/OrderService methods -- nothing on this page writes
 * to the database directly, and nothing is mocked.
 *
 * "Ready to pack" and "ready to ship" are listed by order status directly
 * (not only by walking picklists) because a zero-line order skips picking
 * entirely (WarehouseService.generatePicklist's documented "vacuously fine"
 * case) and would otherwise never appear anywhere on this page.
 */
export default async function PicklistsPage({ searchParams }: PicklistsPageProps): Promise<ReactElement> {
  const authContext = await getAuthContext(await headers());
  if (!authContext) {
    redirect("/sign-in");
  }

  const pool = getAppPool();
  const tenantId = await resolveTenantId(pool, authContext.clerkUserId);
  const { error } = await searchParams;

  if (!tenantId) {
    return (
      <main className="page">
        <h1>Picklists</h1>
        <p>No tenant is associated with this account yet.</p>
      </main>
    );
  }

  const { allocatedOrders, picklists, pickingOrders, packedOrders, isRoyalMailConnected } = await withTenant(pool, tenantId, async (client) => {
    const allocated = await client.query<AllocatedOrderRow>(
      `SELECT id, external_order_id, channel, placed_at FROM orders WHERE status = 'allocated' ORDER BY placed_at NULLS LAST, id`,
    );

    const picklistRows = await client.query<PicklistLineJoinRow>(
      `SELECT pk.id AS picklist_id, pk.status AS picklist_status, pk.assigned_to, loc.name AS location_name,
              pl.id AS line_id, pl.quantity_requested, pl.quantity_picked, pl.status AS line_status,
              p.internal_sku, p.name AS product_name,
              o.id AS order_id, o.external_order_id, o.status AS order_status
         FROM picklists pk
         JOIN locations loc ON loc.id = pk.location_id
         LEFT JOIN picklist_lines pl ON pl.picklist_id = pk.id
         LEFT JOIN order_lines ol ON ol.id = pl.order_line_id
         LEFT JOIN orders o ON o.id = ol.order_id
         LEFT JOIN products p ON p.id = pl.product_id
        WHERE pk.status != 'cancelled'
        ORDER BY pk.created_at DESC, pl.id`,
    );

    const picking = await client.query<PickingOrderRow>(
      `SELECT o.id, o.external_order_id, o.channel,
              (SELECT count(*)::text FROM picklist_lines pl
                 JOIN order_lines ol2 ON ol2.id = pl.order_line_id
                WHERE ol2.order_id = o.id AND pl.status = 'pending') AS pending_count,
              (SELECT count(*)::text FROM picklist_lines pl
                 JOIN order_lines ol2 ON ol2.id = pl.order_line_id
                WHERE ol2.order_id = o.id) AS total_lines
         FROM orders o
        WHERE o.status = 'picking'
        ORDER BY o.placed_at NULLS LAST, o.id`,
    );

    const packed = await client.query<PackedOrderRow>(
      `SELECT id, external_order_id, channel FROM orders WHERE status = 'packed' ORDER BY placed_at NULLS LAST, id`,
    );

    // Gates whether the "Ship via Royal Mail" form (task #59, real label
    // generation -- see /api/orders/[id]/ship-via-carrier's own doc
    // comment) renders at all -- same "don't offer an action with nothing
    // behind it" discipline /settings/channels' own isXEnabled checks
    // already apply, just for a carrier connection instead of a channel
    // feature flag.
    const royalMail = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM carrier_connections WHERE carrier = 'royal_mail' AND status = 'active'`,
    );

    return {
      allocatedOrders: allocated.rows,
      picklists: groupPicklists(picklistRows.rows),
      pickingOrders: picking.rows,
      packedOrders: packed.rows,
      isRoyalMailConnected: Number(royalMail.rows[0]!.count) > 0,
    };
  });

  return (
    <main className="page">
      <h1>Picklists</h1>
      <p className="subtitle">Pick, pack, and ship allocated orders.</p>

      {error && <div className="alert alert-danger">{decodeURIComponent(error)}</div>}

      <h2>Ready to pick ({allocatedOrders.length})</h2>
      {allocatedOrders.length === 0 ? (
        <p className="empty">No allocated orders waiting to be picked.</p>
      ) : (
        <form action="/api/picklists" method="POST" className="card">
          <div className="stack">
            {allocatedOrders.map((o) => (
              <label key={o.id} className="row">
                <input type="checkbox" name="orderIds" value={o.id} />
                {o.external_order_id} ({o.channel}) — placed {o.placed_at ? new Date(o.placed_at).toISOString() : "—"}
              </label>
            ))}
          </div>
          <div style={{ marginTop: 12 }}>
            <button type="submit">Generate picklist</button>
          </div>
        </form>
      )}

      <h2>Picklists ({picklists.length})</h2>
      {picklists.length === 0 ? (
        <p className="empty">No picklists yet.</p>
      ) : (
        <div className="stack">
          {picklists.map((pk) => (
            <div className="card" key={pk.id}>
              <div className="row">
                <strong>Picklist {pk.id.slice(0, 8)}</strong>
                <span className="badge">{pk.status}</span>
                <span className="muted">{pk.locationName}</span>
                {pk.status === "open" && (
                  <form action={`/api/picklists/${pk.id}/assign`} method="POST">
                    <button type="submit">Claim</button>
                  </form>
                )}
              </div>
              <div className="table-wrap" style={{ marginTop: 10 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>SKU</th>
                      <th>Requested</th>
                      <th>Picked</th>
                      <th>Status</th>
                      {pk.status === "assigned" && <th>Record pick</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {pk.lines.map((line) => (
                      <tr key={line.lineId}>
                        <td>
                          <a href={`/orders/${line.orderId}`}>{line.externalOrderId}</a>
                        </td>
                        <td className="mono">{line.sku}</td>
                        <td>{line.quantityRequested}</td>
                        <td>{line.quantityPicked}</td>
                        <td>
                          <span className={line.status === "pending" ? "badge" : line.status === "picked" ? "badge badge-success" : "badge badge-warning"}>
                            {line.status}
                          </span>
                        </td>
                        {pk.status === "assigned" && (
                          <td>
                            {line.status === "pending" ? (
                              <form action={`/api/picklists/${pk.id}/lines/${line.lineId}/record`} method="POST" className="inline-form">
                                <input
                                  type="number"
                                  name="quantityPicked"
                                  min={0}
                                  defaultValue={line.quantityRequested}
                                  style={{ width: 60 }}
                                  required
                                />
                                <label className="row" style={{ gap: 4 }}>
                                  <input type="checkbox" name="damaged" /> damaged
                                </label>
                                <button type="submit">Record</button>
                              </form>
                            ) : (
                              <span className="muted">recorded</span>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}

      <h2>Ready to pack ({pickingOrders.length})</h2>
      {pickingOrders.length === 0 ? (
        <p className="empty">No orders in 'picking'.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Channel</th>
                <th>Picking progress</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pickingOrders.map((o) => {
                const pending = Number(o.pending_count);
                const total = Number(o.total_lines);
                const ready = pending === 0;
                return (
                  <tr key={o.id}>
                    <td>
                      <a href={`/orders/${o.id}`}>{o.external_order_id}</a>
                    </td>
                    <td>{o.channel}</td>
                    <td>{total === 0 ? "no picklist lines" : `${total - pending}/${total} recorded`}</td>
                    <td>
                      <form action={`/api/orders/${o.id}/pack`} method="POST">
                        <button type="submit" disabled={!ready}>
                          Pack
                        </button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h2>Ready to ship ({packedOrders.length})</h2>
      {packedOrders.length === 0 ? (
        <p className="empty">No orders in 'packed'.</p>
      ) : (
        <div className="stack">
          {packedOrders.map((o) => (
            <div className="card" key={o.id}>
              <div className="row" style={{ marginBottom: 8 }}>
                <a href={`/orders/${o.id}`}>{o.external_order_id}</a>
                <span className="muted">{o.channel}</span>
              </div>
              <form action={`/api/orders/${o.id}/ship`} method="POST" className="row">
                <input type="text" name="carrier" placeholder="Carrier (e.g. UPS)" required />
                <input type="text" name="trackingNumber" placeholder="Tracking number" required />
                <button type="submit">Confirm shipment (manual tracking number)</button>
              </form>
              {isRoyalMailConnected ? (
                <details style={{ marginTop: 8 }}>
                  <summary>Ship via Royal Mail (generate a real label)</summary>
                  <form action={`/api/orders/${o.id}/ship-via-carrier`} method="POST" className="stack" style={{ marginTop: 8 }}>
                    <label>
                      Recipient name
                      <input type="text" name="recipientName" required />
                    </label>
                    <label>
                      Address line 1
                      <input type="text" name="addressLine1" required />
                    </label>
                    <label>
                      City
                      <input type="text" name="city" required />
                    </label>
                    <label>
                      Postal code
                      <input type="text" name="postalCode" required />
                    </label>
                    <label>
                      Country code
                      <input type="text" name="countryCode" defaultValue="GB" required />
                    </label>
                    <label>
                      Package weight (grams)
                      <input type="number" name="weightGrams" min={1} max={30000} required />
                    </label>
                    <label>
                      Shipping cost charged to customer (GBP)
                      <input type="text" name="shippingCostChargedGbp" defaultValue="0.00" />
                    </label>
                    <label>
                      Service code (optional)
                      <input type="text" name="serviceCode" placeholder="e.g. TPLL" />
                    </label>
                    <button type="submit">Generate Royal Mail label &amp; confirm shipment</button>
                    <p className="muted" style={{ margin: 0 }}>
                      UNVERIFIED against real Royal Mail infrastructure — see <a href="/settings/carriers">Carriers</a>.
                      No live rate-shopping exists for Royal Mail; enter the amount actually charged.
                    </p>
                  </form>
                </details>
              ) : (
                <p className="muted" style={{ marginTop: 6, marginBottom: 0 }}>
                  Connect Royal Mail on <a href="/settings/carriers">Carriers</a> to generate a real label instead of
                  typing in a tracking number by hand.
                </p>
              )}
              {o.channel === "amazon" && (
                <p className="muted" style={{ marginTop: 6, marginBottom: 0 }}>
                  Calls the connected Amazon channel&apos;s shipment-confirmation API — verified against the SP-API
                  sandbox; success against a real production order is unconfirmed (no matching production write has
                  been exercised yet).
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
