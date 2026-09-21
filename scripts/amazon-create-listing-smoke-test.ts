import "dotenv/config";
import { AmazonConnector, SP_API_NA_SANDBOX_BASE_URL } from "../packages/channel-connectors/src/amazon-connector.js";

// Proves AmazonConnector.createListing() succeeds against real SP-API
// sandbox infrastructure (CLAUDE.md §4.1's "Outbound listing creation" --
// UNVERIFIED note). Never logs the access token or any credential -- only
// the resulting AmazonListingResult, which is not sensitive.
//
// Same NA sandbox host as amazon-push-inventory-smoke-test.ts, for the same
// reason: the Listings Items API enforces that marketplaceIds match the
// host's region, and this sandbox account is US-only. createListing() PUTs
// to the same Listings Items API family pushInventory()'s PATCH already
// proved safe against sandbox -- it round-trips the request shape and an
// HTTP success without persisting a real, publicly-visible listing (same as
// pushInventory's own confirmed sandbox behavior) -- so a fake ASIN is safe
// to use here; this is NOT a call against production, where a real ASIN
// would create a real, live, purchasable offer under the connected seller
// account.

async function main(): Promise<void> {
  const connector = new AmazonConnector(undefined, SP_API_NA_SANDBOX_BASE_URL);

  const result = await connector.createListing({
    asin: "B00TESTASIN1", // fake, sandbox-only -- see header comment
    sellerSku: "TEST-SKU-CREATE-LISTING",
    price: "19.99",
    quantity: 10,
  });

  console.log("createListing result:");
  console.log(`  success: ${result.success}`);
  console.log(`  sku: ${result.sku}`);
  if (result.error) {
    console.log(`  error: ${result.error}`);
  }

  if (!result.success) {
    throw new Error("Sandbox createListing call did not succeed -- see result above.");
  }

  console.log(
    "\nSmoke test PASSED: talked to real Amazon SP-API sandbox Listings Items infrastructure " +
      "(PUT requirements=LISTING_OFFER_ONLY). Same caveat as pushInventory's own sandbox pass: " +
      "this round-trips the request shape and an HTTP success, it doesn't persist a real, " +
      "queryable listing -- a live production ASIN/account is still needed to prove an actual " +
      "listing goes live.",
  );
}

main().catch((error: unknown) => {
  console.error("Smoke test FAILED:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});