import "dotenv/config";
import { getStripeClient } from "../packages/billing-service/src/index.js";

// One-time (idempotent) setup for the single flat MVP plan (CLAUDE.md §8
// Phase 2: one tier, not a pricing matrix yet). Creates a test-mode Stripe
// Product + recurring Price and prints the Price id to save as
// STRIPE_MVP_PRICE_ID in .env -- doesn't write .env itself, matching every
// other script in this repo that prints a value for Arif to copy in
// (e.g. amazon-production-smoke-test.ts's own STRIPE_MVP_PRICE_ID sibling,
// scripts/seed-test-channel-connection.ts) rather than editing it directly.
//
// Safe to re-run: if STRIPE_MVP_PRICE_ID is already set, this just verifies
// that price still exists in test mode and exits -- it never creates a
// second Product/Price.
//
// Run with: npm run stripe:setup-mvp-plan

const MVP_PLAN_NAME = "alltix-oms MVP Plan";
const MVP_PLAN_AMOUNT_USD_CENTS = 4900; // $49/month -- an arbitrary, easily-changed placeholder; no real pricing decision has been made yet.

async function main(): Promise<void> {
  const stripe = getStripeClient();

  const existingPriceId = process.env.STRIPE_MVP_PRICE_ID;
  if (existingPriceId) {
    const price = await stripe.prices.retrieve(existingPriceId);
    console.log(`STRIPE_MVP_PRICE_ID is already set and resolves to a real test-mode price: ${price.id}`);
    console.log(`  product: ${typeof price.product === "string" ? price.product : price.product.id}`);
    console.log(`  amount: ${price.unit_amount} ${price.currency} / ${price.recurring?.interval}`);
    return;
  }

  const product = await stripe.products.create({
    name: MVP_PLAN_NAME,
    metadata: { app: "alltix-oms", plan: "mvp" },
  });

  const price = await stripe.prices.create({
    product: product.id,
    currency: "usd",
    unit_amount: MVP_PLAN_AMOUNT_USD_CENTS,
    recurring: { interval: "month" },
  });

  console.log("Created a new test-mode Product + Price:");
  console.log(`  product: ${product.id} (${product.name})`);
  console.log(`  price: ${price.id} ($${MVP_PLAN_AMOUNT_USD_CENTS / 100}/month)`);
  console.log("\nSave this in .env:");
  console.log(`STRIPE_MVP_PRICE_ID=${price.id}`);
}

main().catch((err: unknown) => {
  console.error("Stripe MVP plan setup FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
