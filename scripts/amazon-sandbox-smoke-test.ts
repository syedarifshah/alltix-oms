import "dotenv/config";
import { AmazonConnector } from "../packages/channel-connectors/src/amazon-connector.js";

// Proves the full Amazon SP-API sandbox credential chain works end to end:
// LWA refresh-token exchange (authenticate()) followed by one real sandbox
// call (GET /sellers/v1/marketplaceParticipations). See CLAUDE.md §4.1 and
// §11.5 -- sandbox-first, one channel at a time. Never logs the access
// token, client secret, or refresh token.

async function main(): Promise<void> {
  const connector = new AmazonConnector();

  await connector.authenticate();
  console.log("LWA authentication succeeded (access token acquired, not shown).");

  const marketplaces = await connector.getMarketplaceParticipations();

  if (marketplaces.length === 0) {
    throw new Error(
      "Sandbox call returned 200 but with zero marketplace participations -- " +
        "unexpected for the SP-API sandbox, which should always return static test data.",
    );
  }

  console.log(`Received ${marketplaces.length} marketplace participation(s):`);
  for (const mp of marketplaces) {
    console.log(
      `  - ${mp.marketplace.countryCode} (${mp.marketplace.id}) ` +
        `domain=${mp.marketplace.domainName} ` +
        `currency=${mp.marketplace.defaultCurrencyCode} ` +
        `participating=${mp.participation.isParticipating}`,
    );
  }

  console.log("\nSmoke test PASSED: talked to real Amazon SP-API sandbox infrastructure.");
}

main().catch((error: unknown) => {
  console.error("Smoke test FAILED:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
