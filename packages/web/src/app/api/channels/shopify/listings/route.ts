import type { NextRequest } from "next/server";
import { withTenant } from "@alltix/db";
import { createShopifyConnectorFromChannelConnection } from "@alltix/channel-connectors";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

/**
 * POST /api/channels/shopify/listings -- the "create a new listing" outbound
 * flow's entry point, submitted from the /products page's per-product form.
 * Takes an existing internal product and a price, creates a brand-new
 * product on the tenant's connected Shopify store (ShopifyConnector.
 * createListing -- see its own doc comment for exactly what v1 does and
 * deliberately doesn't do, e.g. no sales-channel publish step yet), records
 * the result as a channel_listings row, and best-effort syncs the product's
 * current internal available-to-sell quantity as the new listing's starting
 * stock.
 *
 * Not wrapped in withTenantAuth for the same reason /api/channels/shopify/
 * connect isn't: this handler's real work is a network round trip to
 * Shopify, and holding a Postgres transaction open for the duration of that
 * call is exactly what withTenantAuth's own doc comment warns against.
 * requireCurrentUser resolves auth/tenant without opening one; each DB read/
 * write below opens its own short-lived withTenant() block instead.
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

  if (!productId || !price) {
    return redirectWithError(req, "/products", "shopify_listing_missing_fields");
  }
  if (!/^\d+(\.\d{1,2})?$/.test(price)) {
    return redirectWithError(req, "/products", "shopify_listing_invalid_price");
  }

  const product = await withTenant(pool, user.tenantId, (client) =>
    client.query<{ internal_sku: string; name: string }>(
      `SELECT internal_sku, name FROM products WHERE id = $1`,
      [productId],
    ),
  );
  const productRow = product.rows[0];
  if (!productRow) {
    return redirectWithError(req, "/products", "shopify_listing_product_not_found");
  }

  // Guard against double-submitting this form and creating two separate
  // products on Shopify for the same internal product -- productSet with no
  // `identifier` always creates new, it doesn't upsert by SKU the way
  // channel_listings' own (tenant_id, channel, channel_marketplace,
  // external_id) UNIQUE constraint would otherwise make this idempotent for
  // a *pulled-in* listing (add-channel-listing.ts, catalog sync). An
  // outbound creation has no such natural dedupe key before it's created.
  const existing = await withTenant(pool, user.tenantId, (client) =>
    client.query(
      `SELECT id FROM channel_listings WHERE tenant_id = $1 AND product_id = $2 AND channel = 'shopify'`,
      [user.tenantId, productId],
    ),
  );
  if (existing.rows.length > 0) {
    return redirectWithError(req, "/products", "shopify_listing_already_exists");
  }

  let connector;
  try {
    connector = await createShopifyConnectorFromChannelConnection(pool, user.tenantId);
  } catch (err) {
    return redirectWithError(req, "/products", `shopify_listing_no_connection:${errorMessage(err)}`);
  }

  const result = await connector.createListing({ internalSku: productRow.internal_sku, title: productRow.name, price });
  if (!result.success || !result.inventoryItemGid) {
    return redirectWithError(req, "/products", `shopify_listing_create_failed:${result.error ?? "unknown error"}`);
  }

  try {
    await withTenant(pool, user.tenantId, (client) =>
      client.query(
        // 'draft' (not 'active') is deliberate -- see createListing()'s own
        // doc comment: this only creates the product on Shopify, it doesn't
        // publish it to a sales channel yet, so it isn't actually live/
        // visible until the tenant does that one manual step in their own
        // Shopify admin.
        `INSERT INTO channel_listings
           (tenant_id, product_id, channel, channel_marketplace, external_id, external_sku, listing_status, list_price, last_synced_at)
         VALUES ($1, $2, 'shopify', '', $3, $4, 'draft', $5, now())`,
        [user.tenantId, productId, result.inventoryItemGid, productRow.internal_sku, price],
      ),
    );
  } catch (err) {
    // The Shopify-side product now exists even though this write failed --
    // surface that clearly rather than a generic error, since a retry from
    // /products would otherwise try to create a *second* Shopify product.
    console.error(`Shopify listing created (${result.productGid}) but channel_listings insert failed for tenant ${user.tenantId}:`, errorMessage(err));
    return redirectWithError(
      req,
      "/products",
      `shopify_listing_created_but_not_recorded:${result.productGid ?? "unknown"}`,
    );
  }

  // Best-effort starting-stock sync -- this app's own inventory_levels is
  // the source of truth (CLAUDE.md §1), so the new listing's stock should
  // start at whatever this tenant already has on hand, not at Shopify's
  // default (0). Failing here doesn't undo the listing: it was already
  // created and recorded above, and pushInventory can be retried by hand or
  // (once wired to a real trigger -- still a documented gap, see CLAUDE.md
  // §4.5) automatically later.
  try {
    const inventory = await withTenant(pool, user.tenantId, (client) =>
      client.query<{ total_available: string }>(
        `SELECT COALESCE(SUM(available), 0) AS total_available FROM inventory_levels WHERE product_id = $1`,
        [productId],
      ),
    );
    const totalAvailable = Number(inventory.rows[0]?.total_available ?? 0);
    const pushResult = await connector.pushInventory(productRow.internal_sku, totalAvailable);
    if (!pushResult.success) {
      console.error(`Shopify listing created but starting-stock push failed for tenant ${user.tenantId}, sku ${productRow.internal_sku}:`, pushResult.error);
    }
  } catch (err) {
    console.error(`Shopify listing created but starting-stock push threw for tenant ${user.tenantId}, sku ${productRow.internal_sku}:`, errorMessage(err));
  }

  return redirectTo(req, "/products?shopify_listing_created=1");
}
