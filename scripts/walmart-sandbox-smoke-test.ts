import "dotenv/config";
import { WalmartConnector } from "../packages/channel-connectors/src/walmart-connector.js";

// Proves the Walmart Marketplace API connector works end to end against
// real Walmart infrastructure -- the Walmart counterpart to
// amazon-sandbox-smoke-test.ts and shopify-sandbox-smoke-test.ts (CLAUDE.md
// §4.2, §8 Phase 3 -- Walmart is one of the three MVP channels, CLAUDE.md
// §0). NOT RUNNABLE as written today: there is no self-serve Walmart
// sandbox to register for the way Amazon's SP-API sandbox is, so
// WALMART_SANDBOX_CLIENT_ID/WALMART_SANDBOX_CLIENT_SECRET stay unset until
// this project (or a real tenant) has an approved Walmart seller/Solution
// Provider account -- see WalmartConnector's own class doc comment ("no
// Walmart sandbox credentials exist yet"). This script exists so that day
// one is "run `npm run walmart:sandbox-smoke-test`," not "write a smoke
// test from scratch." Never logs the client secret or access token.
//
// Exercises, in order:
//   1. authenticate() -- real client_credentials token exchange
//      (POST /v3/token).
//   2. pullOrders() -- real GET /v3/orders, once per ship-node type
//      (SellerFulfilled/WFSFulfilled/3PLFulfilled), merged.
//   3. pushInventory() -- only if WALMART_SANDBOX_TEST_SKU is set (opt-in:
//      this is a real, persisting single-SKU inventory write, so it
//      shouldn't run against a SKU the operator didn't choose deliberately
//      -- same reasoning as Shopify's SHOPIFY_SANDBOX_TEST_SKU).
//   4. confirmShipment() -- only if WALMART_SANDBOX_TEST_ORDER_ID is set
//      (opt-in for the same reason: this acknowledges and ships a real
//      order, so it needs an order id the operator picked on purpose).
//
// Run with: npm run walmart:sandbox-smoke-test

function daysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

async function main(): Promise<void> {
  const connector = new WalmartConnector();

  await connector.authenticate();
  console.log("Walmart authenticate() succeeded (access token acquired, not shown).");

  const since = daysAgo(30);
  console.log(`\nPulling orders created since ${since.toISOString()} (all three ship-node types)...`);
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
      "  (zero orders is not necessarily a failure -- a fresh/unused seller account has no orders until " +
        "one is placed; this still proves all three GET /v3/orders calls round-tripped cleanly.)",
    );
  }

  const testSku = process.env.WALMART_SANDBOX_TEST_SKU;
  if (testSku) {
    console.log(`\nWALMART_SANDBOX_TEST_SKU set -- pushing inventory for sku '${testSku}'...`);
    const result = await connector.pushInventory(testSku, 25);
    console.log("pushInventory result:");
    console.log(`  success: ${result.success}`);
    if (result.externalId) console.log(`  externalId (sku echoed back): ${result.externalId}`);
    if (result.error) console.log(`  error: ${result.error}`);
    if (!result.success) {
      throw new Error("pushInventory did not succeed -- see result above.");
    }
  } else {
    console.log("\nWALMART_SANDBOX_TEST_SKU not set -- skipping pushInventory (opt-in, see this file's header comment).");
  }

  const testOrderId = process.env.WALMART_SANDBOX_TEST_ORDER_ID;
  if (testOrderId) {
    console.log(`\nWALMART_SANDBOX_TEST_ORDER_ID set -- confirming shipment for order '${testOrderId}'...`);
    await connector.confirmShipment(testOrderId, {
      carrier: process.env.WALMART_SANDBOX_TEST_CARRIER ?? "Test Carrier",
      trackingNumber: process.env.WALMART_SANDBOX_TEST_TRACKING_NUMBER ?? `SMOKE-TEST-${Date.now()}`,
      shippedAt: new Date().toISOString(),
    });
    console.log("confirmShipment (acknowledge + shipping) completed without throwing.");
  } else {
    console.log(
      "WALMART_SANDBOX_TEST_ORDER_ID not set -- skipping confirmShipment (opt-in, needs a real order id, " +
        "see this file's header comment).",
    );
  }

  console.log("\nSmoke test PASSED: talked to real Walmart Marketplace API infrastructure.");
}

main().catch((error: unknown) => {
  console.error("Smoke test FAILED:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
