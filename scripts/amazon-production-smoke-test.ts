import "dotenv/config";
import {
  AmazonConnector,
  loadAmazonProductionCredentialsFromEnv,
  SP_API_NA_PRODUCTION_BASE_URL,
} from "../packages/channel-connectors/src/amazon-connector.js";

// Read-only proof that the Amazon SP-API *production* credential chain
// works against Arif's own real Seller Central account: LWA refresh-token
// exchange (authenticate()), GET /sellers/v1/marketplaceParticipations, and
// a real pullOrders() call with a real recent date -- no TEST_CASE_200
// literal, no marketplaceParticipations-only smoke test. Mirrors
// scripts/amazon-sandbox-smoke-test.ts's shape, deliberately read-only:
// nothing here writes anything to Arif's real account. pushInventory/
// pushListing/confirmShipment are deliberately NOT called here.
//
// NOT built yet, on purpose: pushInventory/confirmShipment against
// production. Both are real writes to a real seller account and need Arif
// to have picked a safe test SKU and placed a self-test order first --
// that hasn't happened. Adding write paths here before that exists would
// risk touching real inventory/shipment data with no safe target to point
// them at.
//
// Requires AMAZON_PRODUCTION_CLIENT_ID/_CLIENT_SECRET/_REFRESH_TOKEN/
// _SELLER_ID (Arif's own real Seller Central app credentials -- see
// loadAmazonProductionCredentialsFromEnv(), completely separate from the
// AMAZON_SANDBOX_* vars). AMAZON_PRODUCTION_MARKETPLACE_ID is deliberately
// NOT read here anymore -- the marketplace id(s) come from a live
// getMarketplaceParticipations() call below instead of being guessed or
// pre-configured, since that's the whole point of calling it first.
//
// Base URL defaults to the NA production host (SP_API_NA_PRODUCTION_BASE_URL)
// -- Arif's real seller account is NA, not the EU/UK assumption baked into
// this file's sandbox defaults -- override with AMAZON_PRODUCTION_BASE_URL
// if that changes (see SP_API_EU_PRODUCTION_BASE_URL / SP_API_FE_PRODUCTION_BASE_URL,
// both exported alongside this one).
//
// Run with: npm run amazon:production-smoke-test

const PULL_ORDERS_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  const baseUrl = process.env.AMAZON_PRODUCTION_BASE_URL ?? SP_API_NA_PRODUCTION_BASE_URL;
  const credentials = loadAmazonProductionCredentialsFromEnv();

  // marketplaceIds is irrelevant to authenticate()/getMarketplaceParticipations()
  // (neither takes it) -- this first connector exists only to discover the
  // real value, not to guess one.
  const discoveryConnector = new AmazonConnector(credentials, baseUrl, []);

  if (discoveryConnector.isSandbox()) {
    // Only reachable if AMAZON_PRODUCTION_BASE_URL was set to a sandbox
    // host by mistake (a real copy-paste risk, not a hypothetical) -- fail
    // loudly rather than silently running the "production" smoke test
    // against sandbox data.
    throw new Error("Connector resolved to a sandbox host -- refusing to run the production smoke test against it.");
  }
  console.log(`isSandbox() = ${discoveryConnector.isSandbox()} (base URL: ${baseUrl})`);

  const token = await discoveryConnector.authenticate();
  console.log(`LWA authentication succeeded against production (access token acquired, not shown; expires ${token.expiresAt}).`);

  const marketplaces = await discoveryConnector.getMarketplaceParticipations();
  console.log(`\nReceived ${marketplaces.length} real marketplace participation(s):`);
  for (const mp of marketplaces) {
    console.log(
      `  - ${mp.marketplace.countryCode} (${mp.marketplace.id}) ` +
        `domain=${mp.marketplace.domainName} ` +
        `currency=${mp.marketplace.defaultCurrencyCode} ` +
        `participating=${mp.participation.isParticipating}`,
    );
  }

  const participatingIds = marketplaces
    .filter((mp) => mp.participation.isParticipating)
    .map((mp) => mp.marketplace.id);

  if (participatingIds.length === 0) {
    throw new Error(
      "No participating marketplaces returned by getMarketplaceParticipations() -- can't determine which " +
        "MarketplaceIds to pass to pullOrders(). Stopping before guessing one.",
    );
  }
  console.log(`\nUsing discovered marketplace id(s) for pullOrders: ${participatingIds.join(", ")}`);

  // A fresh connector, now that the real marketplace id(s) are known instead
  // of assumed -- authenticate() will just re-exchange the refresh token.
  const connector = new AmazonConnector(credentials, baseUrl, participatingIds);

  const since = new Date(Date.now() - PULL_ORDERS_LOOKBACK_MS);
  console.log(`\nPulling real orders created since ${since.toISOString()} (read-only: GetOrders + GetOrderItems)...`);
  const orders = await connector.pullOrders(since);

  console.log(`\nFound ${orders.length} order(s) in that window.`);
  if (orders.length > 0) {
    const first = orders[0];
    console.log(
      `First order: externalOrderId=${first.externalOrderId} status=${first.channelStatus} placedAt=${first.placedAt}`,
    );
    // pullOrders() already ran every order through normalizeAmazonOrder() --
    // if any order failed to normalize, pullOrders() would have thrown
    // before we got here. This just confirms the shape holds for real data.
    for (const order of orders) {
      if (!order.externalOrderId || !order.channel || !Array.isArray(order.lines)) {
        throw new Error(`Order ${order.externalOrderId} did not normalize into the expected NormalizedOrder shape.`);
      }
    }
    console.log(`All ${orders.length} order(s) normalized cleanly into NormalizedOrder without throwing.`);
  } else {
    console.log("No real orders in that window -- not an error, just means nothing's shipped through this account recently.");
  }

  console.log(
    "\nSmoke test PASSED: talked to real Amazon SP-API production infrastructure, read-only " +
      "(authenticate + marketplaceParticipations + pullOrders). No writes were made.",
  );
}

main().catch((error: unknown) => {
  console.error("Production smoke test FAILED:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
