import "dotenv/config";
import { ShopifyConnector } from "../packages/channel-connectors/src/shopify-connector.js";

// Proves the Shopify Admin API connector works end to end against a real
// Shopify development store (CLAUDE.md §4, §8 Phase 3 -- Shopify is channel
// #3). Unlike the Amazon/Walmart smoke tests, there is no vendor-hosted
// sandbox to point at: a dev store *is* real Shopify infrastructure (just
// unable to take real payments), so this talks to whatever store
// SHOPIFY_SANDBOX_SHOP_DOMAIN/SHOPIFY_SANDBOX_ACCESS_TOKEN name. Never logs
// the access token -- only order/inventory/fulfillment results, none of
// which are sensitive.
//
// Exercises, in order:
//   1. authenticate() -- trivial for a custom app, but proves the connector
//      constructs from env vars without throwing.
//   2. pullOrders() -- real GraphQL orders query, cursor pagination included
//      if the store has more than one page of orders in range.
//   3. pushInventory() -- only if SHOPIFY_SANDBOX_TEST_SKU is set (opt-in:
//      unlike Amazon's sandbox, a dev store's inventory write is real and
//      persists, so this shouldn't run against a SKU the operator didn't
//      choose deliberately).
//   4. confirmShipment() -- only if SHOPIFY_SANDBOX_TEST_ORDER_ID is set
//      (opt-in for the same reason: this creates a real fulfillment against
//      a real order, so it needs an order the operator picked on purpose --
//      e.g. a throwaway test order placed in the dev store's checkout).
//   5. createListing() -- only if SHOPIFY_SANDBOX_TEST_CREATE_LISTING_SKU is
//      set (opt-in: this creates a brand-new, real product on the dev store
//      every run -- there's no dedupe/upsert, see createListing()'s own doc
//      comment -- so it needs a SKU the operator chose on purpose, not one
//      that runs on every smoke-test invocation).
//
// Run with: npm run shopify:sandbox-smoke-test

function daysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

async function main(): Promise<void> {
  const connector = new ShopifyConnector();

  await connector.authenticate();
  console.log("Shopify authenticate() succeeded (custom-app access token present, not shown).");

  const since = daysAgo(30);
  console.log(`\nPulling orders created since ${since.toISOString()}...`);
  const orders = await connector.pullOrders(since);

  console.log(`Received ${orders.length} normalized order(s).`);
  for (const order of orders) {
    console.log(
      `  - ${order.externalOrderId} status=${order.channelStatus} ` +
        `placedAt=${order.placedAt} customer=${JSON.stringify(order.customer)}`,
    );
    for (const line of order.lines) {
      console.log(
        `      line ${line.externalLineId}: sku=${line.externalSku} qty=${line.quantity} ` +
          `unitPrice=${line.unitPrice} fulfillmentType=${line.fulfillmentType}`,
      );
    }
  }
  if (orders.length === 0) {
    console.log(
      "  (zero orders is not necessarily a failure -- a fresh dev store has no orders until " +
        "one is placed through its checkout; this still proves the query round-tripped cleanly.)",
    );
  }

  console.log("\nPulling the store's product catalog (pullProductCatalog)...");
  const variants = await connector.pullProductCatalog();
  console.log(`Received ${variants.length} SKU'd variant(s).`);
  for (const variant of variants) {
    console.log(
      `  - sku=${variant.externalSku} title="${variant.title}" totalAvailable=${variant.totalAvailable} ` +
        `inventoryItemId=${variant.inventoryItemId}`,
    );
  }
  if (variants.length === 0) {
    console.log(
      "  (zero variants either means a fresh store with no products yet, or every variant is missing a SKU " +
        "-- check the warning above for a skipped-count if so.)",
    );
  }

  const testSku = process.env.SHOPIFY_SANDBOX_TEST_SKU;
  if (testSku) {
    console.log(`\nSHOPIFY_SANDBOX_TEST_SKU set -- pushing inventory for sku '${testSku}'...`);
    const result = await connector.pushInventory(testSku, 25);
    console.log("pushInventory result:");
    console.log(`  success: ${result.success}`);
    if (result.externalId) console.log(`  externalId (InventoryItem gid): ${result.externalId}`);
    if (result.error) console.log(`  error: ${result.error}`);
    if (!result.success) {
      throw new Error("pushInventory did not succeed -- see result above.");
    }
  } else {
    console.log("\nSHOPIFY_SANDBOX_TEST_SKU not set -- skipping pushInventory (opt-in, see this file's header comment).");
  }

  const testOrderId = process.env.SHOPIFY_SANDBOX_TEST_ORDER_ID;
  if (testOrderId) {
    console.log(`\nSHOPIFY_SANDBOX_TEST_ORDER_ID set -- confirming shipment for order '${testOrderId}'...`);
    await connector.confirmShipment(testOrderId, {
      carrier: process.env.SHOPIFY_SANDBOX_TEST_CARRIER ?? "Test Carrier",
      trackingNumber: process.env.SHOPIFY_SANDBOX_TEST_TRACKING_NUMBER ?? `SMOKE-TEST-${Date.now()}`,
    });
    console.log("confirmShipment completed without throwing.");
  } else {
    console.log(
      "SHOPIFY_SANDBOX_TEST_ORDER_ID not set -- skipping confirmShipment (opt-in, needs a real order id " +
        "from the dev store, see this file's header comment).",
    );
  }

  const createListingSku = process.env.SHOPIFY_SANDBOX_TEST_CREATE_LISTING_SKU;
  if (createListingSku) {
    console.log(`\nSHOPIFY_SANDBOX_TEST_CREATE_LISTING_SKU set -- creating a new listing for sku '${createListingSku}'...`);
    const result = await connector.createListing({
      internalSku: createListingSku,
      title: `Smoke test listing (${createListingSku})`,
      price: "9.99",
    });
    console.log("createListing result:");
    console.log(`  success: ${result.success}`);
    if (result.productGid) console.log(`  productGid: ${result.productGid}`);
    if (result.inventoryItemGid) console.log(`  inventoryItemGid: ${result.inventoryItemGid}`);
    if (result.error) console.log(`  error: ${result.error}`);
    if (!result.success) {
      throw new Error("createListing did not succeed -- see result above.");
    }
    console.log(
      "  (created as a draft product, not published to any sales channel -- see createListing()'s own doc " +
        "comment; publish it manually from the dev store's admin if you want to see it live.)",
    );
  } else {
    console.log(
      "\nSHOPIFY_SANDBOX_TEST_CREATE_LISTING_SKU not set -- skipping createListing (opt-in, see this file's " +
        "header comment).",
    );
  }

  const webhookCallbackUrl = process.env.SHOPIFY_SANDBOX_TEST_WEBHOOK_CALLBACK_URL;
  if (webhookCallbackUrl) {
    console.log(`\nSHOPIFY_SANDBOX_TEST_WEBHOOK_CALLBACK_URL set -- registering webhooks against '${webhookCallbackUrl}'...`);
    const results = await connector.registerWebhooks(webhookCallbackUrl);
    for (const result of results) {
      console.log(
        `  - ${result.topic}: ${result.success ? `registered (id ${result.webhookSubscriptionId})` : `FAILED (${result.error})`}`,
      );
    }
    if (results.some((r) => !r.success)) {
      throw new Error("registerWebhooks did not fully succeed -- see results above.");
    }
  } else {
    console.log(
      "\nSHOPIFY_SANDBOX_TEST_WEBHOOK_CALLBACK_URL not set -- skipping registerWebhooks (opt-in: this creates real, " +
        "persistent webhook subscriptions on the dev store, so it needs a callback URL the operator picked on " +
        "purpose -- e.g. an ngrok/Vercel preview URL that can actually receive a delivery).",
    );
  }

  console.log("\nSmoke test PASSED: talked to real Shopify Admin API infrastructure.");
}

main().catch((error: unknown) => {
  console.error("Smoke test FAILED:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
