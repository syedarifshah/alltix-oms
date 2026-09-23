import type { NextRequest } from "next/server";
import { withTenant } from "@alltix/db";
import { createEbayConnectorFromChannelConnection } from "@alltix/channel-connectors";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";
import { checkRateLimit, RATE_LIMIT_ERROR_MESSAGE } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * POST /api/channels/ebay/listings -- the outbound "list this product on
 * eBay" flow's entry point, submitted from the /products page's per-product
 * form once /settings/channels' eBay Selling Setup is complete (business
 * policies + merchant location -- see EbayConnector.createListing()'s own
 * fail-fast check for what happens if it isn't). Mirrors the Amazon/
 * Shopify/Walmart listings routes' role and structure exactly; like
 * Amazon's, this is a synchronous call (createOrReplaceInventoryItem ->
 * createOffer -> publishOffer all happen inside one createListing() call),
 * so there's no separate "check status" route the way Walmart's
 * asynchronous feed submission needs one.
 *
 * Not wrapped in withTenantAuth for the same reason the other three
 * listings routes aren't -- this makes up to three real network round
 * trips to eBay, and holding a Postgres transaction open for that isn't
 * appropriate. Each DB read/write below opens its own short-lived
 * withTenant() block instead.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const pool = getAppPool();
  const user = await requireCurrentUser(req, pool);
  if (!user) {
    return redirectWithError(req, "/products", "not signed in");
  }

  if (await checkRateLimit(pool, user.tenantId, "channels.ebay.listings")) {
    return redirectWithError(req, "/products", RATE_LIMIT_ERROR_MESSAGE);
  }

  const formData = await req.formData();
  const productId = String(formData.get("productId") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const imageUrl = String(formData.get("imageUrl") ?? "").trim();
  const categoryId = String(formData.get("categoryId") ?? "").trim();
  const price = String(formData.get("price") ?? "").trim();

  if (!productId || !title || !description || !imageUrl || !categoryId || !price) {
    return redirectWithError(req, "/products", "ebay_listing_missing_fields");
  }
  if (!/^\d+(\.\d{1,2})?$/.test(price)) {
    return redirectWithError(req, "/products", "ebay_listing_invalid_price");
  }

  const product = await withTenant(pool, user.tenantId, (client) =>
    client.query<{ internal_sku: string }>(`SELECT internal_sku FROM products WHERE id = $1`, [productId]),
  );
  const productRow = product.rows[0];
  if (!productRow) {
    return redirectWithError(req, "/products", "ebay_listing_product_not_found");
  }

  // Same duplicate-submission guard as the Amazon/Shopify/Walmart routes.
  const existing = await withTenant(pool, user.tenantId, (client) =>
    client.query(
      `SELECT id FROM channel_listings WHERE tenant_id = $1 AND product_id = $2 AND channel = 'ebay'`,
      [user.tenantId, productId],
    ),
  );
  if (existing.rows.length > 0) {
    return redirectWithError(req, "/products", "ebay_listing_already_exists");
  }

  let connector;
  try {
    connector = await createEbayConnectorFromChannelConnection(pool, user.tenantId);
  } catch (err) {
    return redirectWithError(req, "/products", `ebay_listing_no_connection:${errorMessage(err)}`);
  }

  // Same "seed with this tenant's real current stock" reasoning the
  // Amazon/Shopify routes document.
  const inventory = await withTenant(pool, user.tenantId, (client) =>
    client.query<{ total_available: string }>(
      `SELECT COALESCE(SUM(available), 0) AS total_available FROM inventory_levels WHERE product_id = $1`,
      [productId],
    ),
  );
  const quantity = Number(inventory.rows[0]?.total_available ?? 0);

  const result = await connector.createListing({
    sellerSku: productRow.internal_sku,
    title,
    description,
    imageUrl,
    categoryId,
    price,
    quantity,
  });
  if (!result.success) {
    return redirectWithError(req, "/products", `ebay_listing_create_failed:${result.error ?? "unknown error"}`);
  }

  try {
    await withTenant(pool, user.tenantId, (client) =>
      client.query(
        // 'active' here, same reasoning as Amazon's own insert -- this call
        // is synchronous, a success response means eBay already published
        // the listing in the same request, not just queued it. external_id
        // holds the real eBay listingId (unlike Amazon's, which has none to
        // offer and reuses the SKU); external_sku holds the seller SKU.
        // raw_payload records categoryId/imageUrl since neither is stored
        // anywhere else on this row.
        `INSERT INTO channel_listings
           (tenant_id, product_id, channel, channel_marketplace, external_id, external_sku, listing_status, list_price, raw_payload, last_synced_at)
         VALUES ($1, $2, 'ebay', '', $3, $4, 'active', $5, $6, now())`,
        [
          user.tenantId,
          productId,
          result.listingId,
          productRow.internal_sku,
          price,
          JSON.stringify({ categoryId, imageUrl }),
        ],
      ),
    );
  } catch (err) {
    // eBay already has this listing live even though our own record of it
    // failed to save -- surface that clearly, same reasoning the Amazon/
    // Shopify/Walmart routes' own catch blocks document.
    console.error(`eBay listing created (listingId ${result.listingId}) but channel_listings insert failed for tenant ${user.tenantId}:`, errorMessage(err));
    return redirectWithError(req, "/products", `ebay_listing_created_but_not_recorded:${result.listingId}`);
  }

  return redirectTo(req, "/products?ebay_listing_created=1");
}
