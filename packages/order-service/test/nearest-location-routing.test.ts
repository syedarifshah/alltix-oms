// Proves CLAUDE.md §8 Phase 4's "nearest-location-by-shipping-address
// routing (no schema support at all yet)" gap is now closed: allocateOrder()
// ranks its non-preferred warehouse fallback candidates nearest-first to an
// order's shipping ZIP (via extractUsShippingZip/rankByDistanceToShippingZip,
// both exported from ../src/index.ts) instead of purely oldest-created-first
// -- but only ever ADDS information; every pre-existing
// oldest-created-first/preferred-location behavior multi-warehouse-
// allocation.test.ts already proves stays exactly as it was whenever
// distance can't be determined.
//
// The pure-function tests (extractUsShippingZip, rankByDistanceToShippingZip)
// need no DB and run first; the allocation tests below them require a live
// Postgres (npm run db:migrate), same as multi-warehouse-allocation.test.ts.
//
// Run with: npm run test --workspace=@alltix/order-service -- nearest-location-routing

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { Client, type Pool } from "pg";
import { createAppPool, withTenant } from "@alltix/db";
import { OrderService, extractUsShippingZip, rankByDistanceToShippingZip } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

loadEnv({ path: join(REPO_ROOT, ".env") });

// Real ZIP codes (confirmed against the installed `zipcodes` package's own
// bundled data): 90001 and 90002 are both Los Angeles, CA, 2 miles apart;
// 33101 is Miami, FL, 2335 miles from 90001. Real distances, not fabricated
// -- this test relies on which one is bigger, not an exact value.
const LA_ZIP = "90001";
const NEARBY_LA_ZIP = "90002";
const FAR_MIAMI_ZIP = "33101";

test("extractUsShippingZip reads each channel's own confirmed field path", () => {
  assert.equal(extractUsShippingZip("amazon", { PostalCode: "90001", CountryCode: "US" }), "90001");
  assert.equal(extractUsShippingZip("shopify", { zip: "90001", countryCodeV2: "US" }), "90001");
  assert.equal(extractUsShippingZip("walmart", { postalCode: "90001", country: "US" }), "90001");
  assert.equal(
    extractUsShippingZip("ebay", { contactAddress: { postalCode: "90001", countryCode: "US" } }),
    "90001",
  );
});

test("extractUsShippingZip returns null for a non-US country, not a guess", () => {
  assert.equal(extractUsShippingZip("shopify", { zip: "K1A 0B1", countryCodeV2: "CA" }), null);
  assert.equal(extractUsShippingZip("amazon", { PostalCode: "12345", CountryCode: "DE" }), null);
});

test("extractUsShippingZip returns null for missing/unrecognized shape, not a throw", () => {
  assert.equal(extractUsShippingZip("shopify", null), null);
  assert.equal(extractUsShippingZip("shopify", {}), null);
  assert.equal(extractUsShippingZip("some-future-channel", { zip: "90001", countryCodeV2: "US" }), null);
  assert.equal(extractUsShippingZip("ebay", { contactAddress: "not an object" }), null);
});

test("rankByDistanceToShippingZip orders known-distance locations nearest-first", () => {
  const ranked = rankByDistanceToShippingZip(
    [
      { id: "far", postal_code: FAR_MIAMI_ZIP },
      { id: "near", postal_code: NEARBY_LA_ZIP },
    ],
    LA_ZIP,
  );
  assert.deepEqual(ranked, ["near", "far"]);
});

test("rankByDistanceToShippingZip keeps unknown-distance locations after known ones, in original order", () => {
  const ranked = rankByDistanceToShippingZip(
    [
      { id: "unknown-1", postal_code: null },
      { id: "near", postal_code: NEARBY_LA_ZIP },
      { id: "unknown-2", postal_code: "not-a-real-zip" },
      { id: "far", postal_code: FAR_MIAMI_ZIP },
    ],
    LA_ZIP,
  );
  assert.deepEqual(ranked, ["near", "far", "unknown-1", "unknown-2"]);
});

let pool: Pool;
const tenantId = randomUUID();

async function seedLocation(name: string, postalCode: string | null = null): Promise<string> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO locations (tenant_id, name, type, postal_code) VALUES ($1, $2, 'warehouse', $3) RETURNING id`,
      [tenantId, name, postalCode],
    );
    return result.rows[0]!.id;
  });
}

async function seedProduct(sku: string): Promise<string> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO products (tenant_id, internal_sku, name) VALUES ($1, $2, $2) RETURNING id`,
      [tenantId, sku],
    );
    return result.rows[0]!.id;
  });
}

async function seedLevel(productId: string, locationId: string, onHand: number): Promise<void> {
  await withTenant(pool, tenantId, (client) =>
    client.query(
      `INSERT INTO inventory_levels (tenant_id, product_id, location_id, on_hand, reserved) VALUES ($1, $2, $3, $4, 0)`,
      [tenantId, productId, locationId, onHand],
    ),
  );
}

async function seedOrder(
  productId: string,
  quantity: number,
  options: { channel?: string; shippingAddress?: Record<string, unknown>; preferredLocationId?: string | null } = {},
): Promise<string> {
  const { channel = "shopify", shippingAddress = null, preferredLocationId = null } = options;
  return withTenant(pool, tenantId, async (client) => {
    const order = await client.query<{ id: string }>(
      `INSERT INTO orders (tenant_id, channel, external_order_id, status, preferred_location_id, shipping_address)
       VALUES ($1, $2, $3, 'validated', $4, $5) RETURNING id`,
      [
        tenantId,
        channel,
        `NEAREST-LOC-TEST-${randomUUID()}`,
        preferredLocationId,
        shippingAddress ? JSON.stringify(shippingAddress) : null,
      ],
    );
    const orderId = order.rows[0]!.id;
    await client.query(
      `INSERT INTO order_lines (tenant_id, order_id, product_id, quantity, unit_price, fulfillment_type)
       VALUES ($1, $2, $3, $4, 9.99, 'seller_fulfilled')`,
      [tenantId, orderId, productId, quantity],
    );
    return orderId;
  });
}

async function reservedLocationId(orderId: string): Promise<string | undefined> {
  const events = await withTenant(pool, tenantId, (client) =>
    client.query<{ location_id: string }>(
      `SELECT location_id FROM inventory_events WHERE tenant_id = $1 AND reference_id = $2 AND event_type = 'reservation'`,
      [tenantId, orderId],
    ),
  );
  return events.rows[0]?.location_id;
}

before(async () => {
  const connectionString = process.env.APP_DATABASE_URL;
  if (!connectionString) {
    throw new Error("APP_DATABASE_URL is not set (see .env.example)");
  }
  pool = createAppPool({ connectionString });
});

after(async () => {
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query("DELETE FROM audit_log WHERE tenant_id = $1", [tenantId]);
  await admin.query("DELETE FROM inventory_events WHERE tenant_id = $1", [tenantId]);
  await admin.query("DELETE FROM orders WHERE tenant_id = $1", [tenantId]); // cascades order_lines
  await admin.query("DELETE FROM inventory_levels WHERE tenant_id = $1", [tenantId]);
  await admin.end();

  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM locations WHERE tenant_id = $1", [tenantId]));
  await withTenant(pool, tenantId, (client) => client.query("DELETE FROM products WHERE tenant_id = $1", [tenantId]));
  await pool.end();
});

test("a nearer, newer warehouse is chosen over a farther, older one that also has enough stock", async () => {
  const farOlderLocationId = await seedLocation("Nearest-Loc Far Older (Miami)", FAR_MIAMI_ZIP);
  const nearNewerLocationId = await seedLocation("Nearest-Loc Near Newer (LA)", NEARBY_LA_ZIP);
  const productId = await seedProduct("NEAREST-LOC-SKU-1");
  await seedLevel(productId, farOlderLocationId, 10);
  await seedLevel(productId, nearNewerLocationId, 10);

  const orderId = await seedOrder(productId, 2, {
    channel: "shopify",
    shippingAddress: { zip: LA_ZIP, countryCodeV2: "US" },
  });
  const orderService = new OrderService(pool);
  const status = await orderService.transition(tenantId, orderId, "validated", "allocated");

  assert.equal(status, "allocated");
  assert.equal(
    await reservedLocationId(orderId),
    nearNewerLocationId,
    "must prefer the nearer warehouse even though it was created after the farther one",
  );
});

test("a shipping address with no resolvable US ZIP falls back to oldest-created-first, unchanged", async () => {
  const olderLocationId = await seedLocation("Nearest-Loc Fallback Older", FAR_MIAMI_ZIP);
  const newerLocationId = await seedLocation("Nearest-Loc Fallback Newer", NEARBY_LA_ZIP);
  const productId = await seedProduct("NEAREST-LOC-SKU-2");
  await seedLevel(productId, olderLocationId, 10);
  await seedLevel(productId, newerLocationId, 10);

  // A non-US shipping address -- extractUsShippingZip returns null, so
  // distance can't be computed for EITHER location even though both have a
  // postal_code set, and the original oldest-created-first order must win.
  const orderId = await seedOrder(productId, 2, {
    channel: "shopify",
    shippingAddress: { zip: "K1A 0B1", countryCodeV2: "CA" },
  });
  const orderService = new OrderService(pool);
  const status = await orderService.transition(tenantId, orderId, "validated", "allocated");

  assert.equal(status, "allocated");
  assert.equal(
    await reservedLocationId(orderId),
    olderLocationId,
    "with no resolvable shipping ZIP, the oldest-created warehouse must still win",
  );
});

test("an explicit preferred_location_id still wins even when a nearer warehouse exists", async () => {
  const farPreferredLocationId = await seedLocation("Nearest-Loc Preferred Far", FAR_MIAMI_ZIP);
  const nearNonPreferredLocationId = await seedLocation("Nearest-Loc Non-Preferred Near", NEARBY_LA_ZIP);
  const productId = await seedProduct("NEAREST-LOC-SKU-3");
  await seedLevel(productId, farPreferredLocationId, 10);
  await seedLevel(productId, nearNonPreferredLocationId, 10);

  const orderId = await seedOrder(productId, 2, {
    channel: "shopify",
    shippingAddress: { zip: LA_ZIP, countryCodeV2: "US" },
    preferredLocationId: farPreferredLocationId,
  });
  const orderService = new OrderService(pool);
  const status = await orderService.transition(tenantId, orderId, "validated", "allocated");

  assert.equal(status, "allocated");
  assert.equal(
    await reservedLocationId(orderId),
    farPreferredLocationId,
    "a routing rule's explicit preferred_location_id must still take priority over distance",
  );
});

test("a nearer warehouse with no postal_code set falls back behind one with a known distance", async () => {
  // The order's own shipping ZIP resolves fine, but this location just never
  // had a postal_code entered -- unknown distance, not "assume nearest."
  const noZipLocationId = await seedLocation("Nearest-Loc No ZIP Set", null);
  const knownDistanceLocationId = await seedLocation("Nearest-Loc Known Distance (Far)", FAR_MIAMI_ZIP);
  const productId = await seedProduct("NEAREST-LOC-SKU-4");
  await seedLevel(productId, noZipLocationId, 10);
  await seedLevel(productId, knownDistanceLocationId, 10);

  const orderId = await seedOrder(productId, 2, {
    channel: "shopify",
    shippingAddress: { zip: LA_ZIP, countryCodeV2: "US" },
  });
  const orderService = new OrderService(pool);
  const status = await orderService.transition(tenantId, orderId, "validated", "allocated");

  assert.equal(status, "allocated");
  assert.equal(
    await reservedLocationId(orderId),
    knownDistanceLocationId,
    "a location with a known (even if far) distance must be tried before one with no postal_code at all",
  );
});
