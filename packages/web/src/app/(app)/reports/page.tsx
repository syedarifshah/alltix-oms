import type { ReactElement } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { withTenant } from "@alltix/db";
import { assessStockForecast } from "@alltix/inventory-service";
import { getAppPool } from "@/lib/db";
import { getAuthContext } from "@/lib/auth-context";
import { resolveTenantId } from "@/lib/with-tenant-auth";
import { AnalyticsIcon } from "@/components/icons";
import { channelChartColor, channelLabel } from "@/lib/channel-badge";
import { ChannelLogo } from "@/components/channel-logo";
import { KpiTile } from "@/components/kpi-tile";
import { DonutChart } from "@/components/charts/donut-chart";

export const dynamic = "force-dynamic";

interface SalesByChannelRow {
  channel: string;
  order_count: string;
  units_sold: string;
  revenue: string;
}

interface TopSkuRow {
  internal_sku: string;
  product_name: string;
  units_sold: string;
  revenue: string;
}

interface ReturnsSummaryRow {
  total_returns: string;
  sellable_returns: string;
}

interface InventorySnapshotRow {
  total_on_hand: string;
  total_reserved: string;
  total_available: string;
  distinct_skus: string;
}

interface TroubleSpotRow {
  internal_sku: string;
  product_name: string;
  location_name: string;
  on_hand: number;
  reserved: number;
  available: number;
}

interface ReorderCandidateRow {
  internal_sku: string;
  product_name: string;
  location_name: string;
  available: number;
  units_sold: string;
}

interface ReportsPageProps {
  searchParams: Promise<{ days?: string }>;
}

/** Fixed set of period choices, rendered as plain links (?days=N) --
 *  same "no client JS anywhere in this app" convention every other page's
 *  filter/action already follows (see /inventory's TransferStockForm doc
 *  comment). 30 is the default: short enough to be current, long enough
 *  that a low-volume tenant (CLAUDE.md §0: 500-50,000 orders/month) has
 *  something to look at. */
const PERIOD_CHOICES = [7, 30, 90, 365] as const;
const DEFAULT_PERIOD_DAYS = 30;

function parsePeriodDays(raw: string | undefined): number {
  const parsed = Number(raw);
  return PERIOD_CHOICES.includes(parsed as (typeof PERIOD_CHOICES)[number]) ? parsed : DEFAULT_PERIOD_DAYS;
}

/**
 * CLAUDE.md §1's "Reporting/Analytics" module, first pass: plain Postgres
 * queries against the existing transactional tables, not the separate
 * read-optimized store (columnar DB/DW fed by CDC) that section's
 * architecture diagram eventually calls for. Deliberate, not a shortcut --
 * same "start simple, split out infra when scale demands it" call this
 * codebase already made for the event bus (InProcessEventBus) and the job
 * queue (packages/scheduler's header comment): at this app's current
 * per-tenant order volume (CLAUDE.md §0, up to 50,000/month), a handful of
 * aggregate queries against `orders`/`order_lines`/`inventory_levels` cost
 * single-digit milliseconds and don't contend meaningfully with
 * transactional writes. Revisit (a real CDC-fed columnar store) if a
 * tenant's report queries start measurably slowing down their own
 * transactional traffic -- CLAUDE.md §8's own open question about moving
 * this earlier.
 *
 * Every figure here is read straight off real, already-written data --
 * `order_lines.unit_price` (the actual price a line sold for) and
 * `inventory_levels`/`inventory_events` (the ledger, per CLAUDE.md §2.2).
 * Nothing is invented: there is no `cost`/COGS column anywhere in this
 * schema (only `unit_price`, the sale price), so this deliberately does
 * NOT attempt a dollar "inventory value" figure -- that would silently
 * conflate sale price with cost basis, which is a real accounting error,
 * not a rounding one. The inventory section below reports units, not
 * dollars, for exactly that reason.
 *
 * "Reorder soon" (CLAUDE.md §8 Phase 5's "stock forecasting" line, v1
 * scope): reuses this page's own selected `periodDays` as the sales-velocity
 * window, via @alltix/inventory-service's `assessStockForecast` -- the same
 * pure function `/inventory` uses with its own fixed 30-day window. See that
 * function's own doc comment for what it does and doesn't claim to predict.
 * The threshold itself (`reorderThresholdDays`, "N or fewer days left counts
 * as soon") is a real per-tenant setting now (`tenants.reorder_threshold_days`,
 * migration 0031) -- read here, not edited here; /inventory's own "Reorder
 * threshold" form is the only place it's changed, and both pages apply
 * whatever the tenant set there.
 *
 * "Revenue" here means gross order-line revenue for non-cancelled orders in
 * the selected period (`orders.placed_at`, not `created_at` -- a channel
 * order's placement date, matching how a merchant actually thinks about
 * "sales this period"), not net-of-returns: a return's restock is a
 * separate, visible line in its own Returns section below rather than
 * silently subtracted back out of the sales figures above it, so both
 * numbers stay independently auditable against their own underlying ledger
 * rows -- the same "never silently net two different things together"
 * instinct CLAUDE.md's inventory-ledger rule already encodes elsewhere in
 * this app.
 *
 * **Sales-by-channel and top-SKUs now read from the daily rollup tables**
 * (`daily_channel_sales_rollups`/`daily_product_sales_rollups`, migration
 * 0045, `@alltix/scheduler`'s `rollupDailySales`), not a live scan of
 * `orders`/`order_lines` -- the pragmatic v1 CLAUDE.md §8's own recorded
 * CDC-store revisit trigger (real contracts, 30,000+ orders/week) is
 * built around; see that migration's own header comment for the full
 * "why this instead of real Debezium+ClickHouse/BigQuery" reasoning. Both
 * queries sum whole calendar-day rollup rows for `sale_date >= since`
 * (UTC date, not a timestamp) rather than grouping raw order/line rows,
 * so their cost is bounded by (days in period) x (channels or SKUs), not
 * by order volume. **A real, honest limitation this trades in**: these
 * tables are only as fresh as the last nightly `sales-rollup` cron run
 * (`/api/cron/sales-rollup`, `vercel.json`) -- today's not-yet-rolled-up
 * sales won't appear here until tomorrow's run, an eventual-consistency
 * gap this page didn't have before. The returns/inventory-snapshot/
 * reorder-soon sections below are untouched -- they don't scan
 * `orders`/`order_lines` per-row the way sales-by-channel/top-SKUs did,
 * so they were never this feature's target.
 */
export default async function ReportsPage({ searchParams }: ReportsPageProps): Promise<ReactElement> {
  const authContext = await getAuthContext(await headers());
  if (!authContext) {
    redirect("/sign-in");
  }

  const pool = getAppPool();
  const tenantId = await resolveTenantId(pool, authContext.clerkUserId);
  const { days: rawDays } = await searchParams;
  const periodDays = parsePeriodDays(rawDays);

  if (!tenantId) {
    return (
      <main className="page">
        <h1>Reports</h1>
        <p>No tenant is associated with this account yet.</p>
      </main>
    );
  }

  const since = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);

  const { salesByChannel, topSkus, returnsSummary, inventorySnapshot, troubleSpots, reorderCandidates, reorderThresholdDays } =
    await withTenant(pool, tenantId, async (client) => {
      // This tenant's own "reorder soon" threshold (migration 0031) -- same
      // value /inventory's own settings form edits, not a second,
      // independent report-only setting. See /inventory's own doc comment
      // for the RLS-already-scopes-this-row reasoning.
      const tenantResult = await client.query<{ reorder_threshold_days: number }>(
        `SELECT reorder_threshold_days FROM tenants WHERE id = $1`,
        [tenantId],
      );

      // UTC calendar date, not a timestamp -- matches
      // daily_channel_sales_rollups/daily_product_sales_rollups' own
      // `sale_date DATE` column (migration 0045), which is itself derived
      // from `orders.placed_at` the same way. `since` above is a plain JS
      // Date at "periodDays days ago, right now" -- slicing its own
      // ISO string to the date part is a deliberately simple truncation
      // (same spirit as rollupDailySales' own UTC day-boundary math), not
      // a timezone-aware "start of day" -- a report window boundary,
      // never a financial cutoff, doesn't need that precision.
      const sinceDate = since.toISOString().slice(0, 10);

      const salesByChannelResult = await client.query<SalesByChannelRow>(
        `SELECT channel,
                sum(order_count)::text AS order_count,
                sum(units_sold)::text AS units_sold,
                sum(revenue)::text AS revenue
           FROM daily_channel_sales_rollups
          WHERE sale_date >= $1
          GROUP BY channel
          ORDER BY sum(revenue) DESC`,
        [sinceDate],
      );

      const topSkusResult = await client.query<TopSkuRow>(
        `SELECT p.internal_sku, p.name AS product_name,
                sum(r.units_sold)::text AS units_sold,
                sum(r.revenue)::text AS revenue
           FROM daily_product_sales_rollups r
           JOIN products p ON p.id = r.product_id
          WHERE r.sale_date >= $1
          GROUP BY p.id, p.internal_sku, p.name
          ORDER BY sum(r.revenue) DESC
          LIMIT 10`,
        [sinceDate],
      );

      // 'returned' is a terminal state (ORDER_STATE_TRANSITIONS.returned =
      // []) -- an order's updated_at while status='returned' can only be the
      // moment it was marked returned, nothing later could have touched it,
      // so this is an exact "returned in this period" filter, not an
      // approximation. sellable_returns counts orders that actually have a
      // matching reference_type='return' inventory_events row (a real
      // restock happened, see OrderService.returnOrder's doc comment); the
      // remainder were marked 'damaged' (or predate this feature and have no
      // sale event to restock from at all -- see returnOrder's own comment
      // on that fallback).
      const returnsSummaryResult = await client.query<ReturnsSummaryRow>(
        `SELECT count(*)::text AS total_returns,
                count(*) FILTER (
                  WHERE EXISTS (
                    SELECT 1 FROM inventory_events ie
                     WHERE ie.reference_type = 'return' AND ie.reference_id = o.id
                  )
                )::text AS sellable_returns
           FROM orders o
          WHERE o.status = 'returned' AND o.updated_at >= $1`,
        [since.toISOString()],
      );

      // Inventory snapshot is deliberately NOT period-filtered -- on_hand/
      // reserved/available describe right-now stock, not a historical
      // window; /inventory already has the full per-location breakdown,
      // this is just the tenant-wide roll-up plus a "worst" list.
      const inventorySnapshotResult = await client.query<InventorySnapshotRow>(
        `SELECT coalesce(sum(on_hand), 0)::text AS total_on_hand,
                coalesce(sum(reserved), 0)::text AS total_reserved,
                coalesce(sum(available), 0)::text AS total_available,
                count(DISTINCT product_id)::text AS distinct_skus
           FROM inventory_levels`,
      );

      const troubleSpotsResult = await client.query<TroubleSpotRow>(
        `SELECT p.internal_sku, p.name AS product_name, loc.name AS location_name,
                il.on_hand, il.reserved, il.available
           FROM inventory_levels il
           JOIN products p ON p.id = il.product_id
           JOIN locations loc ON loc.id = il.location_id
          WHERE il.available <= 0
          ORDER BY il.available ASC
          LIMIT 10`,
      );

      // Reorder candidates (CLAUDE.md §8 Phase 5's "stock forecasting" line,
      // v1 scope): still-in-stock (available > 0 -- already-out items are
      // the troubleSpots query above, not repeated here) products/locations
      // with recent sale velocity in THIS report's own selected period
      // (`since`/`periodDays`, the same window every other figure on this
      // page already uses -- no separate period concept introduced). The
      // actual days-remaining/reorder-soon computation happens below via
      // @alltix/inventory-service's assessStockForecast, same pure function
      // /inventory uses with its own fixed 30-day window -- this query only
      // fetches the raw ingredients (available + units sold in period), it
      // doesn't decide what counts as "soon" itself.
      const reorderCandidatesResult = await client.query<ReorderCandidateRow>(
        `SELECT p.internal_sku, p.name AS product_name, loc.name AS location_name,
                il.available, coalesce(sale.units_sold, 0)::text AS units_sold
           FROM inventory_levels il
           JOIN products p ON p.id = il.product_id
           JOIN locations loc ON loc.id = il.location_id
           JOIN LATERAL (
                  SELECT sum(-ie.quantity_delta) AS units_sold
                    FROM inventory_events ie
                   WHERE ie.product_id = il.product_id AND ie.location_id = il.location_id
                     AND ie.event_type = 'sale' AND ie.created_at >= $1
                ) sale ON true
          WHERE il.available > 0 AND sale.units_sold > 0`,
        [since.toISOString()],
      );

      return {
        salesByChannel: salesByChannelResult.rows,
        topSkus: topSkusResult.rows,
        returnsSummary: returnsSummaryResult.rows[0] ?? { total_returns: "0", sellable_returns: "0" },
        inventorySnapshot: inventorySnapshotResult.rows[0] ?? {
          total_on_hand: "0",
          total_reserved: "0",
          total_available: "0",
          distinct_skus: "0",
        },
        troubleSpots: troubleSpotsResult.rows,
        reorderCandidates: reorderCandidatesResult.rows,
        reorderThresholdDays: tenantResult.rows[0]!.reorder_threshold_days,
      };
    });

  const totalRevenue = salesByChannel.reduce((sum, row) => sum + Number(row.revenue), 0);
  const totalOrders = salesByChannel.reduce((sum, row) => sum + Number(row.order_count), 0);

  // Reorder soon: compute each candidate's forecast over THIS page's own
  // periodDays window, keep only ones the pure function itself flags
  // reorderSoon, then show the most urgent (fewest days remaining) first --
  // capped at 10, same list-size convention troubleSpots/topSkus above use.
  const reorderSoon = reorderCandidates
    .map((row) => ({
      ...row,
      forecast: assessStockForecast(row.available, Number(row.units_sold), periodDays, reorderThresholdDays),
    }))
    .filter((row) => row.forecast.reorderSoon)
    .sort((a, b) => (a.forecast.daysRemaining ?? 0) - (b.forecast.daysRemaining ?? 0))
    .slice(0, 10);

  return (
    <main className="page">
      <h1>
        <span className="row" style={{ gap: 8 }}>
          <AnalyticsIcon /> Analytics
        </span>
      </h1>
      <p className="subtitle">Sales, top SKUs, returns, and a live inventory snapshot — computed straight off the ledger.</p>

      <div className="row" style={{ marginBottom: 20, gap: 8 }}>
        <span className="muted">Period:</span>
        {PERIOD_CHOICES.map((choice) => (
          <a key={choice} href={`/reports?days=${choice}`} className={choice === periodDays ? "badge badge-accent" : "badge"}>
            {choice}d
          </a>
        ))}
      </div>

      <div className="kpi-grid">
        <KpiTile label="Revenue" value={`£${totalRevenue.toFixed(2)}`} meta={`Last ${periodDays}d`} />
        <KpiTile label="Orders" value={totalOrders} meta={`Last ${periodDays}d`} />
        <KpiTile label="Out of stock / oversold" value={troubleSpots.length} meta="Right now" />
        <KpiTile label="Reorder soon" value={reorderSoon.length} meta={`Last ${periodDays}d velocity`} />
      </div>

      <div className="panel-card">
        <div className="panel-card-header">
          <h2 className="panel-card-title" style={{ margin: 0 }}>
            Sales by channel
          </h2>
        </div>
        <p className="subtitle">
          Last {periodDays} days, by <code>placed_at</code>. Excludes cancelled orders. Gross revenue — not net of returns; see
          Returns below. Figures come from the nightly sales rollup, not a live scan — today's sales appear after tonight's
          run.
        </p>
        {salesByChannel.length === 0 ? (
          <p className="empty">No sales in this period.</p>
        ) : (
          <div className="panel-grid-2">
            <div className="chart-wrap">
              <DonutChart
                segments={salesByChannel.map((row) => ({
                  label: channelLabel(row.channel),
                  value: Number(row.revenue),
                  color: channelChartColor(row.channel),
                }))}
                centerLabel="Revenue"
                centerValue={`£${totalRevenue.toFixed(0)}`}
              />
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Channel</th>
                    <th>Orders</th>
                    <th>Units sold</th>
                    <th>Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {salesByChannel.map((row) => (
                    <tr key={row.channel}>
                      <td>
                        <ChannelLogo channel={row.channel} size={44} /> {channelLabel(row.channel)}
                      </td>
                      <td>{row.order_count}</td>
                      <td>{row.units_sold}</td>
                      <td>{Number(row.revenue).toFixed(2)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td>
                      <strong>Total</strong>
                    </td>
                    <td>
                      <strong>{totalOrders}</strong>
                    </td>
                    <td></td>
                    <td>
                      <strong>{totalRevenue.toFixed(2)}</strong>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <div className="panel-card" style={{ marginTop: 24 }}>
        <div className="panel-card-header">
          <h2 className="panel-card-title" style={{ margin: 0 }}>
            Top SKUs
          </h2>
        </div>
        <p className="subtitle">By revenue, last {periodDays} days.</p>
        {topSkus.length === 0 ? (
          <p className="empty">No sales in this period.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Product</th>
                  <th>Units sold</th>
                  <th>Revenue</th>
                </tr>
              </thead>
              <tbody>
                {topSkus.map((row) => (
                  <tr key={row.internal_sku}>
                    <td className="mono">{row.internal_sku}</td>
                    <td>{row.product_name}</td>
                    <td>{row.units_sold}</td>
                    <td>{Number(row.revenue).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel-grid-2" style={{ marginTop: 24 }}>
        <div className="panel-card">
          <div className="panel-card-header">
            <h2 className="panel-card-title" style={{ margin: 0 }}>
              Returns
            </h2>
          </div>
          <p className="subtitle">Orders marked returned, last {periodDays} days.</p>
          <div className="row" style={{ gap: 8 }}>
            <span className="badge">{returnsSummary.total_returns} total</span>
            <span className="badge badge-success">{returnsSummary.sellable_returns} restocked (sellable)</span>
            <span className="badge badge-danger">
              {Number(returnsSummary.total_returns) - Number(returnsSummary.sellable_returns)} damaged / not restocked
            </span>
          </div>
        </div>

        <div className="panel-card">
          <div className="panel-card-header">
            <h2 className="panel-card-title" style={{ margin: 0 }}>
              Inventory snapshot
            </h2>
          </div>
          <p className="subtitle">
            Right now, all locations — units, not a dollar value (this schema has no cost/COGS field to value stock against,
            only sale price, so a dollar figure here would misrepresent cost as revenue). See{" "}
            <a href="/inventory">/inventory</a> for the full per-location breakdown.
          </p>
          <div className="row" style={{ gap: 8 }}>
            <span className="badge">{inventorySnapshot.distinct_skus} SKUs</span>
            <span className="badge">{inventorySnapshot.total_on_hand} on hand</span>
            <span className="badge">{inventorySnapshot.total_reserved} reserved</span>
            <span className="badge badge-accent">{inventorySnapshot.total_available} available</span>
          </div>
        </div>
      </div>

      {troubleSpots.length > 0 && (
        <div className="panel-card" style={{ marginTop: 24 }}>
          <div className="panel-card-header">
            <h2 className="panel-card-title" style={{ margin: 0 }}>
              Out of stock / oversold
            </h2>
          </div>
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
                </tr>
              </thead>
              <tbody>
                {troubleSpots.map((row) => (
                  <tr key={`${row.internal_sku}:${row.location_name}`}>
                    <td className="mono">{row.internal_sku}</td>
                    <td>{row.product_name}</td>
                    <td>{row.location_name}</td>
                    <td>{row.on_hand}</td>
                    <td>{row.reserved}</td>
                    <td>
                      {row.available < 0 ? <span className="badge badge-danger">{row.available}</span> : <strong>{row.available}</strong>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="panel-card" style={{ marginTop: 24 }}>
        <div className="panel-card-header">
          <h2 className="panel-card-title" style={{ margin: 0 }}>
            Reorder soon
          </h2>
        </div>
        <p className="subtitle">
          Still in stock, but recent sales velocity over the last {periodDays} days puts them at {reorderThresholdDays} or
          fewer estimated days of stock remaining — a separate, velocity-based signal from the out-of-stock list above. See{" "}
          <a href="/inventory">/inventory</a> for the per-row figure (fixed 30-day window), every product/location not just
          the top 10 most urgent shown here, and to change the {reorderThresholdDays}-day threshold itself. A product with
          low stock but no recent sales in this window won't appear here — see the inventory page's own note on why that's a
          deliberate "unknown," not "safe."
        </p>
        {reorderSoon.length === 0 ? (
          <p className="empty">Nothing trending toward stockout in this period.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Product</th>
                  <th>Location</th>
                  <th>Available</th>
                  <th>Sold ({periodDays}d)</th>
                  <th>Est. days left</th>
                </tr>
              </thead>
              <tbody>
                {reorderSoon.map((row) => (
                  <tr key={`${row.internal_sku}:${row.location_name}`}>
                    <td className="mono">{row.internal_sku}</td>
                    <td>{row.product_name}</td>
                    <td>{row.location_name}</td>
                    <td>{row.available}</td>
                    <td>{row.units_sold}</td>
                    <td>
                      <span className="badge badge-warning">~{Math.round(row.forecast.daysRemaining ?? 0)}d</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
