import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createAppPool, withTenant } from "../packages/db/src/index.js";
import { InventoryService } from "../packages/inventory-service/src/index.js";

// GENERAL-PURPOSE, PRODUCTION-SAFE catalog onboarding script -- NOT
// sandbox/test-data-only like scripts/seed-test-product-catalog.ts (that one
// hardcodes the Amazon SP-API sandbox's one canned SKU; this one takes a
// real tenant/channel/SKU as input).
//
// Run this whenever a real order fails to persist with "No channel_listings
// match for channel=<x> external_sku=<y>" (see
// OrderService.persistPulledOrders -> insertOrderLines, packages/order-service/
// src/index.ts). That error means the SKU on the order line has never been
// mapped to an internal product -- and nothing in the app's UI can do that
// mapping yet: POST /api/products (packages/web/src/app/api/products/route.ts)
// creates a bare product with no channel_listings row at all. This script is
// the stopgap until a real "map this SKU" UI exists.
//
// Idempotent -- safe to re-run with the same TENANT_ID/CHANNEL/EXTERNAL_SKU:
//  - the product upsert keys on products' own (tenant_id, internal_sku)
//    UNIQUE constraint (migration 0003).
//  - the channel_listings upsert keys on its (tenant_id, channel,
//    channel_marketplace, external_id) UNIQUE constraint (migration 0004) --
//    NOT external_sku, which is why EXTERNAL_ID defaults to EXTERNAL_SKU
//    below (two different real SKUs must not collide on external_id).
//  - the initial-stock receipt (if INITIAL_ON_HAND is set) uses a
//    deterministic idempotency_key (tenant+channel+sku, no random
//    component) via InventoryService.recordInventoryEvent -- so re-running
//    this script does NOT add the stock twice. It also means this script
//    only ever seeds a SKU's *starting* stock once; a real restock later is
//    a separate, not-yet-built "receive PO" flow, not this script's job.
//
// Initial stock goes through InventoryService.recordInventoryEvent --
// never a direct inventory_levels write -- leaving a real, audit-trailed
// 'receipt' row in inventory_events (CLAUDE.md §2.2: "never let a channel
// adapter write directly to inventory_levels ... every stock change goes
// through inventory_events first").
//
// Run with (all required vars inline, nothing here is a secret):
//   TENANT_ID=... CHANNEL=shopify EXTERNAL_SKU=sku-hosted-1 \
//   PRODUCT_NAME="My Product" INITIAL_ON_HAND=10 \
//   npm run catalog:add-channel-listing
//
// Required:
//   TENANT_ID     -- the tenants.id this listing belongs to
//   CHANNEL       -- 'amazon' | 'shopify' | 'walmart' (free text, matches
//                    whatever the connector normalizes orders.channel to)
//   EXTERNAL_SKU  -- exactly the string the channel's order line carries
//                    (case-sensitive; this is a plain string equality match)
//   PRODUCT_NAME  -- human-readable name for the products row
//
// Optional:
//   INTERNAL_SKU        -- default: "<CHANNEL>-<EXTERNAL_SKU>". Set this to
//                          an EXISTING product's internal_sku to attach a
//                          second channel's listing to a product you
//                          already created (e.g. the same physical item
//                          sold on both Amazon and Shopify).
//   CHANNEL_MARKETPLACE -- default: '' (Shopify/Walmart convention -- see
//                          normalizeShopifyOrder's own channelMarketplace:
//                          "" comment). Amazon listings should pass the
//                          real marketplace code (e.g. "US").
//   EXTERNAL_ID         -- default: EXTERNAL_SKU. The channel's own
//                          ASIN/variant-id, when it differs from the SKU
//                          and you want it recorded.
//   LOCATION_NAME       -- default: "Primary Warehouse". Only used when
//                          INITIAL_ON_HAND is set -- found by name or
//                          created if it doesn't exist yet for this tenant.
//   INITIAL_ON_HAND     -- default: unset (no stock seeded, listing only).
//                          A non-negative integer.

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const connectionString = readRequiredEnv("APP_DATABASE_URL");
  const tenantId = readRequiredEnv("TENANT_ID");
  const channel = readRequiredEnv("CHANNEL");
  const externalSku = readRequiredEnv("EXTERNAL_SKU");
  const productName = readRequiredEnv("PRODUCT_NAME");

  const internalSku = process.env.INTERNAL_SKU ?? `${channel}-${externalSku}`;
  const channelMarketplace = process.env.CHANNEL_MARKETPLACE ?? "";
  const externalId = process.env.EXTERNAL_ID ?? externalSku;
  const locationName = process.env.LOCATION_NAME ?? "Primary Warehouse";
  const initialOnHandRaw = process.env.INITIAL_ON_HAND;
  const initialOnHand = initialOnHandRaw !== undefined ? Number(initialOnHandRaw) : null;

  if (initialOnHand !== null && (!Number.isFinite(initialOnHand) || initialOnHand < 0)) {
    throw new Error(`INITIAL_ON_HAND must be a non-negative number, got: ${initialOnHandRaw}`);
  }

  const pool = createAppPool({ connectionString });
  try {
    const { productId, channelListingId, locationId } = await withTenant(pool, tenantId, async (client) => {
      const product = await client.query<{ id: string }>(
        `INSERT INTO products (tenant_id, internal_sku, name)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, internal_sku) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [tenantId, internalSku, productName],
      );
      const productId = product.rows[0]!.id;

      const listing = await client.query<{ id: string }>(
        `INSERT INTO channel_listings
           (tenant_id, product_id, channel, channel_marketplace, external_id, external_sku, listing_status)
         VALUES ($1, $2, $3, $4, $5, $6, 'active')
         ON CONFLICT (tenant_id, channel, channel_marketplace, external_id) DO UPDATE SET
           product_id = EXCLUDED.product_id,
           external_sku = EXCLUDED.external_sku,
           listing_status = 'active',
           updated_at = now()
         RETURNING id`,
        [tenantId, productId, channel, channelMarketplace, externalId, externalSku],
      );
      const channelListingId = listing.rows[0]!.id;

      let locationId: string | null = null;
      if (initialOnHand !== null) {
        const existingLocation = await client.query<{ id: string }>(
          `SELECT id FROM locations WHERE tenant_id = $1 AND name = $2 LIMIT 1`,
          [tenantId, locationName],
        );
        if (existingLocation.rows[0]) {
          locationId = existingLocation.rows[0].id;
        } else {
          const newLocation = await client.query<{ id: string }>(
            `INSERT INTO locations (tenant_id, name, type) VALUES ($1, $2, 'warehouse') RETURNING id`,
            [tenantId, locationName],
          );
          locationId = newLocation.rows[0]!.id;
        }
      }

      return { productId, channelListingId, locationId };
    });

    if (initialOnHand !== null && locationId) {
      const inventoryService = new InventoryService(pool);
      // Deterministic (no random component) -- see this file's header
      // comment on idempotency: re-running this script must not re-add the
      // same starting stock a second time.
      const idempotencyKey = `catalog-onboarding:${tenantId}:${channel}:${externalSku}`;
      const result = await inventoryService.recordInventoryEvent({
        tenantId,
        productId,
        locationId,
        eventType: "receipt",
        quantityDelta: initialOnHand,
        referenceType: "manual",
        idempotencyKey,
      });
      if (result.applied) {
        console.log(`Recorded initial receipt of ${initialOnHand} unit(s) -- inventory_events.id=${result.eventId}`);
      } else {
        console.log(
          `Initial stock for this SKU was already recorded by an earlier run of this script (idempotency_key=${idempotencyKey}) -- not applied again.`,
        );
      }
    }

    console.log("Channel listing ready:");
    console.log(`  product_id: ${productId}`);
    console.log(`  channel_listings.id: ${channelListingId}`);
    console.log(
      `  channel=${channel} channel_marketplace='${channelMarketplace}' external_id=${externalId} external_sku=${externalSku}`,
    );
    console.log(
      "The next order-sync pass (or a manual cron 'Run' in Vercel) can now resolve this SKU and persist any " +
        "pending/future order lines that reference it.",
    );
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((error: unknown) => {
    console.error("add-channel-listing failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
