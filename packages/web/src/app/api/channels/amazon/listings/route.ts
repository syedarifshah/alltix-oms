import type { NextRequest } from "next/server";
import { withTenant } from "@alltix/db";
import { createAmazonConnectorFromChannelConnection } from "@alltix/channel-connectors";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

/**
 * POST /api/channels/amazon/listings -- the outbound "offer this product on
 * Amazon" flow's entry point, submitted from the /products page's per-product
 * form. Mirrors the Shopify/Walmart listings routes' role, but the
 * underlying write is narrower than either: AmazonConnector.createListing()
 * is offer-only (requirements: "LISTING_OFFER_ONLY") -- it attaches a new
 * seller offer to an EXISTING Amazon catalog item the tenant identifies by
 * ASIN, not a brand-new item the way Shopify's flow creates one, and not
 * barcode-matched the way Walmart's flow is (Amazon's own barcode-matching
 * attribute, externally_assigned_product_identifier, wasn't confirmed
 * against a literal example during research and isn't implemented -- see
 * AmazonConnector.createListing()'s own doc comment). Unlike Walmart's
 * asynchronous feed submission, this is a synchronous call: the same request
 * that submits the offer also returns whether Amazon accepted it, so there's
 * no separate "check status" route the way Walmart's flow needs one.
 *
 * Not wrapped in withTenantAuth for the same reason the Shopify/Walmart
 * listings routes aren't -- this does a network round trip to Amazon, and
 * holding a Postgres transaction open for that isn't appropriate. Each DB
 * read/write below opens its own short-lived withTenant() block instead.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const pool = getAppPool();
  const user = await requireCurrentUser(req, pool);
  if (!user) {
    return redirectWithError(req, "/products", "not signed in");
  }

  const formData = await req.formData();
  const productId = String(formData.get("productId") ?? "").trim();
  const asin = String(formData.get("asin") ?? "").trim();
  const price = String(formData.get("price") ?? "").trim();

  if (!productId || !asin || !price) {
    return redirectWithError(req, "/products", "amazon_listing_missing_fields");
  }
  if (!/^\d+(\.\d{1,2})?$/.test(price)) {
    return redirectWithError(req, "/products", "amazon_listing_invalid_price");
  }

  const product = await withTenant(pool, user.tenantId, (client) =>
    client.query<{ internal_sku: string }>(`SELECT internal_sku FROM products WHERE id = $1`, [productId]),
  );
  const productRow = product.rows[0];
  if (!productRow) {
    return redirectWithError(req, "/products", "amazon_listing_product_not_found");
  }

  // Same duplicate-submission guard as the Shopify/Walmart routes.
  const existing = await withTenant(pool, user.tenantId, (client) =>
    client.query(
      `SELECT id FROM channel_listings WHERE tenant_id = $1 AND product_id = $2 AND channel = 'amazon'`,
      [user.tenantId, productId],
    ),
  );
  if (existing.rows.length > 0) {
    return redirectWithError(req, "/products", "amazon_listing_already_exists");
  }

  let connector;
  try {
    connector = await createAmazonConnectorFromChannelConnection(pool, user.tenantId);
  } catch (err) {
    return redirectWithError(req, "/products", `amazon_listing_no_connection:${errorMessage(err)}`);
  }

  // Same "seed with this tenant's real current stock" reasoning the
  // Shopify route documents -- here it's one field of the same PUT rather
  // than a separate follow-up call, since createListing()'s request already
  // carries fulfillment_availability.
  const inventory = await withTenant(pool, user.tenantId, (client) =>
    client.query<{ total_available: string }>(
      `SELECT COALESCE(SUM(available), 0) AS total_available FROM inventory_levels WHERE product_id = $1`,
      [productId],
    ),
  );
  const quantity = Number(inventory.rows[0]?.total_available ?? 0);

  const result = await connector.createListing({
    asin,
    sellerSku: productRow.internal_sku,
    price,
    quantity,
  });
  if (!result.success) {
    return redirectWithError(req, "/products", `amazon_listing_create_failed:${result.error ?? "unknown error"}`);
  }

  try {
    await withTenant(pool, user.tenantId, (client) =>
      client.query(
        // 'active' here (unlike Walmart's 'pending') because this call is
        // synchronous -- a success response means Amazon accepted the offer
        // submission in the same request, not just queued it for later
        // processing the way Walmart's feed is. external_id/external_sku
        // both hold the seller SKU (same "channel only knows its own SKU"
        // convention pushInventory()'s own doc comment documents) --
        // raw_payload records the ASIN this offer was attached to, since
        // that's not stored anywhere else on this row.
        `INSERT INTO channel_listings
           (tenant_id, product_id, channel, channel_marketplace, external_id, external_sku, listing_status, list_price, raw_payload, last_synced_at)
         VALUES ($1, $2, 'amazon', '', $3, $3, 'active', $4, $5, now())`,
        [user.tenantId, productId, productRow.internal_sku, price, JSON.stringify({ asin })],
      ),
    );
  } catch (err) {
    // Amazon already has this offer live even though our own record of it
    // failed to save -- surface that clearly, same reasoning the Shopify/
    // Walmart routes' own catch blocks document.
    console.error(`Amazon offer created (asin ${asin}) but channel_listings insert failed for tenant ${user.tenantId}:`, errorMessage(err));
    return redirectWithError(req, "/products", `amazon_listing_created_but_not_recorded:${asin}`);
  }

  return redirectTo(req, "/products?amazon_listing_created=1");
}
