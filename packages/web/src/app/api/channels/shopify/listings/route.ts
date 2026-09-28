import type { NextRequest } from "next/server";
import { withTenant, recordAuditEvent } from "@alltix/db";
import { createShopifyConnectorFromChannelConnection } from "@alltix/channel-connectors";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";
import { checkRateLimit, RATE_LIMIT_ERROR_MESSAGE } from "@/lib/rate-limit";

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
 *
 * **Now extended for Shopify's own multi-store support** (CLAUDE.md
 * §4.5.5): a product can be listed on more than one of a tenant's
 * connected Shopify stores now, not just one total across all of them --
 * closing the gap §4.5.4's own store-picker left open (choosing which
 * store a listing went to, but still only ever letting a product have ONE
 * Shopify listing, period). /products' own per-connection rendering (see
 * that page's doc comment) means this route is always POSTed an explicit
 * `connectionId` whenever the tenant has more than one active Shopify
 * connection -- there's no longer a `<select>` here, since each connected
 * store gets its own inline "List on <store>" form instead of a dropdown.
 * `connectionId` is still read defensively as optional, though: with
 * exactly one active connection there's nothing to choose from, and an
 * empty/missing value resolves (below) to that one store, identical to
 * this route's original single-store behavior.
 *
 * The actual connection is resolved ONCE, up front, into `resolvedConnectionId`
 * -- not left to `createShopifyConnectorFromChannelConnection`'s own internal
 * fallback -- because this route now needs that concrete id for two things,
 * not one: which store's credentials to call Shopify with, AND which store
 * to stamp on the new `channel_listings.channel_connection_id` (migration
 * 0043) so a *second* store's own later listing attempt for the same
 * product can tell "already listed on THIS store" apart from "already
 * listed on a DIFFERENT store." A `connectionId` that doesn't resolve to an
 * active Shopify connection for this tenant (stale/tampered value, or a
 * connection that got disconnected between page load and submit) fails
 * loudly via `shopify_listing_no_connection:`, same as before.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const pool = getAppPool();
  const user = await requireCurrentUser(req, pool);
  if (!user) {
    return redirectWithError(req, "/products", "not signed in");
  }

  if (await checkRateLimit(pool, user.tenantId, "channels.shopify.listings")) {
    return redirectWithError(req, "/products", RATE_LIMIT_ERROR_MESSAGE);
  }

  const formData = await req.formData();
  const productId = String(formData.get("productId") ?? "").trim();
  const price = String(formData.get("price") ?? "").trim();
  // Optional -- see this route's own doc comment above. Empty/absent
  // resolves (below) to "the tenant's one active Shopify connection," the
  // pre-existing single-store default.
  const requestedConnectionId = String(formData.get("connectionId") ?? "").trim() || null;

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

  // Resolve the actual connection ONCE, up front -- see this route's own
  // doc comment for why this can't just be left to
  // createShopifyConnectorFromChannelConnection's own internal fallback.
  // Mirrors loadShopifyCredentialsFromChannelConnection's own
  // "$1::uuid IS NULL OR id = $1" resolution exactly, so "omitted" behaves
  // identically here and there.
  const connectionResult = await withTenant(pool, user.tenantId, (client) =>
    client.query<{ id: string }>(
      `SELECT id FROM channel_connections
        WHERE tenant_id = $1 AND channel = 'shopify' AND status = 'active'
          AND ($2::uuid IS NULL OR id = $2)
        ORDER BY created_at DESC
        LIMIT 1`,
      [user.tenantId, requestedConnectionId],
    ),
  );
  const resolvedConnectionId = connectionResult.rows[0]?.id;
  if (!resolvedConnectionId) {
    return redirectWithError(req, "/products", `shopify_listing_no_connection:No active 'shopify' channel_connections row found for tenant ${user.tenantId}`);
  }

  // Guard against double-submitting this form and creating two separate
  // products on Shopify for the same internal product on the same store --
  // productSet with no `identifier` always creates new, it doesn't upsert
  // by SKU the way channel_listings' own (tenant_id, channel,
  // channel_marketplace, external_id) UNIQUE constraint would otherwise
  // make this idempotent for a *pulled-in* listing (add-channel-listing.ts,
  // catalog sync). An outbound creation has no such natural dedupe key
  // before it's created.
  //
  // Scoped by channel_connection_id (migration 0043), not just
  // (tenant_id, product_id, channel) -- CLAUDE.md §4.5.5's whole point is
  // that a product CAN now have a real listing on one store and still be
  // creatable on a different one. `channel_connection_id IS NULL` also
  // blocks, deliberately conservative: a legacy row from before this
  // column existed has no recorded store, so there's no way to prove it
  // ISN'T already the listing this exact store would create -- same
  // "fail loud rather than risk a silent duplicate" reasoning this route
  // already applied to the create-vs-upsert distinction above.
  const existing = await withTenant(pool, user.tenantId, (client) =>
    client.query(
      `SELECT id FROM channel_listings
        WHERE tenant_id = $1 AND product_id = $2 AND channel = 'shopify'
          AND (channel_connection_id = $3 OR channel_connection_id IS NULL)`,
      [user.tenantId, productId, resolvedConnectionId],
    ),
  );
  if (existing.rows.length > 0) {
    return redirectWithError(req, "/products", "shopify_listing_already_exists");
  }

  let connector;
  try {
    connector = await createShopifyConnectorFromChannelConnection(pool, user.tenantId, resolvedConnectionId);
  } catch (err) {
    return redirectWithError(req, "/products", `shopify_listing_no_connection:${errorMessage(err)}`);
  }

  const result = await connector.createListing({ internalSku: productRow.internal_sku, title: productRow.name, price });
  if (!result.success || !result.inventoryItemGid) {
    return redirectWithError(req, "/products", `shopify_listing_create_failed:${result.error ?? "unknown error"}`);
  }

  try {
    await withTenant(pool, user.tenantId, async (client) => {
      // 'draft' (not 'active') is deliberate -- see createListing()'s own
      // doc comment: this only creates the product on Shopify, it doesn't
      // publish it to a sales channel yet, so it isn't actually live/
      // visible until the tenant does that one manual step in their own
      // Shopify admin.
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO channel_listings
           (tenant_id, product_id, channel, channel_marketplace, external_id, external_sku, listing_status, list_price, last_synced_at, channel_connection_id)
         VALUES ($1, $2, 'shopify', '', $3, $4, 'draft', $5, now(), $6)
         RETURNING id`,
        [user.tenantId, productId, result.inventoryItemGid, productRow.internal_sku, price, resolvedConnectionId],
      );
      // Same CLAUDE.md §17 "channel_listing.created" instrumentation as the
      // Amazon/eBay/Walmart listings routes -- see Amazon's own comment.
      await recordAuditEvent(client, {
        tenantId: user.tenantId,
        userId: user.id,
        action: "channel_listing.created",
        entityType: "channel_listing",
        entityId: inserted.rows[0]!.id,
        details: { channel: "shopify", productId, sellerSku: productRow.internal_sku, status: "draft", connectionId: resolvedConnectionId },
      });
    });
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
