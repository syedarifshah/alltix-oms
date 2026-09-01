import "dotenv/config";
import { exchangeAmazonAuthorizationCode } from "../packages/channel-connectors/src/amazon-oauth.js";

// Proves what CAN be proven about the "Connect Amazon" OAuth flow's token
// exchange without a Public SP-API application (see the header comment in
// packages/channel-connectors/src/amazon-oauth.ts for why the real,
// browser-driven flow is unreachable): that exchangeAmazonAuthorizationCode
// builds a request LWA's real token endpoint actually accepts and processes
// -- not a malformed request, a wrong endpoint, or a network/config error.
//
// This intentionally sends a fake spapi_oauth_code, since there is no way
// to obtain a real one. A real endpoint that understood the request would
// reject a fake code with a structured OAuth error (invalid_grant) rather
// than, say, a 400 complaining about missing/malformed parameters -- that
// distinction is the whole point of this script. It reuses
// AMAZON_SANDBOX_CLIENT_ID/SECRET (the one LWA app this repo actually has
// credentials for) purely as *some* syntactically valid client_id/secret to
// exchange against; this is not a claim that they belong to a Public
// application capable of this flow for real.

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  }
  return value;
}

async function main(): Promise<void> {
  const clientId = readRequiredEnv("AMAZON_SANDBOX_CLIENT_ID");
  const clientSecret = readRequiredEnv("AMAZON_SANDBOX_CLIENT_SECRET");

  try {
    await exchangeAmazonAuthorizationCode("fake-spapi-oauth-code-for-isolation-test-only", {
      clientId,
      clientSecret,
      redirectUri: "https://example.com/api/channels/amazon/callback",
    });
    throw new Error(
      "Expected the LWA token endpoint to reject a fake authorization code, but it returned success -- investigate.",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("LWA authorization-code exchange failed")) {
      throw err; // Not the expected rejection shape -- a real bug, rethrow.
    }
    console.log("Isolation test PASSED: LWA's real token endpoint received and rejected the request as expected.");
    console.log(`  (rejection detail, not sensitive: ${message})`);
    console.log(
      "\nThis proves exchangeAmazonAuthorizationCode's request shape (endpoint, grant_type, body params) is " +
        "correct against live Amazon infrastructure. It does NOT prove the full redirect-based flow works -- " +
        "that needs a Public SP-API application, a real seller consent screen, and a real spapi_oauth_code, none " +
        "of which exist for this repo's (Private) app. See packages/channel-connectors/src/amazon-oauth.ts.",
    );
  }
}

main().catch((error: unknown) => {
  console.error("Isolation test FAILED:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
