import "dotenv/config";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createAppPool, withTenant } from "../packages/db/src/index.js";
import { seedTestChannelConnection } from "./seed-test-channel-connection.js";

// SANDBOX/TEST-DATA SEEDING ONLY -- not a production code path. A real
// tenant's product catalog comes from syncing their actual channel
// listings; this hardcodes the one SKU the Amazon SP-API sandbox's
// GetOrderItems TEST_CASE_200 scenario always returns (confirmed live
// against the EU sandbox -- see
// packages/channel-connectors/src/amazon-connector.ts,
// SP_API_SANDBOX_TEST_CASE_ORDER_ID), so that a tenant seeded by
// seed-test-channel-connection.ts can actually resolve that SKU to a
// product_id via channel_listings instead of persistPulledOrders() ->
// insertOrderLines() throwing "No channel_listings match".
//
// Seeds a warehouse location, one product, a channel_listings row mapping
// the sandbox's SKU to that product, and enough inventory_levels stock for
// the sandbox's canned orders to actually allocate.

export const SANDBOX_ORDER_ITEM_EXTERNAL_SKU = "NABetaASINB00551Q3CS";
export const SANDBOX_ORDER_ITEM_ASIN = "B00551Q3CS";

export interface SeededProductCatalog {
  locationId: string;
  productId: string;
}

export async function seedTestProductCatalog(
  pool: Pool,
  tenantId: string,
  onHand = 10,
): Promise<SeededProductCatalog> {
  return withTenant(pool, tenantId, async (client) => {
    const location = await client.query<{ id: string }>(
      `INSERT INTO locations (tenant_id, name, type) VALUES ($1, 'Sandbox Test Warehouse', 'warehouse') RETURNING id`,
      [tenantId],
    );
    const locationId = location.rows[0]!.id;

    const product = await client.query<{ id: string }>(
      `INSERT INTO products (tenant_id, internal_sku, name)
       VALUES ($1, $2, 'Amazon Sandbox Test Product (Card Book)') RETURNING id`,
      [tenantId, `SANDBOX-${randomUUID().slice(0, 8)}`],
    );
    const productId = product.rows[0]!.id;

    await client.query(
      `INSERT INTO channel_listings
         (tenant_id, product_id, channel, channel_marketplace, external_id, external_sku, listing_status)
       VALUES ($1, $2, 'amazon', 'US', $3, $4, 'active')`,
      [tenantId, productId, SANDBOX_ORDER_ITEM_ASIN, SANDBOX_ORDER_ITEM_EXTERNAL_SKU],
    );

    await client.query(
      `INSERT INTO inventory_levels (tenant_id, product_id, location_id, on_hand, reserved)
       VALUES ($1, $2, $3, $4, 0)`,
      [tenantId, productId, locationId, onHand],
    );

    return { locationId, productId };
  });
}

async function main(): Promise<void> {
  const connectionString = process.env.APP_DATABASE_URL;
  if (!connectionString) {
    throw new Error("APP_DATABASE_URL is not set (see .env.example)");
  }
  const pool = createAppPool({ connectionString });
  try {
    const { tenantId, connectionId } = await seedTestChannelConnection(pool);
    const { locationId, productId } = await seedTestProductCatalog(pool, tenantId);
    console.log("Seeded a fresh test tenant with a channel_connections row and a matching product catalog.");
    console.log(`  tenant_id: ${tenantId}`);
    console.log(`  channel_connections.id: ${connectionId}`);
    console.log(`  locations.id: ${locationId}`);
    console.log(`  products.id: ${productId} (external_sku=${SANDBOX_ORDER_ITEM_EXTERNAL_SKU})`);
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((error: unknown) => {
    console.error("Seed failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
