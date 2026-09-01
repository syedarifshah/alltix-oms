import type { ReactElement } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { withTenant } from "@alltix/db";
import { getAppPool } from "@/lib/db";
import { getAuthContext } from "@/lib/auth-context";
import { resolveTenantId } from "@/lib/with-tenant-auth";

export const dynamic = "force-dynamic";

interface OrderLineRow {
  id: string;
  status: string;
  channel: string;
  external_order_id: string;
  placed_at: string | null;
  line_id: string | null;
  quantity: number | null;
  internal_sku: string | null;
  line_reserved: boolean | null;
}

interface OrderLineView {
  id: string;
  quantity: number;
  internalSku: string | null;
  reserved: boolean;
}

interface OrderView {
  id: string;
  status: string;
  channel: string;
  externalOrderId: string;
  placedAt: string | null;
  lines: OrderLineView[];
}

/** Groups the joined order/order_lines rows back into one entry per order, preserving the query's ORDER BY. */
function groupOrders(rows: OrderLineRow[]): OrderView[] {
  const byId = new Map<string, OrderView>();
  for (const row of rows) {
    let order = byId.get(row.id);
    if (!order) {
      order = {
        id: row.id,
        status: row.status,
        channel: row.channel,
        externalOrderId: row.external_order_id,
        placedAt: row.placed_at,
        lines: [],
      };
      byId.set(row.id, order);
    }
    if (row.line_id !== null) {
      order.lines.push({
        id: row.line_id,
        quantity: row.quantity ?? 0,
        internalSku: row.internal_sku,
        reserved: row.line_reserved ?? false,
      });
    }
  }
  return [...byId.values()];
}

/**
 * Read-only order list for the signed-in tenant. Resolves the caller via
 * getAuthContext (src/lib/auth-context.ts, passed `await headers()` since a
 * Server Component has no NextRequest -- getAuthContext takes a plain
 * Headers for exactly this reason) and their tenant_id via resolveTenantId
 * (src/lib/with-tenant-auth.ts), the same two steps withTenantAuth performs
 * for API routes -- deliberately not calling Clerk's auth() directly here,
 * since that skips the test-auth-bypass check and throws outright whenever
 * that bypass is active (proxy.ts's isTestBypass skips clerkMiddleware
 * entirely on that path, and auth() requires it to have run). Then queries
 * through the same RLS-scoped withTenant transaction every other
 * tenant-scoped query in this app uses.
 *
 * Protected the same way every other authenticated route is: it's simply
 * not listed in src/proxy.ts's isPublicRoute, so Clerk's auth.protect()
 * redirects a signed-out visitor before this component ever runs. The
 * redirect() call below is defense-in-depth (CLAUDE.md §6), not the
 * primary gate.
 */
export default async function OrdersPage(): Promise<ReactElement> {
  const authContext = await getAuthContext(await headers());
  if (!authContext) {
    redirect("/sign-in");
  }

  const pool = getAppPool();
  const tenantId = await resolveTenantId(pool, authContext.clerkUserId);
  if (!tenantId) {
    return (
      <main>
        <h1>Orders</h1>
        <p>No tenant is associated with this account yet.</p>
      </main>
    );
  }

  const orders = await withTenant(pool, tenantId, async (client) => {
    // No WHERE tenant_id = ... on any of the joined tables, on purpose --
    // same reasoning as /api/products: RLS already scopes every row to
    // whatever this withTenant call set via SET LOCAL app.tenant_id.
    const result = await client.query<OrderLineRow>(
      `SELECT
         o.id,
         o.status,
         o.channel,
         o.external_order_id,
         o.placed_at,
         ol.id AS line_id,
         ol.quantity,
         p.internal_sku,
         EXISTS (
           SELECT 1 FROM inventory_events ie
            WHERE ie.reference_type = 'order'
              AND ie.reference_id = o.id
              AND ie.product_id = ol.product_id
              AND ie.event_type = 'reservation'
         ) AS line_reserved
       FROM orders o
       LEFT JOIN order_lines ol ON ol.order_id = o.id
       LEFT JOIN products p ON p.id = ol.product_id
       ORDER BY o.placed_at DESC NULLS LAST, o.id, ol.id`,
    );
    return groupOrders(result.rows);
  });

  return (
    <main>
      <h1>Orders</h1>
      {orders.length === 0 ? (
        <p>No orders yet.</p>
      ) : (
        <table border={1} cellPadding={4}>
          <thead>
            <tr>
              <th>Status</th>
              <th>Channel</th>
              <th>External Order ID</th>
              <th>Placed At</th>
              <th>Lines</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.id}>
                <td>{order.status}</td>
                <td>{order.channel}</td>
                <td>{order.externalOrderId}</td>
                <td>{order.placedAt ? new Date(order.placedAt).toISOString() : "—"}</td>
                <td>
                  {order.lines.length === 0 ? (
                    "—"
                  ) : (
                    <ul>
                      {order.lines.map((line) => (
                        <li key={line.id}>
                          {line.internalSku ?? "(unresolved SKU)"} × {line.quantity}
                          {order.status === "allocated" && (line.reserved ? " — reserved ✓" : " — NOT reserved ✗")}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
