import type { ReactElement } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getOrCreateStripeCustomer, getBillingSummary } from "@alltix/billing-service";
import { getAppPool } from "@/lib/db";
import { getAuthContext } from "@/lib/auth-context";
import { resolveTenantId } from "@/lib/with-tenant-auth";

export const dynamic = "force-dynamic";

const ACTIVE_ISH_STATUSES = new Set(["active", "trialing", "past_due"]);

interface BillingPageProps {
  searchParams: Promise<{ checkout?: string; error?: string }>;
}

/**
 * Basic billing/subscription page (CLAUDE.md §1 Billing, §8 Phase 2 --
 * "basic," one flat plan). Lazily creates the tenant's Stripe Customer on
 * first visit (getOrCreateStripeCustomer is idempotent -- see its doc
 * comment), then shows subscription status and usage against the flat
 * plan limit. Subscribing/managing both go through Stripe's hosted
 * Checkout/Customer Portal (POST /api/billing/checkout,
 * /api/billing/portal) -- no card-collection UI lives in this app
 * (CLAUDE.md §6).
 *
 * summary.usageBasedBillingConfigured (real usage-based billing --
 * @alltix/billing-service's UsageReporter) decides which of two captions
 * this page shows under the usage bar: whether going over orderLimit is
 * still purely informational, or genuinely billed as metered overage on
 * this tenant's next Checkout. It says nothing about *this* tenant's
 * current subscription specifically -- it's a platform-wide setting
 * (STRIPE_METERED_ORDERS_PRICE_ID) -- so a tenant who subscribed before it
 * was turned on won't see overage billed until they resubscribe through
 * Checkout again (createCheckoutSession() only adds the metered line item
 * to *new* Checkout Sessions, see its own doc comment).
 */
export default async function BillingPage({ searchParams }: BillingPageProps): Promise<ReactElement> {
  const authContext = await getAuthContext(await headers());
  if (!authContext) {
    redirect("/sign-in");
  }

  const pool = getAppPool();
  const tenantId = await resolveTenantId(pool, authContext.clerkUserId);
  const { checkout, error } = await searchParams;

  if (!tenantId) {
    return (
      <main className="page">
        <h1>Billing</h1>
        <p>No tenant is associated with this account yet.</p>
      </main>
    );
  }

  await getOrCreateStripeCustomer(pool, tenantId);
  const summary = await getBillingSummary(pool, tenantId);

  const isActiveIsh = summary.subscriptionStatus !== null && ACTIVE_ISH_STATUSES.has(summary.subscriptionStatus);
  const orderUsageRatio = summary.orderLimit > 0 ? summary.ordersThisMonth / summary.orderLimit : 0;
  const overOrderLimit = summary.ordersThisMonth > summary.orderLimit;

  return (
    <main className="page">
      <h1>Billing</h1>
      <p className="subtitle">One MVP plan for now — tiered pricing comes later once there&apos;s a real reason to need it.</p>

      {checkout === "success" && <div className="alert alert-success">Subscription started — thanks!</div>}
      {checkout === "cancelled" && <div className="alert alert-info">Checkout was cancelled — no charge was made.</div>}
      {error && <div className="alert alert-danger">{decodeURIComponent(error)}</div>}

      <div className="card">
        <div className="row">
          <span className="muted">Subscription status:</span>
          <span className={isActiveIsh ? "badge badge-success" : "badge"}>
            {summary.subscriptionStatus ?? "none"}
          </span>
        </div>
        {summary.currentPeriodEnd && (
          <div className="muted" style={{ marginTop: 6 }}>
            Current period ends {new Date(summary.currentPeriodEnd).toISOString()}
          </div>
        )}
        <div style={{ marginTop: 12 }}>
          {isActiveIsh ? (
            <form action="/api/billing/portal" method="POST">
              <button type="submit">Manage subscription</button>
            </form>
          ) : (
            <form action="/api/billing/checkout" method="POST">
              <button type="submit">Subscribe</button>
            </form>
          )}
        </div>
      </div>

      <h2>Usage this month</h2>
      <div className="card stack">
        <div>
          <div className="row">
            <span>{summary.ordersThisMonth} orders processed</span>
            <span className="muted">/ {summary.orderLimit} plan limit</span>
            {overOrderLimit && <span className="badge badge-warning">over limit</span>}
          </div>
          <div style={{ background: "var(--neutral-bg)", borderRadius: 4, height: 6, marginTop: 6, overflow: "hidden" }}>
            <div
              style={{
                width: `${Math.min(orderUsageRatio, 1) * 100}%`,
                background: overOrderLimit ? "var(--danger)" : "var(--accent)",
                height: "100%",
              }}
            />
          </div>
        </div>
        <div>{summary.skuCount} SKUs</div>
      </div>
      <p className="muted">
        {summary.usageBasedBillingConfigured
          ? "Orders beyond the plan limit are billed as metered overage on your next Checkout — nothing is blocked for being over a limit, but going over does cost something now."
          : "Usage limits are informational only in this pass — nothing is blocked for being over a limit yet."}
      </p>
    </main>
  );
}
