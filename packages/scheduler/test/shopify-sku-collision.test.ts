// Proves CLAUDE.md §4.5.5's own SKU-namespace-collision redesign
// (resolveShopifyProductIdentity, slugifyShopifyStoreDomain,
// titlesLikelySameProduct in packages/scheduler/src/index.ts) actually does
// what it claims: two connected Shopify stores sharing a literal SKU string
// for two DIFFERENT products no longer silently merge into one
// products/inventory row, while every ordinary (non-collision) case --
// single-store tenants, or a genuine same-product cross-listing -- keeps
// resolving to the plain "shopify-<sku>" internal_sku exactly as before
// this pass, unchanged.
//
// Same "real seeded Postgres, no mocks" shape as shopify-multi-store.test.ts
// -- resolveShopifyProductIdentity is a real DB read (products,
// channel_listings), not a pure function, so it's tested directly against
// real rows rather than stubbed. The two genuinely pure helpers
// (slugifyShopifyStoreDomain, titlesLikelySameProduct) are tested with no
// DB at all, first.
//
// Run with: npm run test --workspace=@alltix/scheduler -- shopify-sku-collision

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import type { Pool } from "pg";
import { createAppPool, withTenant } from "@alltix/db";
import { resolveShopifyProductIdentity, slugifyShopifyStoreDomain, titlesLikelySameProduct } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
loadEnv({ path: join(REPO_ROOT, ".env") });

let appPool: Pool;
let adminPool: Pool;

before(() => {
  const appConnectionString = process.env.APP_DATABASE_URL;
  const adminConnectionString = process.env.DATABASE_URL;
  if (!appConnectionString) throw new Error("APP_DATABASE_URL is not set (see .env.example)");
  if (!adminConnectionString) throw new Error("DATABASE_URL is not set (see .env.example)");
  appPool = createAppPool({ connectionString: appConnectionString });
  adminPool = createAppPool({ connectionString: adminConnectionString });
});

after(async () => {
  await appPool.end();
  await adminPool.end();
});

test("slugifyShopifyStoreDomain: strips the .myshopify.com suffix, lowercases, and collapses punctuation", () => {
  assert.equal(slugifyShopifyStoreDomain("My-Store.myshopify.com"), "my-store");
  assert.equal(slugifyShopifyStoreDomain("store_two.myshopify.com"), "store-two");
  assert.equal(slugifyShopifyStoreDomain("  Spaced Out Store  "), "spaced-out-store");
});

test("slugifyShopifyStoreDomain: falls back to 'store' for a blank/all-punctuation domain, never an empty string", () => {
  assert.equal(slugifyShopifyStoreDomain(""), "store");
  assert.equal(slugifyShopifyStoreDomain("...myshopify.com"), "store");
});

test("titlesLikelySameProduct: exact match after trim/lowercase, not fuzzy", () => {
  assert.equal(titlesLikelySameProduct("Widget", "widget"), true);
  assert.equal(titlesLikelySameProduct("  Widget  ", "Widget"), true);
  assert.equal(titlesLikelySameProduct("Widget", "Widget Pro"), false);
  assert.equal(titlesLikelySameProduct("Blue Widget", "Red Widget"), false);
});

/** Seeds a real `tenants` row plus two 'shopify' `channel_connections` rows
 *  (mirroring shopify-multi-store.test.ts's own seedTenantWithTwoShopifyStores)
 *  -- resolveShopifyProductIdentity's own foreign-connection check needs two
 *  REAL, distinct connection ids to tell apart. */
async function seedTenantWithTwoShopifyStores(): Promise<{ tenantId: string; connectionIdA: string; connectionIdB: string }> {
  const tenantId = randomUUID();
  await adminPool.query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, [
    tenantId,
    `shopify-sku-collision-test-tenant-${tenantId.slice(0, 8)}`,
  ]);
  const connectionIdA = await withTenant(appPool, tenantId, async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO channel_connections (tenant_id, channel, marketplace, external_account_id)
       VALUES ($1, 'shopify', '', $2) RETURNING id`,
      [tenantId, `store-a-${tenantId.slice(0, 8)}.myshopify.com`],
    );
    return result.rows[0]!.id;
  });
  const connectionIdB = await withTenant(appPool, tenantId, async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO channel_connections (tenant_id, channel, marketplace, external_account_id)
       VALUES ($1, 'shopify', '', $2) RETURNING id`,
      [tenantId, `store-b-${tenantId.slice(0, 8)}.myshopify.com`],
    );
    return result.rows[0]!.id;
  });
  return { tenantId, connectionIdA, connectionIdB };
}

/** Seeds a real `products` row plus a real `channel_listings` row scoped to
 *  the given connection -- the exact shape syncShopifyCatalogForConnection's
 *  own upsert leaves behind for a variant it already onboarded. */
async function seedExistingShopifyProduct(
  tenantId: string,
  connectionId: string,
  internalSku: string,
  name: string,
  externalId: string,
): Promise<string> {
  return withTenant(appPool, tenantId, async (client) => {
    const product = await client.query<{ id: string }>(
      `INSERT INTO products (tenant_id, internal_sku, name) VALUES ($1, $2, $3) RETURNING id`,
      [tenantId, internalSku, name],
    );
    const productId = product.rows[0]!.id;
    await client.query(
      `INSERT INTO channel_listings
         (tenant_id, product_id, channel, channel_marketplace, external_id, external_sku, listing_status, channel_connection_id)
       VALUES ($1, $2, 'shopify', '', $3, $4, 'active', $5)`,
      [tenantId, productId, externalId, internalSku, connectionId],
    );
    return productId;
  });
}

async function cleanup(tenantId: string): Promise<void> {
  await withTenant(appPool, tenantId, (client) =>
    client.query("DELETE FROM channel_listings WHERE tenant_id = $1", [tenantId]),
  );
  await withTenant(appPool, tenantId, (client) => client.query("DELETE FROM products WHERE tenant_id = $1", [tenantId]));
  await withTenant(appPool, tenantId, (client) =>
    client.query("DELETE FROM channel_connections WHERE tenant_id = $1", [tenantId]),
  );
  await adminPool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

test("resolveShopifyProductIdentity: no existing product under the base SKU -- ordinary path, not namespaced", async () => {
  const { tenantId, connectionIdA } = await seedTenantWithTwoShopifyStores();
  try {
    const resolved = await withTenant(appPool, tenantId, (client) =>
      resolveShopifyProductIdentity(client, tenantId, connectionIdA, "store-a", "NEW-SKU", "Brand New Widget"),
    );
    assert.equal(resolved.internalSku, "shopify-NEW-SKU");
    assert.equal(resolved.isNamespacedForCollision, false);
  } finally {
    await cleanup(tenantId);
  }
});

test("resolveShopifyProductIdentity: same SKU, matching title -- treated as the same product, not namespaced (deliberate cross-listing)", async () => {
  const { tenantId, connectionIdA, connectionIdB } = await seedTenantWithTwoShopifyStores();
  try {
    await seedExistingShopifyProduct(tenantId, connectionIdA, "shopify-SHARED-SKU", "Blue Widget", "gid://store-a/1");
    const resolved = await withTenant(appPool, tenantId, (client) =>
      resolveShopifyProductIdentity(client, tenantId, connectionIdB, "store-b", "SHARED-SKU", "  blue widget  "),
    );
    assert.equal(resolved.internalSku, "shopify-SHARED-SKU", "must resolve to the SAME product, not a namespaced one");
    assert.equal(resolved.isNamespacedForCollision, false);
  } finally {
    await cleanup(tenantId);
  }
});

test("resolveShopifyProductIdentity: same SKU, different title, different connection -- a genuine collision, namespaced", async () => {
  const { tenantId, connectionIdA, connectionIdB } = await seedTenantWithTwoShopifyStores();
  try {
    await seedExistingShopifyProduct(tenantId, connectionIdA, "shopify-SHARED-SKU", "Blue Widget", "gid://store-a/1");
    const resolved = await withTenant(appPool, tenantId, (client) =>
      resolveShopifyProductIdentity(client, tenantId, connectionIdB, "store-b", "SHARED-SKU", "Red Gadget"),
    );
    assert.equal(
      resolved.internalSku,
      "shopify-store-b-SHARED-SKU",
      "a genuine collision must mint a new, connection-namespaced SKU, not merge into store A's own product",
    );
    assert.equal(resolved.isNamespacedForCollision, true);
  } finally {
    await cleanup(tenantId);
  }
});

test("resolveShopifyProductIdentity: same SKU, different title, but NO foreign connection attached yet -- not a collision, updates in place", async () => {
  const { tenantId, connectionIdA } = await seedTenantWithTwoShopifyStores();
  try {
    // A product that exists under this SKU but with no channel_listings row
    // at all (e.g. created by hand, or a title that changed on the SAME
    // store before its own channel_listings row was ever written) is not
    // evidence of a cross-store collision.
    await withTenant(appPool, tenantId, (client) =>
      client.query(`INSERT INTO products (tenant_id, internal_sku, name) VALUES ($1, $2, $3)`, [
        tenantId,
        "shopify-RETITLED-SKU",
        "Old Title",
      ]),
    );
    const resolved = await withTenant(appPool, tenantId, (client) =>
      resolveShopifyProductIdentity(client, tenantId, connectionIdA, "store-a", "RETITLED-SKU", "New Title"),
    );
    assert.equal(resolved.internalSku, "shopify-RETITLED-SKU", "a retitle with no foreign connection must update in place");
    assert.equal(resolved.isNamespacedForCollision, false);
  } finally {
    await cleanup(tenantId);
  }
});

test("resolveShopifyProductIdentity: same SKU, different title, but the ONLY channel_listings row is for the SAME connection -- not a collision", async () => {
  const { tenantId, connectionIdA } = await seedTenantWithTwoShopifyStores();
  try {
    // The existing product's own channel_listings row is tied to the SAME
    // connection now resyncing it under a new title -- a retitle on the
    // same store, not a cross-store collision.
    await seedExistingShopifyProduct(tenantId, connectionIdA, "shopify-SAME-STORE-SKU", "Old Title", "gid://store-a/2");
    const resolved = await withTenant(appPool, tenantId, (client) =>
      resolveShopifyProductIdentity(client, tenantId, connectionIdA, "store-a", "SAME-STORE-SKU", "Updated Title"),
    );
    assert.equal(resolved.internalSku, "shopify-SAME-STORE-SKU");
    assert.equal(resolved.isNamespacedForCollision, false);
  } finally {
    await cleanup(tenantId);
  }
});

test("resolveShopifyProductIdentity: the namespaced SKU is deterministic and stable across repeated resolutions (idempotent re-sync)", async () => {
  const { tenantId, connectionIdA, connectionIdB } = await seedTenantWithTwoShopifyStores();
  try {
    await seedExistingShopifyProduct(tenantId, connectionIdA, "shopify-STABLE-SKU", "Blue Widget", "gid://store-a/3");
    const first = await withTenant(appPool, tenantId, (client) =>
      resolveShopifyProductIdentity(client, tenantId, connectionIdB, "store-b", "STABLE-SKU", "Red Gadget"),
    );
    const second = await withTenant(appPool, tenantId, (client) =>
      resolveShopifyProductIdentity(client, tenantId, connectionIdB, "store-b", "STABLE-SKU", "Red Gadget"),
    );
    assert.equal(first.internalSku, second.internalSku, "re-resolving the same collision must yield the same namespaced SKU every time");
    assert.equal(first.isNamespacedForCollision, true);
    assert.equal(second.isNamespacedForCollision, true);
  } finally {
    await cleanup(tenantId);
  }
});
