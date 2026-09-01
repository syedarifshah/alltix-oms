import "dotenv/config";
import { AmazonConnector, SP_API_NA_SANDBOX_BASE_URL } from "../packages/channel-connectors/src/amazon-connector.js";

// Proves AmazonConnector.pushInventory() succeeds against real SP-API
// sandbox infrastructure (CLAUDE.md §4.1, §8's "order pull + inventory
// push"). Never logs the access token or any credential -- only the
// resulting SyncResult, which is not sensitive.
//
// Uses the NA sandbox host, not the EU default used by the other smoke
// tests: the Listings Items API enforces that marketplaceIds match the
// host's region (confirmed live -- see SP_API_NA_SANDBOX_BASE_URL's
// comment in amazon-connector.ts), and this sandbox account is US-only.

async function main(): Promise<void> {
  const connector = new AmazonConnector(undefined, SP_API_NA_SANDBOX_BASE_URL);

  const result = await connector.pushInventory("TEST-SKU-PUSH-INVENTORY", 25);

  console.log("pushInventory result:");
  console.log(`  success: ${result.success}`);
  if (result.externalId) {
    console.log(`  externalId (sku the sandbox echoed back): ${result.externalId}`);
  }
  if (result.error) {
    console.log(`  error: ${result.error}`);
  }

  if (!result.success) {
    throw new Error("Sandbox pushInventory call did not succeed -- see result above.");
  }

  console.log(
    "\nSmoke test PASSED: talked to real Amazon SP-API sandbox Listings Items infrastructure " +
      "(the sandbox round-trips the request shape and an HTTP success for this endpoint; it " +
      "doesn't persist anything queryable back the way Orders does).",
  );
}

main().catch((error: unknown) => {
  console.error("Smoke test FAILED:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
