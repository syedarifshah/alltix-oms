import type { NextRequest } from "next/server";
import { withTenant } from "@alltix/db";
import { createWalmartConnectorFromChannelConnection, type NormalizedListing } from "@alltix/channel-connectors";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

/**
 * POST /api/channels/walmart/listings -- the outbound "offer this product on
 * Walmart" flow's entry point, submitted from the /products page's per-product
 * form. Mirrors /api/channels/shopify/listings' role for Shopify, but the two
 * flows are shaped differently because the underlying Walmart/Shopify APIs
 * are: this is Offer Setup by Match (WalmartConnector.submitListing(), the
 * MP_ITEM_MATCH feed) against an EXISTING Walmart catalog item the tenant
 * identifies by GTIN -- not creating a brand-new item the way Shopify's
 * createListing() does. That's also why this needs more from the tenant than
 * Shopify's flow does (a GTIN, a shipping weight, a product category) and why
 * the result here is asynchronous: submitListing() only returns a feedId, not
 * a finished outcome -- see the companion
 * /api/channels/walmart/listings/[id]/check-status route for how that
 * resolves later, and WalmartConnector.submitListing()/
 * buildMpItemMatchFeedPayload's own doc comments for exactly what's confirmed
 * against a live-fetched Walmart doc page vs. still unverified against a real
 * submission (no Walmart sandbox/production credentials exist in this
 * codebase yet -- same caveat as the rest of this connector).
 *
 * v1 scope, deliberately narrow like Shopify's own createListing(): GTIN only
 * (no UPC/EAN/ISBN picker), condition fixed to "New" (no non-new conditions,
 * which would additionally need a main image URL this form doesn't collect).
 *
 * Not wrapped in withTenantAuth for the same reason the Shopify listings
 * route isn't -- see that file's own doc comment: this does a network round
 * trip to Walmart, and holding a Postgres transaction open for that isn't
 * appropriate. Each DB read/write below opens its own short-lived
 * withTenant() block instead.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const pool = getAppPool();
  const user = await requireCurrentUser(req, pool);
  if (!user) {
    return redirectWithError(req, "/products", "not signed in");
  }

  const formData = await req.formData();
  const productId = String(formData.get("productId") ?? "").trim();
  const price = String(formData.get("price") ?? "").trim();
  const gtin = String(formData.get("gtin") ?? "").trim();
  const shippingWeightLbsRaw = String(formData.get("shippingWeightLbs") ?? "").trim();
  const productCategory = String(formData.get("productCategory") ?? "").trim();

  if (!productId || !price || !gtin || !shippingWeightLbsRaw || !productCategory) {
    return redirectWithError(req, "/products", "walmart_listing_missing_fields");
  }
  if (!/^\d+(\.\d{1,2})?$/.test(price)) {
    return redirectWithError(req, "/products", "walmart_listing_invalid_price");
  }
  const shippingWeightLbs = Number(shippingWeightLbsRaw);
  if (!Number.isFinite(shippingWeightLbs) || shippingWeightLbs <= 0) {
    return redirectWithError(req, "/products", "walmart_listing_invalid_weight");
  }

  const product = await withTenant(pool, user.tenantId, (client) =>
    client.query<{ internal_sku: string }>(`SELECT internal_sku FROM products WHERE id = $1`, [productId]),
  );
  const productRow = product.rows[0];
  if (!productRow) {
    return redirectWithError(req, "/products", "walmart_listing_product_not_found");
  }

  // Same duplicate-submission guard as the Shopify route, for the same
  // reason: Offer Setup by Match has no natural idempotency key on our side
  // the way a *pulled-in* listing's (tenant_id, channel, channel_marketplace,
  // external_id) UNIQUE constraint gives a catalog-sync-discovered row.
  const existing = await withTenant(pool, user.tenantId, (client) =>
    client.query(
      `SELECT id FROM channel_listings WHERE tenant_id = $1 AND product_id = $2 AND channel = 'walmart'`,
      [user.tenantId, productId],
    ),
  );
  if (existing.rows.length > 0) {
    return redirectWithError(req, "/products", "walmart_listing_already_exists");
  }

  let connector;
  try {
    connector = await createWalmartConnectorFromChannelConnection(pool, user.tenantId);
  } catch (err) {
    return redirectWithError(req, "/products", `walmart_listing_no_connection:${errorMessage(err)}`);
  }

  const listing: NormalizedListing = {
    productId,
    channel: "walmart",
    channelMarketplace: "",
    externalSku: productRow.internal_sku,
    price,
    productIdentifier: { productIdType: "GTIN", productId: gtin },
    shippingWeightLbs,
    productCategory,
  };

  let feedId: string;
  try {
    const result = await connector.submitListing(listing);
    feedId = result.feedId;
  } catch (err) {
    return redirectWithError(req, "/products", `walmart_listing_submit_failed:${errorMessage(err)}`);
  }

  try {
    await withTenant(pool, user.tenantId, (client) =>
      client.query(
        // 'pending' (not 'draft'/'active') -- unlike Shopify's synchronous
        // productSet, submitListing() only proves the feed was ACCEPTED for
        // processing, not that Walmart actually matched/ingested the item.
        // The companion check-status route resolves this to 'active' or
        // 'error' once the feed finishes. external_id is set to the same
        // SKU as external_sku (not a distinct Walmart item id) because
        // that's genuinely all this flow knows back at submission time --
        // same "Walmart only knows its own SKU here" reasoning
        // pushInventory()'s own doc comment already documents.
        `INSERT INTO channel_listings
           (tenant_id, product_id, channel, channel_marketplace, external_id, external_sku, listing_status, list_price, raw_payload, last_synced_at)
         VALUES ($1, $2, 'walmart', '', $3, $3, 'pending', $4, $5, now())`,
        [user.tenantId, productId, productRow.internal_sku, price, JSON.stringify({ feedId, submittedAt: new Date().toISOString() })],
      ),
    );
  } catch (err) {
    // Walmart already has this feed queued even though our own record of it
    // failed to save -- surface that clearly, same "don't let a retry
    // double-submit" reasoning the Shopify route's own catch block
    // documents, though here a double-submit is a second feed rather than a
    // second product (Walmart's own match-by-SKU semantics make a resubmit
    // for the same SKU closer to idempotent than Shopify's productSet is).
    console.error(`Walmart offer feed ${feedId} submitted but channel_listings insert failed for tenant ${user.tenantId}:`, errorMessage(err));
    return redirectWithError(req, "/products", `walmart_listing_submitted_but_not_recorded:${feedId}`);
  }

  return redirectTo(req, "/products?walmart_listing_submitted=1");
}
