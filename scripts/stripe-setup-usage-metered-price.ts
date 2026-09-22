import "dotenv/config";
import { getStripeClient, MVP_PLAN_ORDER_LIMIT_PER_MONTH, ORDERS_PROCESSED_METER_EVENT_NAME } from "../packages/billing-service/src/index.js";

// One-time (idempotent) setup for real usage-based billing's metered
// dimension: a Stripe Billing Meter (ORDERS_PROCESSED_METER_EVENT_NAME,
// counting UsageReporter's meter events -- see
// packages/billing-service/src/index.ts) plus a graduated-tiered, metered
// recurring Price attached to it. Mirrors stripe-setup-mvp-plan.ts's own
// conventions exactly: prints ids to save into .env rather than writing it
// directly, and is safe to re-run (verifies the existing resources instead
// of creating duplicates once STRIPE_METERED_ORDERS_PRICE_ID is set).
//
// Pricing shape: the first MVP_PLAN_ORDER_LIMIT_PER_MONTH orders each
// billing period are included free (tier 1: flat_amount 0, up_to the
// limit), then every order beyond that is charged per unit (tier 2:
// unit_amount, up_to 'inf') -- 'graduated' tiers_mode means each tier's
// rate applies only to the usage that falls inside it, not the whole
// month's usage retroactively. This gives MVP_PLAN_ORDER_LIMIT_PER_MONTH a
// second, now load-bearing meaning: it's still the number
// getBillingSummary()/the billing page displays a tenant's usage against,
// and now it's also the literal free-tier boundary Stripe bills against --
// the two can never silently drift apart because both read the same
// constant.
//
// Run with: npm run stripe:setup-usage-metered-price
// (requires STRIPE_SECRET_KEY already set -- see .env.example's Billing
// section; TEST-MODE KEYS ONLY, same as every other Stripe setup script)

const METER_DISPLAY_NAME = "alltix-oms orders processed";
const METERED_PRICE_PRODUCT_NAME = "alltix-oms metered order overage";
// An arbitrary, easily-changed placeholder -- no real overage pricing
// decision has been made yet, same "not a real number, just needs to
// exist" framing MVP_PLAN_AMOUNT_USD_CENTS already uses in
// stripe-setup-mvp-plan.ts.
const METERED_OVERAGE_UNIT_AMOUNT_USD_CENTS = 5; // $0.05 per order beyond the free monthly limit

async function main(): Promise<void> {
  const stripe = getStripeClient();

  const existingPriceId = process.env.STRIPE_METERED_ORDERS_PRICE_ID;
  if (existingPriceId) {
    const price = await stripe.prices.retrieve(existingPriceId, { expand: ["tiers"] });
    const meterId = price.recurring?.meter;
    console.log(`STRIPE_METERED_ORDERS_PRICE_ID is already set and resolves to a real test-mode price: ${price.id}`);
    console.log(`  product: ${typeof price.product === "string" ? price.product : price.product.id}`);
    console.log(`  usage_type: ${price.recurring?.usage_type}, tiers_mode: ${price.tiers_mode}, meter: ${meterId}`);
    if (meterId) {
      const meter = await stripe.billing.meters.retrieve(meterId);
      console.log(`  meter event_name: ${meter.event_name} (status: ${meter.status})`);
    }
    return;
  }

  const meter = await stripe.billing.meters.create({
    display_name: METER_DISPLAY_NAME,
    event_name: ORDERS_PROCESSED_METER_EVENT_NAME,
    default_aggregation: { formula: "sum" },
    // Left at defaults for customer_mapping (by_id / stripe_customer_id) and
    // value_settings (value) -- buildOrderUsageMeterEventParams() in
    // billing-service is written against exactly those defaults, and
    // overriding either here would silently desync the two.
  });
  console.log(`Created a new test-mode Billing Meter: ${meter.id} (event_name: ${meter.event_name})`);

  const product = await stripe.products.create({
    name: METERED_PRICE_PRODUCT_NAME,
    metadata: { app: "alltix-oms", plan: "metered-order-overage" },
  });

  const price = await stripe.prices.create({
    product: product.id,
    currency: "usd",
    billing_scheme: "tiered",
    tiers_mode: "graduated",
    tiers: [
      { up_to: MVP_PLAN_ORDER_LIMIT_PER_MONTH, flat_amount: 0, unit_amount: 0 },
      { up_to: "inf", unit_amount: METERED_OVERAGE_UNIT_AMOUNT_USD_CENTS },
    ],
    recurring: {
      interval: "month",
      usage_type: "metered",
      meter: meter.id,
    },
  });

  console.log("Created a new test-mode metered Product + Price:");
  console.log(`  product: ${product.id} (${product.name})`);
  console.log(
    `  price: ${price.id} (first ${MVP_PLAN_ORDER_LIMIT_PER_MONTH} orders/month free, then $${METERED_OVERAGE_UNIT_AMOUNT_USD_CENTS / 100}/order)`,
  );
  console.log("\nSave this in .env:");
  console.log(`STRIPE_METERED_ORDERS_PRICE_ID=${price.id}`);
}

main().catch((err: unknown) => {
  console.error("Stripe usage-metered price setup FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
