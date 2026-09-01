import "dotenv/config";
import { createAppPool } from "../packages/db/src/index.js";
import {
  createAmazonConnectorFromChannelConnection,
  SP_API_SANDBOX_TEST_CASE_CREATED_AFTER,
} from "../packages/channel-connectors/src/amazon-connector.js";
import { seedTestChannelConnection } from "./seed-test-channel-connection.js";

// Proves the full credentials-from-DB path end to end: seed a fresh test
// tenant's channel_connections row (encrypted at rest) -> build an
// AmazonConnector that reads and decrypts that row instead of process.env
// -> LWA auth -> a real SP-API sandbox Orders API call -> normalized output.
// See CLAUDE.md §4.1, §11.5 -- sandbox-first. Never logs the decrypted
// client_secret/refresh_token or the access token; only order data and
// access-token *status*, neither of which is sensitive.

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  }
  return value;
}

async function main(): Promise<void> {
  const pool = createAppPool({ connectionString: readRequiredEnv("APP_DATABASE_URL") });

  try {
    const { tenantId, connectionId } = await seedTestChannelConnection(pool);
    console.log(`Seeded test tenant ${tenantId} (channel_connections.id=${connectionId}).`);

    const connector = await createAmazonConnectorFromChannelConnection(pool, tenantId);

    await connector.authenticate();
    console.log(
      "LWA authentication succeeded using channel_connections-sourced credentials (access token acquired, not shown).",
    );

    // The Orders API sandbox rejects a real CreatedAfter date outright
    // ("InvalidInput: Could not match input arguments") -- it only returns
    // its static canned orders for one of Amazon's documented literal
    // trigger strings. See SP_API_SANDBOX_TEST_CASE_CREATED_AFTER.
    const orders = await connector.pullOrders(SP_API_SANDBOX_TEST_CASE_CREATED_AFTER);

    if (orders.length === 0) {
      throw new Error(
        "Sandbox call returned 200 but with zero orders -- unexpected for the SP-API sandbox, which should always return static test data.",
      );
    }

    console.log(`Received ${orders.length} normalized order(s):`);
    for (const order of orders) {
      console.log(
        `  - ${order.externalOrderId} status=${order.channelStatus} ` +
          `placedAt=${order.placedAt} marketplace=${order.channelMarketplace}`,
      );
      for (const line of order.lines) {
        console.log(
          `      line ${line.externalLineId}: sku=${line.externalSku} qty=${line.quantity} ` +
            `unitPrice=${line.unitPrice} fulfillmentType=${line.fulfillmentType}`,
        );
      }
    }

    console.log(
      "\nSmoke test PASSED: channel_connections row -> decrypted credentials -> LWA auth -> " +
        "real sandbox Orders API call -> normalized output.",
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("Pull-orders smoke test FAILED:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
