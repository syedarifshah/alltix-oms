import type { ReactElement } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getBillingSummary, type BillingSummary } from "@alltix/billing-service";
import { getAppPool, getAdminPool } from "@/lib/db";
import { getAuthContext } from "@/lib/auth-context";
import { requirePlatformOperator } from "@/lib/platform-operator";
import { ALL_CHANNELS, type Channel } from "@/lib/channel-flags";
import { ALL_CARRIERS, type Carrier } from "@/lib/carrier-flags";
import { channelLabel } from "@/lib/channel-badge";

export const dynamic = "force-dynamic";

/** Same "active-ish" status classification `/settings/billing` itself uses
 *  (CLAUDE.md §8's "Real usage-based billing" subsection) -- kept as an
 *  independent copy rather than imported, same "two independent copies of a
 *  small shared idea" precedent channel-flags.ts/carrier-flags.ts's own
 *  ALL_CHANNELS/ALL_CARRIERS lists already establish for this codebase, since
 *  @alltix/billing-service has no shared-constant export for this and adding
 *  one purely to de-duplicate a 3-item Set isn't worth a new export surface. */
const ACTIVE_ISH_STATUSES = new Set(["active", "trialing", "past_due"]);

const CARRIER_LABELS: Record<Carrier, string> = {
  royal_mail: "Royal Mail",
  evri: "Evri",
  fedex: "FedEx",
  parcelforce: "Parcelforce",
  ups: "UPS",
  dhl: "DHL",
  dpd: "DPD",
};

interface TenantRow {
  id: string;
  name: string;
  created_at: string;
  subscription_status: string | null;
  enabled_channels: string[];
  enabled_carriers: string[];
  user_count: string;
  order_count: string;
  active_channel_connections: string;
  error_channel_connections: string;
  active_carrier_connections: string;
  error_carrier_connections: string;
}

interface AdminPageProps {
  searchParams: Promise<{ error?: string; updated?: string }>;
}

/**
 * Platform-operator console -- closes CLAUDE.md §12's own "No operator UI
 * for channel flags" gap and §19.8's identical carrier-layer gap ("There is
 * no multi-tenant admin surface anywhere in this codebase yet to hang a
 * real toggle UI off of"). Both sections were explicit this was deferred
 * deliberately, not forgotten, until a real multi-tenant admin surface
 * existed to hang a toggle UI off of -- this page, and the two mutation
 * routes it posts to (./api/admin/tenants/[id]/{channel,carrier}-flags), are
 * that surface. `npm run platform:set-{channel,carrier}-flags`
 * (scripts/set-*-flags.ts) still work unchanged -- this doesn't replace
 * them, it just means a real toggle no longer requires shell access to the
 * deployment's own Postgres credentials.
 *
 * Gated by {@link requirePlatformOperator} (lib/platform-operator.ts), not
 * the ordinary tenant-scoped resolveTenantId/withTenantAuth path every
 * other page in this app uses -- a platform operator is a signed-in Clerk
 * user whose own email is on the PLATFORM_OPERATOR_EMAILS allowlist, no
 * new roles/orgs table. A signed-in user who isn't an operator (the
 * overwhelming common case, including every real tenant this platform will
 * ever have) is redirected straight to /dashboard, same as a fully signed-
 * out visitor is redirected to /sign-in -- this page's own existence is
 * never advertised to a non-operator via a visible 403, only via the
 * sidebar's own conditional Admin link (components/nav.tsx).
 *
 * Reads the cross-tenant tenant list via {@link getAdminPool}, the same
 * justified, narrowly-scoped RLS-bypassing exception
 * packages/scheduler's own tenant-enumeration queries and
 * /api/webhooks/shopify's own tenant-resolution query already use (see
 * lib/db.ts's own doc comment) -- "which tenants exist, and what's their
 * current channel/carrier/connection health" is inherently a cross-tenant
 * question RLS makes impossible through the normal app_user path by
 * design, the identical reasoning that already justifies this exception
 * everywhere else it's used in this codebase. The two mutation routes this
 * page posts to do NOT need the admin pool themselves -- see their own doc
 * comments for why an update against one already-known tenant id is an
 * ordinary withTenant() call, not a second cross-tenant read.
 */
export default async function AdminPage({ searchParams }: AdminPageProps): Promise<ReactElement> {
  const authContext = await getAuthContext(await headers());
  if (!authContext) {
    redirect("/sign-in");
  }

  const operator = await requirePlatformOperator(getAppPool(), authContext.clerkUserId);
  if (!operator) {
    redirect("/dashboard");
  }

  const { error, updated } = await searchParams;

  const adminPool = getAdminPool();
  const result = await adminPool.query<TenantRow>(
    `SELECT
       t.id,
       t.name,
       t.created_at,
       t.subscription_status,
       t.enabled_channels,
       t.enabled_carriers,
       (SELECT count(*) FROM users u WHERE u.tenant_id = t.id) AS user_count,
       (SELECT count(*) FROM orders o WHERE o.tenant_id = t.id) AS order_count,
       (SELECT count(*) FROM channel_connections cc WHERE cc.tenant_id = t.id AND cc.status = 'active') AS active_channel_connections,
       (SELECT count(*) FROM channel_connections cc WHERE cc.tenant_id = t.id AND cc.status = 'error') AS error_channel_connections,
       (SELECT count(*) FROM carrier_connections crc WHERE crc.tenant_id = t.id AND crc.status = 'active') AS active_carrier_connections,
       (SELECT count(*) FROM carrier_connections crc WHERE crc.tenant_id = t.id AND crc.status = 'error') AS error_carrier_connections
     FROM tenants t
     ORDER BY t.created_at ASC`,
  );
  const tenants = result.rows;

  // Billing/subscription details per tenant (getBillingSummary(), the same
  // function /settings/billing already uses) -- deliberately N+1 queries (one
  // getBillingSummary() call per tenant, via the ordinary app_user pool +
  // withTenant(), not a second adminPool cross-tenant query) rather than
  // extending the admin page's own cross-tenant SELECT above to also read
  // stripe_customer_id/subscription_current_period_end/tenant_usage/products
  // directly. Reasoning: this page's own doc comment already draws that exact
  // line for the mutation routes below ("an update against one already-known
  // tenant id is an ordinary withTenant() call, not a second cross-tenant
  // read") -- getBillingSummary() is the same shape, just a read instead of a
  // write, and reusing it here means this page can never drift out of sync
  // with /settings/billing's own definition of what a tenant's billing
  // summary means. At today's real tenant count this is a handful of extra
  // queries, not a scaling concern; worth revisiting (a batched cross-tenant
  // query variant) only if/when this platform has enough tenants for that to
  // matter, same "don't build for scale nobody's earned yet" discipline this
  // file already applies elsewhere. Each call is individually guarded -- a
  // billing-read failure for one tenant (e.g. a row this function can't yet
  // handle) shows as "unavailable" on that one card rather than taking down
  // the whole console.
  const appPool = getAppPool();
  const billingSummaries = await Promise.all(
    tenants.map(async (tenant): Promise<BillingSummary | null> => {
      try {
        return await getBillingSummary(appPool, tenant.id);
      } catch {
        return null;
      }
    }),
  );

  return (
    <main className="page">
      <h1>Platform admin</h1>
      <p className="subtitle">
        Cross-tenant operator console, visible only to {operator.email} (PLATFORM_OPERATOR_EMAILS). Toggle which
        channels/carriers a tenant can connect to and keep syncing -- see CLAUDE.md&apos;s &quot;Channel Feature
        Flags&quot; and &quot;Carrier Feature Flags&quot; sections for exactly what a flag does and doesn&apos;t
        gate. Every change here is recorded on the affected tenant&apos;s own Audit Log
        (/settings/activity), attributed to your email.
      </p>

      {updated === "channels" && <div className="alert alert-success">Channel flags updated.</div>}
      {updated === "carriers" && <div className="alert alert-success">Carrier flags updated.</div>}
      {error && <div className="alert alert-danger">{describeAdminError(error)}</div>}

      {tenants.length === 0 ? (
        <div className="panel-card">
          <p className="empty">No tenants exist yet.</p>
        </div>
      ) : (
        tenants.map((tenant, index) => (
          <TenantCard key={tenant.id} tenant={tenant} billing={billingSummaries[index] ?? null} />
        ))
      )}
    </main>
  );
}

function TenantCard({ tenant, billing }: { tenant: TenantRow; billing: BillingSummary | null }): ReactElement {
  const enabledChannels = new Set(tenant.enabled_channels);
  const enabledCarriers = new Set(tenant.enabled_carriers);

  return (
    <div className="panel-card" style={{ marginBottom: 20 }}>
      <div className="panel-card-header">
        <div>
          <div className="panel-card-title">{tenant.name}</div>
          <div className="panel-card-subtitle">
            {tenant.id} &middot; created {new Date(tenant.created_at).toISOString().slice(0, 10)}
          </div>
        </div>
        <span className="badge">{tenant.subscription_status ?? "no subscription"}</span>
      </div>

      <div className="row" style={{ gap: 20, marginBottom: 16, flexWrap: "wrap" }}>
        <span className="muted">{tenant.user_count} user(s)</span>
        <span className="muted">{tenant.order_count} order(s)</span>
        <span className={tenant.error_channel_connections !== "0" ? "badge badge-danger" : "badge badge-success"}>
          channels: {tenant.active_channel_connections} active
          {tenant.error_channel_connections !== "0" ? `, ${tenant.error_channel_connections} error` : ""}
        </span>
        <span className={tenant.error_carrier_connections !== "0" ? "badge badge-danger" : "badge badge-success"}>
          carriers: {tenant.active_carrier_connections} active
          {tenant.error_carrier_connections !== "0" ? `, ${tenant.error_carrier_connections} error` : ""}
        </span>
      </div>

      <BillingPanel billing={billing} />

      <div className="row" style={{ gap: 32, alignItems: "flex-start", flexWrap: "wrap" }}>
        <form
          method="post"
          action={`/api/admin/tenants/${tenant.id}/channel-flags`}
          style={{ minWidth: 220 }}
        >
          <div className="panel-card-subtitle" style={{ marginBottom: 8 }}>
            Enabled channels
          </div>
          {ALL_CHANNELS.map((channel: Channel) => (
            <label key={channel} className="row" style={{ gap: 6, marginBottom: 4 }}>
              <input type="checkbox" name="channels" value={channel} defaultChecked={enabledChannels.has(channel)} />
              {channelLabel(channel)}
            </label>
          ))}
          <button type="submit" className="btn secondary" style={{ marginTop: 8 }}>
            Save channels
          </button>
        </form>

        <form
          method="post"
          action={`/api/admin/tenants/${tenant.id}/carrier-flags`}
          style={{ minWidth: 220 }}
        >
          <div className="panel-card-subtitle" style={{ marginBottom: 8 }}>
            Enabled carriers
          </div>
          {ALL_CARRIERS.map((carrier: Carrier) => (
            <label key={carrier} className="row" style={{ gap: 6, marginBottom: 4 }}>
              <input type="checkbox" name="carriers" value={carrier} defaultChecked={enabledCarriers.has(carrier)} />
              {CARRIER_LABELS[carrier]}
            </label>
          ))}
          <button type="submit" className="btn secondary" style={{ marginTop: 8 }}>
            Save carriers
          </button>
        </form>
      </div>
    </div>
  );
}

/** Read-only billing/subscription summary for one tenant, reusing
 *  getBillingSummary() (the same function /settings/billing itself calls --
 *  see AdminPage's own doc comment above for why this is called per-tenant
 *  here rather than folded into the admin page's own cross-tenant SELECT).
 *  `billing === null` covers both "the read failed" and the not-yet-real
 *  "no tenant row" case -- shown identically as "unavailable" since a
 *  platform operator has no action to take either way from this card; the
 *  real fix (if the read is genuinely failing) is server-side, not something
 *  this page can offer a button for. */
function BillingPanel({ billing }: { billing: BillingSummary | null }): ReactElement {
  if (!billing) {
    return (
      <div className="panel-card" style={{ marginBottom: 16, background: "var(--neutral-bg)" }}>
        <div className="panel-card-subtitle">Billing</div>
        <p className="muted" style={{ margin: 0 }}>
          Billing summary unavailable.
        </p>
      </div>
    );
  }

  const isActiveIsh = billing.subscriptionStatus !== null && ACTIVE_ISH_STATUSES.has(billing.subscriptionStatus);
  const orderUsageRatio = billing.orderLimit > 0 ? billing.ordersThisMonth / billing.orderLimit : 0;
  const overOrderLimit = billing.ordersThisMonth > billing.orderLimit;

  return (
    <div className="panel-card" style={{ marginBottom: 16, background: "var(--neutral-bg)" }}>
      <div className="panel-card-subtitle" style={{ marginBottom: 8 }}>
        Billing
      </div>
      <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <span className={isActiveIsh ? "badge badge-success" : "badge"}>{billing.subscriptionStatus ?? "none"}</span>
        <span className="muted">{billing.hasStripeCustomer ? "Stripe customer on file" : "no Stripe customer yet"}</span>
        {billing.currentPeriodEnd && (
          <span className="muted">period ends {new Date(billing.currentPeriodEnd).toISOString().slice(0, 10)}</span>
        )}
        <span className="muted">{billing.skuCount} SKUs</span>
      </div>
      <div className="row" style={{ gap: 8, marginTop: 8, alignItems: "center" }}>
        <span>
          {billing.ordersThisMonth} / {billing.orderLimit} orders this month
        </span>
        {overOrderLimit && <span className="badge badge-warning">over limit</span>}
        {billing.usageBasedBillingConfigured && <span className="muted">(metered overage configured)</span>}
      </div>
      <div style={{ background: "var(--surface)", borderRadius: 4, height: 6, marginTop: 6, overflow: "hidden" }}>
        <div
          style={{
            width: `${Math.min(orderUsageRatio, 1) * 100}%`,
            background: overOrderLimit ? "var(--danger)" : "var(--accent)",
            height: "100%",
          }}
        />
      </div>
    </div>
  );
}

/** Same "friendly redirect-error mapping" convention every other page's
 *  own describeError() follows (e.g. /locations') -- most of this route's
 *  own errors already carry a readable suffix via errorMessage(), so this
 *  only special-cases the two fixed codes that don't. */
function describeAdminError(code: string): string {
  if (code === "not_authorized") return "Not authorized -- your account isn't on the platform-operator allowlist.";
  if (code === "tenant_not_found") return "That tenant no longer exists.";
  return code;
}
