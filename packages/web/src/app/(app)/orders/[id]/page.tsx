import type { ReactElement } from "react";
import { headers } from "next/headers";
import { redirect, notFound } from "next/navigation";
import { withTenant } from "@alltix/db";
import { getAppPool } from "@/lib/db";
import { getAuthContext } from "@/lib/auth-context";
import { resolveTenantId } from "@/lib/with-tenant-auth";
import {
  orderStatusBadgeClass,
  isOrderCancellable,
  isOrderReturnable,
  manualOrderActions,
  RETURN_DISPOSITIONS,
} from "@/lib/order-status";
import type { OrderStatus } from "@alltix/shared";

export const dynamic = "force-dynamic";

interface OrderHeaderRow {
  id: string;
  status: string;
  channel: string;
  external_order_id: string;
  placed_at: string | null;
  created_at: string;
  updated_at: string;
  preferred_location_id: string | null;
  split_from_order_id: string | null;
}

/** Either direction of a SHORT-PICK SPLIT link (WarehouseService.packOrder,
 *  migration 0023) -- the order this one was split from, or an order that
 *  was split off from this one. Same three fields either way: enough to
 *  render a link and a status badge, nothing more. */
interface RelatedOrderRow {
  id: string;
  status: string;
  external_order_id: string;
}

interface OrderLineRow {
  id: string;
  quantity: number;
  unit_price: string;
  fulfillment_type: string;
  internal_sku: string;
  product_name: string;
  reserved: boolean;
}

interface InventoryEventRow {
  event_type: string;
  quantity_delta: number;
  created_at: string;
  internal_sku: string;
  location_name: string;
}

interface RuleExecutionRow {
  trigger_event: string;
  matched: boolean;
  applied: boolean;
  error: string | null;
  created_at: string;
  rule_name: string;
}

interface PicklistLineRow {
  status: string;
  quantity_requested: number;
  quantity_picked: number;
  updated_at: string;
  picklist_id: string;
  picklist_status: string;
  location_name: string;
  internal_sku: string;
}

interface TimelineEntry {
  at: string;
  label: string;
  detail?: string;
}

const INVENTORY_EVENT_LABEL: Record<string, string> = {
  reservation: "Reserved",
  release: "Released",
  adjustment: "Ledger adjustment",
  damage: "Damage recorded",
  receipt: "Stock received",
  sale: "Sale recorded",
  transfer: "Transferred",
};

function buildTimeline(
  order: OrderHeaderRow,
  events: InventoryEventRow[],
  ruleExecutions: RuleExecutionRow[],
  picklistLines: PicklistLineRow[],
): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    {
      at: order.created_at,
      label: `Order received from ${order.channel}`,
    },
  ];

  for (const event of events) {
    const verb = INVENTORY_EVENT_LABEL[event.event_type] ?? event.event_type;
    entries.push({
      at: event.created_at,
      label: `${verb}: ${Math.abs(event.quantity_delta)} × ${event.internal_sku} at ${event.location_name}`,
    });
  }

  for (const exec of ruleExecutions) {
    const outcome = !exec.matched ? "did not match" : exec.applied ? "applied" : "matched, but not applied (lost to a higher-priority rule)";
    entries.push({
      at: exec.created_at,
      label: `Rule "${exec.rule_name}" ${outcome} for ${exec.trigger_event}`,
      detail: exec.error ?? undefined,
    });
  }

  for (const line of picklistLines) {
    if (line.status === "pending") continue;
    entries.push({
      at: line.updated_at,
      label: `Picklist line ${line.internal_sku}: ${line.status} (${line.quantity_picked}/${line.quantity_requested}) at ${line.location_name}`,
      detail: `picklist ${line.picklist_id.slice(0, 8)} — ${line.picklist_status}`,
    });
  }

  // .at is typed as `string` (matching what every other page in this app
  // assumes for a timestamptz column), but node-pg actually returns
  // TIMESTAMPTZ columns as real `Date` objects at runtime -- confirmed live
  // here (order.created_at came through as a Date, not a string, breaking
  // .localeCompare). new Date(x) is a no-op for an already-Date x, so this
  // sorts correctly regardless of which one a given source actually is.
  return entries.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

interface OrderDetailPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}

/**
 * Read-only order detail: header, line items with allocation status, and an
 * activity timeline. There is no dedicated order-status-history table in
 * this schema (orders.status is a plain mutable column, not itself
 * event-sourced) -- the timeline below is assembled from the tables that
 * *are* event-sourced (inventory_events, rule_executions, picklist_lines),
 * per CLAUDE.md §2.2's philosophy that a status change should leave a real
 * trace somewhere. A transition that left no trace in any of those (e.g.
 * 'received' -> 'validated', which today is a pass-through with no side
 * effect -- see OrderService.transition's doc comment) isn't shown as its
 * own row; the order's current status badge is the source of truth for
 * "where it is now."
 */
export default async function OrderDetailPage({ params, searchParams }: OrderDetailPageProps): Promise<ReactElement> {
  const authContext = await getAuthContext(await headers());
  if (!authContext) {
    redirect("/sign-in");
  }

  const { id } = await params;
  const { error } = await searchParams;
  const pool = getAppPool();
  const tenantId = await resolveTenantId(pool, authContext.clerkUserId);
  if (!tenantId) {
    return (
      <main className="page">
        <h1>Order</h1>
        <p>No tenant is associated with this account yet.</p>
      </main>
    );
  }

  const data = await withTenant(pool, tenantId, async (client) => {
    const orderResult = await client.query<OrderHeaderRow>(
      `SELECT id, status, channel, external_order_id, placed_at, created_at, updated_at, preferred_location_id,
              split_from_order_id
         FROM orders WHERE id = $1`,
      [id],
    );
    const order = orderResult.rows[0];
    if (!order) return null;

    const [lines, events, ruleExecutions, picklistLines, splitFromOrder, splitIntoOrders] = await Promise.all([
      client.query<OrderLineRow>(
        `SELECT
           ol.id, ol.quantity, ol.unit_price, ol.fulfillment_type,
           p.internal_sku, p.name AS product_name,
           EXISTS (
             SELECT 1 FROM inventory_events ie
              WHERE ie.reference_type = 'order' AND ie.reference_id = $1
                AND ie.product_id = ol.product_id AND ie.event_type = 'reservation'
           ) AS reserved
         FROM order_lines ol
         JOIN products p ON p.id = ol.product_id
        WHERE ol.order_id = $1
        ORDER BY ol.created_at`,
        [id],
      ),
      client.query<InventoryEventRow>(
        `SELECT ie.event_type, ie.quantity_delta, ie.created_at, p.internal_sku, loc.name AS location_name
           FROM inventory_events ie
           JOIN products p ON p.id = ie.product_id
           JOIN locations loc ON loc.id = ie.location_id
          WHERE ie.reference_type = 'order' AND ie.reference_id = $1
          ORDER BY ie.created_at`,
        [id],
      ),
      client.query<RuleExecutionRow>(
        `SELECT re.trigger_event, re.matched, re.applied, re.error, re.created_at, ar.name AS rule_name
           FROM rule_executions re
           JOIN automation_rules ar ON ar.id = re.automation_rule_id
          WHERE re.order_id = $1
          ORDER BY re.created_at`,
        [id],
      ),
      client.query<PicklistLineRow>(
        `SELECT pl.status, pl.quantity_requested, pl.quantity_picked, pl.updated_at,
                pl.picklist_id, pk.status AS picklist_status, loc.name AS location_name, p.internal_sku
           FROM picklist_lines pl
           JOIN order_lines ol ON ol.id = pl.order_line_id
           JOIN picklists pk ON pk.id = pl.picklist_id
           JOIN locations loc ON loc.id = pk.location_id
           JOIN products p ON p.id = pl.product_id
          WHERE ol.order_id = $1
          ORDER BY pl.updated_at`,
        [id],
      ),
      // SHORT-PICK SPLIT linkage (WarehouseService.packOrder, migration
      // 0023) -- at most one of these two queries ever returns a row for a
      // given order: an order is either something else's backorder
      // (split_from_order_id set) or the source of at most one backorder of
      // its own (packOrder can only run once per order), never both.
      order.split_from_order_id
        ? client.query<RelatedOrderRow>(`SELECT id, status, external_order_id FROM orders WHERE id = $1`, [
            order.split_from_order_id,
          ])
        : Promise.resolve({ rows: [] as RelatedOrderRow[] }),
      client.query<RelatedOrderRow>(`SELECT id, status, external_order_id FROM orders WHERE split_from_order_id = $1`, [id]),
    ]);

    return {
      order,
      lines: lines.rows,
      timeline: buildTimeline(order, events.rows, ruleExecutions.rows, picklistLines.rows),
      splitFromOrder: splitFromOrder.rows[0] ?? null,
      splitIntoOrders: splitIntoOrders.rows,
    };
  });

  if (!data) {
    notFound();
  }

  const { order, lines, timeline, splitFromOrder, splitIntoOrders } = data;

  return (
    <main className="page">
      <p>
        <a href="/orders">← Back to orders</a>
      </p>
      <h1>
        Order {order.external_order_id} <span className={orderStatusBadgeClass(order.status)}>{order.status}</span>
      </h1>
      <p className="subtitle">
        {order.channel} · placed {order.placed_at ? new Date(order.placed_at).toISOString() : "—"} · last updated{" "}
        {new Date(order.updated_at).toISOString()}
      </p>

      {error && <div className="alert alert-danger">Couldn&apos;t update this order ({error}).</div>}

      {splitFromOrder && (
        <div className="alert alert-warning">
          This order is a backorder split off from{" "}
          <a href={`/orders/${splitFromOrder.id}`}>
            {splitFromOrder.external_order_id} ({splitFromOrder.status})
          </a>{" "}
          after a short pick.
        </div>
      )}
      {splitIntoOrders.length > 0 && (
        <div className="alert alert-warning">
          A short pick on this order split its unfulfilled quantity into{" "}
          {splitIntoOrders.map((backorder, i) => (
            <span key={backorder.id}>
              {i > 0 && ", "}
              <a href={`/orders/${backorder.id}`}>
                {backorder.external_order_id} ({backorder.status})
              </a>
            </span>
          ))}
          .
        </div>
      )}

      {manualOrderActions(order.status as OrderStatus).map((action) => (
        <form
          key={action.to}
          action={`/api/orders/${order.id}/transition`}
          method="POST"
          className="row"
          style={{ marginBottom: 20 }}
        >
          <input type="hidden" name="from" value={order.status} />
          <input type="hidden" name="to" value={action.to} />
          <button type="submit">{action.label}</button>
          {action.hint && <span className="muted">{action.hint}</span>}
        </form>
      ))}

      {isOrderReturnable(order.status as OrderStatus) && (
        <form
          action={`/api/orders/${order.id}/return`}
          method="POST"
          className="row"
          style={{ marginBottom: 20, alignItems: "center" }}
        >
          <input type="hidden" name="from" value={order.status} />
          <span>Mark returned:</span>
          {RETURN_DISPOSITIONS.map((option, i) => (
            <label key={option.value} className="row" style={{ gap: 4 }}>
              <input type="radio" name="disposition" value={option.value} defaultChecked={i === 0} />
              {option.label}
            </label>
          ))}
          <button type="submit">Submit</button>
          <span className="muted">
            {RETURN_DISPOSITIONS.map((option) => `${option.label}: ${option.hint}`).join(" ")}
          </span>
        </form>
      )}

      {isOrderCancellable(order.status as OrderStatus) && (
        <form action={`/api/orders/${order.id}/cancel`} method="POST" className="row" style={{ marginBottom: 20 }}>
          <input type="hidden" name="from" value={order.status} />
          <button type="submit" className="danger">
            Cancel order
          </button>
          {(order.status === "allocated" || order.status === "picking") && (
            <span className="muted">Releases this order&apos;s reserved inventory back to available.</span>
          )}
        </form>
      )}

      <h2>Line items</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>SKU</th>
              <th>Product</th>
              <th>Qty</th>
              <th>Unit price</th>
              <th>Fulfillment</th>
              <th>Allocation</th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 ? (
              <tr>
                <td colSpan={6} className="empty">
                  No line items.
                </td>
              </tr>
            ) : (
              lines.map((line) => (
                <tr key={line.id}>
                  <td className="mono">{line.internal_sku}</td>
                  <td>{line.product_name}</td>
                  <td>{line.quantity}</td>
                  <td>{line.unit_price}</td>
                  <td>{line.fulfillment_type}</td>
                  <td>
                    {line.reserved ? (
                      <span className="badge badge-success">reserved</span>
                    ) : (
                      <span className="badge">not reserved</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <h2>Activity</h2>
      <p className="subtitle">
        Assembled from the inventory ledger, rule executions, and picklist activity for this order — there is no
        separate order-status-history log, so a transition that left no trace in any of those tables (e.g. a plain
        status flip with no side effect) won&apos;t appear as its own row here.
      </p>
      {timeline.length === 0 ? (
        <p className="empty">No recorded activity yet.</p>
      ) : (
        <ul className="timeline">
          {timeline.map((entry, i) => (
            <li key={i}>
              <div className="timeline-time">{new Date(entry.at).toISOString()}</div>
              <div>{entry.label}</div>
              {entry.detail && <div className="muted">{entry.detail}</div>}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
