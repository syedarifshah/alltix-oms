import Stripe from "stripe";
import type { Pool } from "pg";
import { withTenant, withStripeCustomer } from "@alltix/db";

// Billing/Subscription module (CLAUDE.md §1, §5 Stripe Billing) -- basic
// scope per CLAUDE.md §8 Phase 2: Stripe Customer + hosted Checkout/Portal,
// one flat plan, webhook-driven subscription status, and simple usage
// counters. No metered-billing API usage, no multi-tier pricing -- those
// are explicitly deferred until there's a real reason to need them.
//
// Checked before writing any of this: no Stripe dependency, API key
// reference, webhook route, or stripe-prefixed table existed anywhere in
// this repo -- this is genuinely new, not wiring up something half-built.

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  }
  return value;
}

let cachedStripe: Stripe | null = null;

/** Lazily constructs the Stripe client from STRIPE_SECRET_KEY -- lazy so
 *  importing this module never fails just because the env var isn't set
 *  yet (e.g. typecheck/build), only an actual Stripe call does. No
 *  `apiVersion` pinned explicitly: the installed SDK version already pins
 *  one (see node_modules/stripe/cjs/apiVersion.d.ts) and that's the
 *  correct source of truth, not a hand-copied string that could drift from
 *  what the installed types actually describe. */
export function getStripeClient(): Stripe {
  if (!cachedStripe) {
    cachedStripe = new Stripe(readRequiredEnv("STRIPE_SECRET_KEY"));
  }
  return cachedStripe;
}

/** One flat MVP plan (CLAUDE.md §8 Phase 2 -- "basic," not tiered yet).
 *  500/month mirrors CLAUDE.md §0's target-customer lower bound, as a
 *  placeholder limit to display against, not a hard-enforced cap -- nothing
 *  in this pass blocks a sync or a write once a tenant is over it. */
export const MVP_PLAN_ORDER_LIMIT_PER_MONTH = 500;

export interface BillingSummary {
  hasStripeCustomer: boolean;
  subscriptionStatus: string | null;
  currentPeriodEnd: string | null;
  ordersThisMonth: number;
  orderLimit: number;
  skuCount: number;
}

/**
 * Looks up (or lazily creates) this tenant's Stripe Customer, per this
 * task's own framing ("on first visit to /settings/billing"). Idempotent:
 * safe to call on every page load once a customer exists, since the first
 * branch just returns the stored id.
 *
 * Created with no email: `users` has no tenant-scoped SELECT RLS policy
 * today (migration 0010 -- only self-lookup-by-clerk_user_id), so "the
 * tenant owner's email" isn't resolvable from inside a withTenant()
 * transaction without either widening that policy or reaching for the
 * schema-owning connection from a web-facing route -- neither of which is
 * warranted for this. Stripe's hosted Checkout collects an email itself
 * when the Customer doesn't already have one, which is the normal pattern
 * for integrations that don't know a customer's email upfront.
 */
export async function getOrCreateStripeCustomer(pool: Pool, tenantId: string): Promise<string> {
  return withTenant(pool, tenantId, async (client) => {
    const existing = await client.query<{ stripe_customer_id: string | null; name: string }>(
      `SELECT stripe_customer_id, name FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const row = existing.rows[0];
    if (!row) {
      throw new Error(`Tenant ${tenantId} not found`);
    }
    if (row.stripe_customer_id) {
      return row.stripe_customer_id;
    }

    const customer = await getStripeClient().customers.create({
      name: row.name,
      metadata: { tenantId },
    });

    await client.query(`UPDATE tenants SET stripe_customer_id = $1, updated_at = now() WHERE id = $2`, [
      customer.id,
      tenantId,
    ]);
    return customer.id;
  });
}

export interface CreateCheckoutSessionParams {
  tenantId: string;
  successUrl: string;
  cancelUrl: string;
}

/** Starts a subscription via Stripe's hosted Checkout -- no custom card
 *  form anywhere in this app (CLAUDE.md §6: raw card data never touches
 *  this app directly). `client_reference_id` is set alongside the
 *  `customer` link purely for traceability in the Stripe Dashboard; the
 *  webhook handler resolves the tenant via `customer`, not this field. */
export async function createCheckoutSession(pool: Pool, params: CreateCheckoutSessionParams): Promise<{ url: string }> {
  const customerId = await getOrCreateStripeCustomer(pool, params.tenantId);
  const priceId = readRequiredEnv("STRIPE_MVP_PRICE_ID");

  const session = await getStripeClient().checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    client_reference_id: params.tenantId,
  });

  if (!session.url) {
    throw new Error("Stripe did not return a Checkout Session URL");
  }
  return { url: session.url };
}

/** Opens Stripe's hosted Customer Portal for managing/canceling a
 *  subscription -- same "no custom UI for anything Stripe already hosts"
 *  reasoning as Checkout. Throws if this tenant has never started a
 *  checkout (no Stripe customer yet) rather than silently creating one --
 *  there's nothing to "manage" yet. */
export async function createPortalSession(pool: Pool, tenantId: string, returnUrl: string): Promise<{ url: string }> {
  const customerId = await withTenant(pool, tenantId, async (client) => {
    const result = await client.query<{ stripe_customer_id: string | null }>(
      `SELECT stripe_customer_id FROM tenants WHERE id = $1`,
      [tenantId],
    );
    return result.rows[0]?.stripe_customer_id ?? null;
  });

  if (!customerId) {
    throw new Error(`Tenant ${tenantId} has no Stripe customer yet -- visit billing settings and subscribe first`);
  }

  const session = await getStripeClient().billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  return { url: session.url };
}

/** Resolves a Stripe customer id back to a tenant id, via the
 *  stripe_customer_id-scoped RLS self-lookup (migration 0016,
 *  withStripeCustomer -- mirrors withClerkUser's exact reasoning: a
 *  webhook event only carries `customer`, not `tenant_id`, and tenant_id
 *  isn't known until this resolves). Returns null rather than throwing on
 *  a miss -- see handleStripeWebhookEvent's callers for how that's treated
 *  (logged, not fatal: retrying a genuine mismatch will never fix it). */
async function resolveTenantIdByStripeCustomerId(pool: Pool, stripeCustomerId: string): Promise<string | null> {
  return withStripeCustomer(pool, stripeCustomerId, async (client) => {
    const result = await client.query<{ id: string }>(`SELECT id FROM tenants WHERE stripe_customer_id = $1`, [
      stripeCustomerId,
    ]);
    return result.rows[0]?.id ?? null;
  });
}

function toStripeCustomerId(customer: string | Stripe.Customer | Stripe.DeletedCustomer | null): string | null {
  if (!customer) return null;
  return typeof customer === "string" ? customer : customer.id;
}

/** Persists a Subscription object's current state onto its tenant --
 *  the single write path every subscription-bearing webhook event (created/
 *  updated/deleted, and the re-fetch from invoice.payment_failed) funnels
 *  through, so there's exactly one place that decides what "this
 *  subscription's state" means in this schema. `current_period_end` moved
 *  off the top-level Subscription object in the API version this SDK
 *  targets (confirmed against the installed types, not assumed from
 *  memory) -- it now lives per subscription item; this MVP plan has
 *  exactly one item, so item[0] is authoritative.
 */
async function persistSubscriptionState(pool: Pool, subscription: Stripe.Subscription): Promise<void> {
  const customerId = toStripeCustomerId(subscription.customer);
  if (!customerId) return;

  const tenantId = await resolveTenantIdByStripeCustomerId(pool, customerId);
  if (!tenantId) {
    console.error(
      `Stripe subscription ${subscription.id} event for customer ${customerId}: no matching tenant -- ignoring`,
    );
    return;
  }

  const periodEndSeconds = subscription.items.data[0]?.current_period_end;
  const currentPeriodEnd = periodEndSeconds ? new Date(periodEndSeconds * 1000).toISOString() : null;

  await withTenant(pool, tenantId, (client) =>
    client.query(
      `UPDATE tenants
          SET stripe_subscription_id = $1, subscription_status = $2, subscription_current_period_end = $3, updated_at = now()
        WHERE id = $4`,
      [subscription.id, subscription.status, currentPeriodEnd, tenantId],
    ),
  );
}

async function handleCheckoutSessionCompleted(pool: Pool, session: Stripe.Checkout.Session): Promise<void> {
  const customerId = toStripeCustomerId(session.customer);
  const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
  if (!customerId || !subscriptionId) {
    console.warn(`Stripe checkout.session.completed ${session.id} is missing customer/subscription -- ignoring`);
    return;
  }

  const tenantId = await resolveTenantIdByStripeCustomerId(pool, customerId);
  if (!tenantId) {
    console.error(`Stripe checkout.session.completed for customer ${customerId}: no matching tenant -- ignoring`);
    return;
  }

  // Just the id here -- the subscription's actual status/period-end arrive
  // moments later via customer.subscription.created/updated, which
  // persistSubscriptionState() handles with the full Subscription object.
  await withTenant(pool, tenantId, (client) =>
    client.query(`UPDATE tenants SET stripe_subscription_id = $1, updated_at = now() WHERE id = $2`, [
      subscriptionId,
      tenantId,
    ]),
  );
}

async function handleInvoicePaymentFailed(pool: Pool, invoice: Stripe.Invoice): Promise<void> {
  const subscriptionRef = invoice.parent?.subscription_details?.subscription;
  const subscriptionId = typeof subscriptionRef === "string" ? subscriptionRef : subscriptionRef?.id;
  if (!subscriptionId) {
    // A one-off invoice not tied to any subscription -- nothing for this
    // integration to update.
    return;
  }
  // Re-fetches rather than trusting the invoice event to carry the
  // subscription's own current status -- invoice.payment_failed is about
  // the invoice, not a snapshot of subscription state, and Stripe's own
  // dunning/retry behavior means the true current status is only reliable
  // straight from the Subscription resource itself.
  const subscription = await getStripeClient().subscriptions.retrieve(subscriptionId);
  await persistSubscriptionState(pool, subscription);
}

/**
 * Dispatches one verified Stripe event (see the webhook route for
 * signature verification -- this function never sees an unverified
 * payload). Handles the four event types this task calls out as the
 * minimum, plus customer.subscription.created alongside .updated (same
 * object shape, same handler -- a subscription created directly via the
 * API, as opposed to through Checkout, fires .created without necessarily
 * also firing .updated). Every other event type is ignored: a Dashboard
 * webhook endpoint commonly subscribes to "all events," so receiving
 * something this integration doesn't act on is expected, not an error.
 */
export async function handleStripeWebhookEvent(pool: Pool, event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed":
      await handleCheckoutSessionCompleted(pool, event.data.object);
      return;
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await persistSubscriptionState(pool, event.data.object);
      return;
    case "invoice.payment_failed":
      await handleInvoicePaymentFailed(pool, event.data.object);
      return;
    default:
      return;
  }
}

/** Reads/verifies a raw webhook payload into a typed Stripe.Event -- thin
 *  wrapper so the Route Handler doesn't need to import the Stripe SDK
 *  directly just to call one static method. Throws on a bad signature;
 *  the caller (the webhook route) turns that into a 400. */
export function constructStripeWebhookEvent(rawBody: string, signatureHeader: string): Stripe.Event {
  const webhookSecret = readRequiredEnv("STRIPE_WEBHOOK_SECRET");
  return getStripeClient().webhooks.constructEvent(rawBody, signatureHeader, webhookSecret);
}

/** Everything /settings/billing needs to render: subscription state (from
 *  the tenants columns webhooks keep current) plus usage against the flat
 *  plan limit. skuCount is a live COUNT(*), not a stored counter -- see
 *  migration 0016_billing.sql for why. */
export async function getBillingSummary(pool: Pool, tenantId: string): Promise<BillingSummary> {
  return withTenant(pool, tenantId, async (client) => {
    const tenantResult = await client.query<{
      stripe_customer_id: string | null;
      subscription_status: string | null;
      subscription_current_period_end: string | null;
    }>(
      `SELECT stripe_customer_id, subscription_status, subscription_current_period_end FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const tenant = tenantResult.rows[0];

    const month = new Date().toISOString().slice(0, 7);
    const usageResult = await client.query<{ orders_processed: number }>(
      `SELECT orders_processed FROM tenant_usage WHERE tenant_id = $1 AND month = $2`,
      [tenantId, month],
    );

    const skuResult = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM products`);

    return {
      hasStripeCustomer: Boolean(tenant?.stripe_customer_id),
      subscriptionStatus: tenant?.subscription_status ?? null,
      currentPeriodEnd: tenant?.subscription_current_period_end ?? null,
      ordersThisMonth: usageResult.rows[0]?.orders_processed ?? 0,
      orderLimit: MVP_PLAN_ORDER_LIMIT_PER_MONTH,
      skuCount: Number(skuResult.rows[0]?.count ?? 0),
    };
  });
}
