import "dotenv/config";
import { EbayConnector, loadEbaySandboxCredentialsFromEnv, type EbayCredentials } from "../packages/channel-connectors/src/ebay-connector.js";

// Proves the eBay Sell API connector works end to end against real eBay
// infrastructure -- the eBay counterpart to amazon-sandbox-smoke-test.ts,
// shopify-sandbox-smoke-test.ts, and walmart-sandbox-smoke-test.ts
// (CLAUDE.md §4.6, §8 Phase 5 -- eBay is channel #4, built ahead of the rest
// of that phase). NOT RUNNABLE from this repo's own Claude Code cloud
// sandbox: that environment's outbound network policy blocks BOTH
// api.ebay.com and api.sandbox.ebay.com entirely (confirmed directly during
// the connector's original build -- CLAUDE.md §4.6's own "UNVERIFIED IN ITS
// ENTIRETY" paragraph), so this script exists to be run from a normal
// machine (a developer's own laptop, or once deployed) with real
// EBAY_SANDBOX_* credentials in `.env` -- see .env.example's own comment for
// how to obtain them (join the eBay Developers Program, create an
// application keyset, then use its "Get a Token from eBay via Your
// Application" tool for a one-time-consent refresh token, granting the
// sell.fulfillment/sell.inventory/sell.account.readonly scopes
// EBAY_OAUTH_SCOPES requests). Never logs the client secret, refresh token,
// or access token.
//
// Exercises, in order:
//   1. authenticate() -- real refresh_token grant token exchange
//      (POST /identity/v1/oauth2/token).
//   2. pullOrders() -- real GET /sell/fulfillment/v1/order (first page
//      only -- see EbayConnector's own doc comment on pagination).
//   3. fetchBusinessPolicies() -- real GET x3 against the Account API,
//      always run (read-only, no persisting side effect) -- lists whatever
//      fulfillment/payment/return policies already exist on this sandbox
//      seller account, or reports none configured yet.
//   4. pushInventory() -- only if EBAY_SANDBOX_TEST_SKU is set (opt-in:
//      a real, persisting single-SKU inventory-item write, same reasoning
//      Walmart's/Shopify's own opt-in test SKU vars document).
//   5. confirmShipment() -- only if EBAY_SANDBOX_TEST_ORDER_ID is set
//      (opt-in: acknowledges/ships a real order, needs an id the operator
//      picked on purpose).
//   6. createMerchantLocation() -- only if EBAY_SANDBOX_TEST_MERCHANT_LOCATION_KEY
//      and its address fields are all set (opt-in: a real, persisting
//      location write).
//   7. createListing() -- only if EBAY_SANDBOX_TEST_LISTING_SKU and its
//      fields are all set (opt-in: creates a real sandbox listing --
//      requires this sandbox seller account to already have all three
//      business policy ids and a merchant location key, supplied via
//      EBAY_SANDBOX_TEST_{FULFILLMENT,PAYMENT,RETURN}_POLICY_ID and
//      EBAY_SANDBOX_TEST_MERCHANT_LOCATION_KEY -- createListing() itself
//      fails fast with a clear error if any of the four is missing, same as
//      it does for a real tenant with an incomplete Selling Setup).
//
// Run with: npm run ebay:sandbox-smoke-test

function daysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

async function main(): Promise<void> {
  // loadEbaySandboxCredentialsFromEnv() only reads the three core
  // authentication fields (EbayCredentials' own doc comment explains why
  // the other four are separate/optional) -- merged in here, from their own
  // env vars, rather than widening that function for a test-script-only
  // concern. Present only when the operator has actually configured a
  // Selling Setup in their sandbox seller account; absent otherwise, which
  // is the normal, expected state for a freshly-created sandbox account.
  const credentials: EbayCredentials = {
    ...loadEbaySandboxCredentialsFromEnv(),
    fulfillmentPolicyId: process.env.EBAY_SANDBOX_TEST_FULFILLMENT_POLICY_ID,
    paymentPolicyId: process.env.EBAY_SANDBOX_TEST_PAYMENT_POLICY_ID,
    returnPolicyId: process.env.EBAY_SANDBOX_TEST_RETURN_POLICY_ID,
    merchantLocationKey: process.env.EBAY_SANDBOX_TEST_MERCHANT_LOCATION_KEY,
  };
  const connector = new EbayConnector(credentials);

  await connector.authenticate();
  console.log("eBay authenticate() succeeded (refresh-token exchange, access token acquired, not shown).");

  const since = daysAgo(30);
  console.log(`\nPulling orders created since ${since.toISOString()} (first page only)...`);
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
      "  (zero orders is not necessarily a failure -- a fresh sandbox seller account has no orders until " +
        "a Sandbox test buyer user places one; this still proves the GET /sell/fulfillment/v1/order call " +
        "round-tripped cleanly.)",
    );
  }

  console.log("\nFetching business policies (read-only, sell.account.readonly scope)...");
  const policies = await connector.fetchBusinessPolicies();
  console.log(`  fulfillment policies: ${policies.fulfillmentPolicies.length}`);
  for (const p of policies.fulfillmentPolicies) console.log(`    - ${p.id}: ${p.name}`);
  console.log(`  payment policies: ${policies.paymentPolicies.length}`);
  for (const p of policies.paymentPolicies) console.log(`    - ${p.id}: ${p.name}`);
  console.log(`  return policies: ${policies.returnPolicies.length}`);
  for (const p of policies.returnPolicies) console.log(`    - ${p.id}: ${p.name}`);
  if (
    policies.fulfillmentPolicies.length === 0 &&
    policies.paymentPolicies.length === 0 &&
    policies.returnPolicies.length === 0
  ) {
    console.log(
      "  (no business policies exist yet on this sandbox seller account -- create at least one of each in " +
        "Seller Hub before opting into the createListing() step below, or it will fail fast for missing " +
        "credential fields, same as it would for a real tenant with an incomplete Selling Setup.)",
    );
  }

  const testSku = process.env.EBAY_SANDBOX_TEST_SKU;
  if (testSku) {
    console.log(`\nEBAY_SANDBOX_TEST_SKU set -- pushing inventory for sku '${testSku}'...`);
    const result = await connector.pushInventory(testSku, 25);
    console.log("pushInventory result:");
    console.log(`  success: ${result.success}`);
    if (result.externalId) console.log(`  externalId (sku echoed back): ${result.externalId}`);
    if (result.error) console.log(`  error: ${result.error}`);
    if (!result.success) {
      throw new Error("pushInventory did not succeed -- see result above.");
    }
  } else {
    console.log("\nEBAY_SANDBOX_TEST_SKU not set -- skipping pushInventory (opt-in, see this file's header comment).");
  }

  const testOrderId = process.env.EBAY_SANDBOX_TEST_ORDER_ID;
  if (testOrderId) {
    console.log(`\nEBAY_SANDBOX_TEST_ORDER_ID set -- confirming shipment for order '${testOrderId}'...`);
    await connector.confirmShipment(testOrderId, {
      carrier: process.env.EBAY_SANDBOX_TEST_CARRIER ?? "Other",
      trackingNumber: process.env.EBAY_SANDBOX_TEST_TRACKING_NUMBER ?? `SMOKE-TEST-${Date.now()}`,
      shippedAt: new Date().toISOString(),
    });
    console.log("confirmShipment completed without throwing.");
  } else {
    console.log(
      "EBAY_SANDBOX_TEST_ORDER_ID not set -- skipping confirmShipment (opt-in, needs a real order id, " +
        "see this file's header comment).",
    );
  }

  const locationKey = process.env.EBAY_SANDBOX_TEST_MERCHANT_LOCATION_KEY;
  const locationName = process.env.EBAY_SANDBOX_TEST_LOCATION_NAME;
  const locationAddressLine1 = process.env.EBAY_SANDBOX_TEST_LOCATION_ADDRESS_LINE1;
  const locationCity = process.env.EBAY_SANDBOX_TEST_LOCATION_CITY;
  const locationState = process.env.EBAY_SANDBOX_TEST_LOCATION_STATE;
  const locationPostalCode = process.env.EBAY_SANDBOX_TEST_LOCATION_POSTAL_CODE;
  const locationCountry = process.env.EBAY_SANDBOX_TEST_LOCATION_COUNTRY;
  if (locationKey) {
    if (!locationName || !locationAddressLine1 || !locationCity || !locationState || !locationPostalCode || !locationCountry) {
      throw new Error(
        "EBAY_SANDBOX_TEST_MERCHANT_LOCATION_KEY is set but one of EBAY_SANDBOX_TEST_LOCATION_" +
          "{NAME,ADDRESS_LINE1,CITY,STATE,POSTAL_CODE,COUNTRY} is missing -- set all of them together, " +
          "or none, to opt into createMerchantLocation().",
      );
    }
    console.log(`\nEBAY_SANDBOX_TEST_MERCHANT_LOCATION_KEY set -- creating merchant location '${locationKey}'...`);
    const result = await connector.createMerchantLocation(locationKey, {
      name: locationName,
      addressLine1: locationAddressLine1,
      city: locationCity,
      stateOrProvince: locationState,
      postalCode: locationPostalCode,
      country: locationCountry,
    });
    console.log("createMerchantLocation result:");
    console.log(`  success: ${result.success}`);
    if (result.error) console.log(`  error: ${result.error}`);
    // eBay's createInventoryLocation is a real POST, not idempotent the way
    // createOrReplaceInventoryItem's PUT is -- re-running this smoke test
    // with the SAME merchantLocationKey (the normal case: you only need to
    // create a location once, then reuse it for every later run's own
    // createListing() call) fails with 25803 "merchantLocationKey already
    // exists" even though the location is still there and perfectly usable.
    // Treat that one specific error as benign -- the location this run
    // needed already exists, which is success for this script's purposes --
    // rather than crash-stopping before ever reaching createListing() below.
    // Any OTHER failure (bad address fields, auth, etc.) still throws.
    const locationAlreadyExists = !result.success && result.error?.includes("25803");
    if (locationAlreadyExists) {
      console.log("  (merchantLocationKey already exists -- treating as already set up, continuing.)");
    } else if (!result.success) {
      throw new Error("createMerchantLocation did not succeed -- see result above.");
    }
  } else {
    console.log(
      "\nEBAY_SANDBOX_TEST_MERCHANT_LOCATION_KEY not set -- skipping createMerchantLocation (opt-in, see " +
        "this file's header comment).",
    );
  }

  const listingSku = process.env.EBAY_SANDBOX_TEST_LISTING_SKU;
  if (listingSku) {
    const title = process.env.EBAY_SANDBOX_TEST_LISTING_TITLE;
    const description = process.env.EBAY_SANDBOX_TEST_LISTING_DESCRIPTION;
    const imageUrl = process.env.EBAY_SANDBOX_TEST_LISTING_IMAGE_URL;
    const categoryId = process.env.EBAY_SANDBOX_TEST_LISTING_CATEGORY_ID;
    const price = process.env.EBAY_SANDBOX_TEST_LISTING_PRICE;
    if (!title || !description || !imageUrl || !categoryId || !price) {
      throw new Error(
        "EBAY_SANDBOX_TEST_LISTING_SKU is set but one of EBAY_SANDBOX_TEST_LISTING_" +
          "{TITLE,DESCRIPTION,IMAGE_URL,CATEGORY_ID,PRICE} is missing -- set all of them together, or none, " +
          "to opt into createListing().",
      );
    }
    console.log(`\nEBAY_SANDBOX_TEST_LISTING_SKU set -- creating listing for sku '${listingSku}'...`);
    const result = await connector.createListing({ sellerSku: listingSku, title, description, imageUrl, categoryId, price, quantity: 10 });
    console.log("createListing result:");
    console.log(`  success: ${result.success}`);
    if (result.listingId) console.log(`  listingId: ${result.listingId}`);
    if (result.error) console.log(`  error: ${result.error}`);
    if (!result.success) {
      throw new Error("createListing did not succeed -- see result above.");
    }
  } else {
    console.log(
      "EBAY_SANDBOX_TEST_LISTING_SKU not set -- skipping createListing (opt-in, needs a complete Selling " +
        "Setup, see this file's header comment).",
    );
  }

  console.log("\nSmoke test PASSED: talked to real eBay Sell API infrastructure.");
}

main().catch((error: unknown) => {
  console.error("Smoke test FAILED:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
