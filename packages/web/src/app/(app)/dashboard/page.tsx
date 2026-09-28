import type { ReactElement } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { withTenant } from "@alltix/db";
import { getAppPool } from "@/lib/db";
import { getAuthContext } from "@/lib/auth-context";
import { resolveTenantId } from "@/lib/with-tenant-auth";
import { getEnabledChannels } from "@/lib/channel-flags";
import { channelBadgeClass, channelChartColor, channelLabel } from "@/lib/channel-badge";
import { ALL_ORDER_STATUSES } from "@/lib/order-status";
import { describeAction } from "@/lib/audit-log-format";
import { KpiTile } from "@/components/kpi-tile";
import { LineChart, type LineSeries } from "@/components/charts/line-chart";
import { DonutChart, type DonutSegment } from "@/components/charts/donut-chart";
import { BarChart, type BarGroup } from "@/components/charts/bar-chart";

export const dynamic = "force-dynamic";

const TREND_DAYS = 14;
const ACTIVITY_LIMIT = 8;

/** Chart color per order status -- same tone grouping order-status.ts's own
 *  STATUS_TONE map uses for badges (neutral/accent/warning/success/danger),
 *  expressed as chart-safe CSS vars instead of badge classes since this
 *  feeds an SVG stroke/fill, not a <span> class. */
const STATUS_CHART_COLOR: Record<string, string> = {
  received: "var(--chart-3)",
  validated: "var(--chart-3)",
  on_hold: "var(--warning)",
  allocated: "var(--chart-1)",
  backordered: "var(--warning)",
  picking: "var(--chart-1)",
  packed: "var(--chart-1)",
  shipped: "var(--success)",
  delivered: "var(--success)",
  returned: "var(--danger)",
  refunded: "var(--danger)",
  cancelled: "var(--danger)",
};

interface TodayAggRow {
  order_count: string;
  revenue: string;
}

interface ChannelOrderRow {
  channel: string;
  order_count: string;
  revenue: string;
}

interface ChannelConnRow {
  channel: string;
  active_count: string;
  total_count: string;
  last_sync: string | null;
  max_failures: string;
  rate_limited_until: string | null;
}

interface OrderStateRow {
  status: string;
  count: string;
}

interface LocationInventoryRow {
  location_name: string;
  on_hand: string;
  reserved: string;
}

interface TrendRow {
  sale_date: string;
  channel: string;
  order_count: string;
}

interface ActivityRow {
  action: string;
  entity_type: string;
  entity_id: string | null;
  created_at: string;
  actor_email: string | null;
}

/** UTC day boundary -- consistent with @alltix/scheduler's rollupDailySales
 *  and every other date-bucketing query in this app (see migration
 *  0045_daily_sales_rollups.sql's own header comment), so "today" here
 *  means the same calendar day the nightly rollup itself uses. */
function utcDayStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function pctDelta(current: number, previous: number): { direction: "up" | "down"; text: string } | undefined {
  if (previous <= 0) return undefined;
  const change = ((current - previous) / previous) * 100;
  return { direction: change >= 0 ? "up" : "down", text: `${Math.abs(change).toFixed(1)}% vs yesterday` };
}

/**
 * The app's new landing page (CLAUDE.md's "at a glance" overview the
 * v1 visual redesign added -- see the reference brief this was built from).
 * Every figure below is a live query against tables this app already had
 * (orders/order_lines, inventory_levels, channel_connections, audit_log,
 * rule_executions, daily_channel_sales_rollups) -- no new tables, no
 * fabricated numbers. Two different freshness models coexist deliberately:
 * "today"/"month to date" KPIs are computed live (accuracy matters for a
 * number labeled "today"), while the 14-day trend line reuses the nightly
 * sales rollup (migration 0045) the same way /reports already does, so
 * today's own slice of that one chart may read 0 until tonight's cron run
 * -- called out in its own caption rather than silently looking wrong.
 */
export default async function DashboardPage(): Promise<ReactElement> {
  const authContext = await getAuthContext(await headers());
  if (!authContext) {
    redirect("/sign-in");
  }

  const pool = getAppPool();
  const tenantId = await resolveTenantId(pool, authContext.clerkUserId);
  if (!tenantId) {
    return (
      <main className="page">
        <h1>Dashboard</h1>
        <p>No tenant is associated with this account yet.</p>
      </main>
    );
  }

  const now = new Date();
  const todayStart = utcDayStart(now);
  const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const trendSince = new Date(todayStart.getTime() - (TREND_DAYS - 1) * 24 * 60 * 60 * 1000);

  const data = await withTenant(pool, tenantId, async (client) => {
    const enabledChannels = await getEnabledChannels(client, tenantId);

    const todayResult = await client.query<TodayAggRow>(
      `SELECT count(DISTINCT o.id)::text AS order_count, coalesce(sum(ol.unit_price * ol.quantity), 0)::text AS revenue
         FROM orders o
         LEFT JOIN order_lines ol ON ol.order_id = o.id
        WHERE o.placed_at >= $1 AND o.status <> 'cancelled'`,
      [todayStart.toISOString()],
    );
    const yesterdayResult = await client.query<TodayAggRow>(
      `SELECT count(DISTINCT o.id)::text AS order_count, coalesce(sum(ol.unit_price * ol.quantity), 0)::text AS revenue
         FROM orders o
         LEFT JOIN order_lines ol ON ol.order_id = o.id
        WHERE o.placed_at >= $1 AND o.placed_at < $2 AND o.status <> 'cancelled'`,
      [yesterdayStart.toISOString(), todayStart.toISOString()],
    );
    const mtdResult = await client.query<TodayAggRow>(
      `SELECT count(DISTINCT o.id)::text AS order_count, coalesce(sum(ol.unit_price * ol.quantity), 0)::text AS revenue
         FROM orders o
         LEFT JOIN order_lines ol ON ol.order_id = o.id
        WHERE o.placed_at >= $1 AND o.status <> 'cancelled'`,
      [monthStart.toISOString()],
    );
    const channelOrdersTodayResult = await client.query<ChannelOrderRow>(
      `SELECT o.channel, count(DISTINCT o.id)::text AS order_count, coalesce(sum(ol.unit_price * ol.quantity), 0)::text AS revenue
         FROM orders o
         LEFT JOIN order_lines ol ON ol.order_id = o.id
        WHERE o.placed_at >= $1 AND o.status <> 'cancelled'
        GROUP BY o.channel`,
      [todayStart.toISOString()],
    );
    const atsResult = await client.query<{ available: string; location_count: string }>(
      `SELECT coalesce(sum(il.available), 0)::text AS available, count(DISTINCT loc.id)::text AS location_count
         FROM locations loc
         LEFT JOIN inventory_levels il ON il.location_id = loc.id`,
    );
    const channelConnResult = await client.query<ChannelConnRow>(
      `SELECT channel,
              count(*) FILTER (WHERE status = 'active')::text AS active_count,
              count(*)::text AS total_count,
              max(last_order_sync_at)::text AS last_sync,
              max(consecutive_failures)::text AS max_failures,
              max(rate_limited_until)::text AS rate_limited_until
         FROM channel_connections
        GROUP BY channel`,
    );
    const orderStateResult = await client.query<OrderStateRow>(`SELECT status, count(*)::text AS count FROM orders GROUP BY status`);
    const inventoryByLocationResult = await client.query<LocationInventoryRow>(
      `SELECT loc.name AS location_name, coalesce(sum(il.on_hand), 0)::text AS on_hand, coalesce(sum(il.reserved), 0)::text AS reserved
         FROM locations loc
         LEFT JOIN inventory_levels il ON il.location_id = loc.id
        GROUP BY loc.id, loc.name
        ORDER BY loc.name`,
    );
    const trendResult = await client.query<TrendRow>(
      `SELECT sale_date::text, channel, order_count::text
         FROM daily_channel_sales_rollups
        WHERE sale_date >= $1
        ORDER BY sale_date`,
      [trendSince.toISOString().slice(0, 10)],
    );
    // rule_executions.applied = true is "this rule actually took an action",
    // not just "matched" -- see migration 0014's own column comments. This
    // is the aggregate CLAUDE.md's own /rules page never computed (only the
    // most recent execution per rule, see that page's LEFT JOIN LATERAL) --
    // a real COUNT(*) over data that already exists, not a new metric.
    const ruleFiredResult = await client.query<{ fired_count: string }>(
      `SELECT count(*)::text AS fired_count FROM rule_executions WHERE applied = true`,
    );
    const activityResult = await client.query<ActivityRow>(
      `SELECT al.action, al.entity_type, al.entity_id, al.created_at, u.email AS actor_email
         FROM audit_log al
         LEFT JOIN users u ON u.id = al.user_id
        WHERE al.tenant_id = $1
        ORDER BY al.created_at DESC
        LIMIT $2`,
      [tenantId, ACTIVITY_LIMIT],
    );

    return {
      enabledChannels,
      today: todayResult.rows[0]!,
      yesterday: yesterdayResult.rows[0]!,
      mtd: mtdResult.rows[0]!,
      channelOrdersToday: channelOrdersTodayResult.rows,
      ats: atsResult.rows[0]!,
      channelConn: channelConnResult.rows,
      orderState: orderStateResult.rows,
      inventoryByLocation: inventoryByLocationResult.rows,
      trend: trendResult.rows,
      ruleFiredCount: Number(ruleFiredResult.rows[0]?.fired_count ?? 0),
      activity: activityResult.rows,
    };
  });

  const ordersToday = Number(data.today.order_count);
  const ordersYesterday = Number(data.yesterday.order_count);
  const revenueToday = Number(data.today.revenue);
  const revenueYesterday = Number(data.yesterday.revenue);
  const currency = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

  const connectedChannelCount = data.channelConn.filter((c) => Number(c.active_count) > 0).length;

  // --- Orders trend chart: one line per channel that appears anywhere in
  // the last TREND_DAYS of rollup data, categories are every day in the
  // window (not just days with data), so a channel with a quiet day draws
  // a 0 rather than a gap. ---
  const trendDates: string[] = [];
  for (let i = 0; i < TREND_DAYS; i++) {
    const d = new Date(trendSince.getTime() + i * 24 * 60 * 60 * 1000);
    trendDates.push(d.toISOString().slice(0, 10));
  }
  const trendChannels = [...new Set(data.trend.map((r) => r.channel))].sort();
  const trendByKey = new Map(data.trend.map((r) => [`${r.sale_date}:${r.channel}`, Number(r.order_count)]));
  const trendSeries: LineSeries[] = trendChannels.map((channel) => ({
    label: channelLabel(channel),
    color: channelChartColor(channel),
    values: trendDates.map((date) => trendByKey.get(`${date}:${channel}`) ?? 0),
  }));
  const trendLabels = trendDates.map((d) => d.slice(5));

  // --- Order state donut ---
  const stateCountByStatus = new Map(data.orderState.map((r) => [r.status, Number(r.count)]));
  const donutSegments: DonutSegment[] = ALL_ORDER_STATUSES.filter((status) => (stateCountByStatus.get(status) ?? 0) > 0).map((status) => ({
    label: status,
    value: stateCountByStatus.get(status) ?? 0,
    color: STATUS_CHART_COLOR[status] ?? "var(--chart-3)",
  }));
  const totalOrders = donutSegments.reduce((sum, s) => sum + s.value, 0);

  // --- Inventory health by location bar chart ---
  const inventoryGroups: BarGroup[] = data.inventoryByLocation.map((row) => ({
    category: row.location_name,
    values: [Number(row.on_hand), Number(row.reserved)],
  }));

  const channelOrdersTodayByChannel = new Map(data.channelOrdersToday.map((r) => [r.channel, r]));

  return (
    <main className="page">
      <h1>Dashboard</h1>
      <p className="subtitle">Live ops overview — orders and revenue are real-time; the 14-day trend below reflects last night&apos;s rollup.</p>

      <div className="kpi-grid">
        <KpiTile label="Orders today" value={ordersToday} delta={pctDelta(ordersToday, ordersYesterday)} />
        <KpiTile label="Revenue today" value={currency(revenueToday)} delta={pctDelta(revenueToday, revenueYesterday)} />
        <KpiTile
          label="Available-to-sell units"
          value={Number(data.ats.available).toLocaleString()}
          meta={`across ${data.ats.location_count} location${data.ats.location_count === "1" ? "" : "s"}`}
        />
        <KpiTile
          label="Active channels synced"
          value={`${connectedChannelCount}/${data.enabledChannels.length || data.channelConn.length}`}
          meta={data.channelConn.filter((c) => Number(c.active_count) > 0).map((c) => channelLabel(c.channel)).join(", ") || "none yet"}
        />
        <KpiTile label="MTD revenue" value={currency(Number(data.mtd.revenue))} meta={`${data.mtd.order_count} orders this month`} />
      </div>

      <div className="panel-grid-2">
        <div className="panel-card">
          <div className="panel-card-header">
            <h2 className="panel-card-title" style={{ margin: 0 }}>
              Channel sync status
            </h2>
          </div>
          <p className="panel-card-subtitle">Marketplace connectors and recent sync health.</p>
          <div className="stack">
            {[...new Set<string>([...data.enabledChannels, ...data.channelConn.map((c) => c.channel)])].map((channel) => {
                const conn = data.channelConn.find((c) => c.channel === channel);
                const todayRow = channelOrdersTodayByChannel.get(channel);
                const isConnected = conn ? Number(conn.active_count) > 0 : false;
                const isThrottled = conn?.rate_limited_until ? new Date(conn.rate_limited_until).getTime() > Date.now() : false;
                return (
                  <div key={channel} className="row" style={{ justifyContent: "space-between", borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                    <div className="row" style={{ gap: 8 }}>
                      <span className={channelBadgeClass(channel)}>{channelLabel(channel)}</span>
                      {!conn ? (
                        <span className="muted">not connected</span>
                      ) : isThrottled ? (
                        <span className="badge badge-warning">rate-limited</span>
                      ) : isConnected ? (
                        <span className="badge badge-success">connected</span>
                      ) : (
                        <span className="badge badge-danger">disconnected</span>
                      )}
                    </div>
                    <div className="muted" style={{ fontSize: "0.8rem", textAlign: "right" }}>
                      {todayRow ? `${todayRow.order_count} orders today` : "0 orders today"}
                      {conn?.last_sync && (
                        <>
                          {" · "}
                          last sync {new Date(conn.last_sync).toISOString()}
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            {data.enabledChannels.length === 0 && data.channelConn.length === 0 && <p className="empty">No channels configured yet.</p>}
          </div>
          <p className="muted" style={{ fontSize: "0.78rem", marginTop: 10, marginBottom: 0 }}>
            <a href="/channels">Manage channels →</a>
          </p>
        </div>

        <div className="panel-card">
          <div className="panel-card-header">
            <h2 className="panel-card-title" style={{ margin: 0 }}>
              Live activity
            </h2>
          </div>
          <p className="panel-card-subtitle">Latest tracked events across your account.</p>
          {data.activity.length === 0 ? (
            <p className="empty">No tracked activity yet.</p>
          ) : (
            <ul className="activity-feed">
              {data.activity.map((row, i) => (
                <li key={i} className="activity-item">
                  <span className="activity-dot" />
                  <div className="activity-body">
                    <div>
                      {describeAction(row.action)}
                      {row.entity_id && <span className="muted mono"> ({row.entity_id.slice(0, 8)})</span>}
                    </div>
                    <div className="activity-time">
                      {row.actor_email ?? "system"} · {new Date(row.created_at).toISOString()}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="muted" style={{ fontSize: "0.78rem", marginTop: 10, marginBottom: 0 }}>
            <a href="/settings/activity">View full activity log →</a> · {data.ruleFiredCount} automation actions fired to date
          </p>
        </div>
      </div>

      <div className="panel-grid-2">
        <div className="panel-card">
          <div className="panel-card-header">
            <h2 className="panel-card-title" style={{ margin: 0 }}>
              Orders trend — last {TREND_DAYS} days
            </h2>
          </div>
          <p className="panel-card-subtitle">Daily order volume by channel, from the nightly sales rollup.</p>
          {trendSeries.length === 0 ? (
            <p className="empty">No rollup data yet — figures appear after the first nightly run.</p>
          ) : (
            <LineChart categories={trendLabels} series={trendSeries} />
          )}
        </div>

        <div className="panel-card">
          <div className="panel-card-header">
            <h2 className="panel-card-title" style={{ margin: 0 }}>
              Order state distribution
            </h2>
          </div>
          <p className="panel-card-subtitle">Current pipeline state of all orders ({totalOrders} total).</p>
          {donutSegments.length === 0 ? (
            <p className="empty">No orders yet.</p>
          ) : (
            <DonutChart segments={donutSegments} centerValue={String(totalOrders)} centerLabel="orders" />
          )}
        </div>
      </div>

      <div className="panel-card">
        <div className="panel-card-header">
          <h2 className="panel-card-title" style={{ margin: 0 }}>
            Inventory health by location
          </h2>
        </div>
        <p className="panel-card-subtitle">On-hand vs. reserved units per location.</p>
        {inventoryGroups.length === 0 ? (
          <p className="empty">No locations yet.</p>
        ) : (
          <BarChart groups={inventoryGroups} seriesLabels={["On-hand", "Reserved"]} seriesColors={["var(--chart-5)", "var(--chart-4)"]} />
        )}
      </div>
    </main>
  );
}
