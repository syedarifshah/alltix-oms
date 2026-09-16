import type { ReactElement } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { withTenant } from "@alltix/db";
import { getAppPool } from "@/lib/db";
import { getAuthContext } from "@/lib/auth-context";
import { resolveTenantId } from "@/lib/with-tenant-auth";

export const dynamic = "force-dynamic";

interface ProductRow {
  id: string;
  internal_sku: string;
  name: string;
  shopify_listing_status: string | null;
  shopify_list_price: string | null;
  shopify_external_sku: string | null;
  walmart_listing_id: string | null;
  walmart_listing_status: string | null;
  walmart_list_price: string | null;
  walmart_raw_payload: { feedId?: string; error?: string | null } | null;
  amazon_listing_status: string | null;
  amazon_list_price: string | null;
  amazon_raw_payload: { asin?: string } | null;
  ebay_listing_status: string | null;
  ebay_listing_id: string | null;
  ebay_list_price: string | null;
}

interface ProductsPageProps {
  searchParams: Promise<{
    error?: string;
    shopify_listing_created?: string;
    product_created?: string;
    walmart_listing_submitted?: string;
    walmart_listing_still_processing?: string;
    walmart_listing_status_checked?: string;
    amazon_listing_created?: string;
    ebay_listing_created?: string;
  }>;
}

/**
 * Internal product catalog, with the outbound "create a listing on Shopify"
 * action per product (CLAUDE.md §4.5's "Not implemented" gap, closed here
 * for Shopify specifically -- POSTs to /api/channels/shopify/listings,
 * which calls ShopifyConnector.createListing()). This is the first page in
 * the app that reads `products` directly rather than through
 * `inventory_levels` (see /inventory's own doc comment) -- a product with
 * no location/inventory_levels row yet (freshly created via POST
 * /api/products, never received any stock) still needs to show up here to
 * be listed, which /inventory's inner-joined view would silently exclude.
 *
 * Same auth/tenant pattern as every other page in this app -- see
 * src/app/orders/page.tsx's doc comment.
 */
export default async function ProductsPage({ searchParams }: ProductsPageProps): Promise<ReactElement> {
  const authContext = await getAuthContext(await headers());
  if (!authContext) {
    redirect("/sign-in");
  }

  const pool = getAppPool();
  const tenantId = await resolveTenantId(pool, authContext.clerkUserId);
  const {
    error,
    shopify_listing_created: shopifyListingCreated,
    product_created: productCreated,
    walmart_listing_submitted: walmartListingSubmitted,
    walmart_listing_still_processing: walmartListingStillProcessing,
    walmart_listing_status_checked: walmartListingStatusChecked,
    amazon_listing_created: amazonListingCreated,
    ebay_listing_created: ebayListingCreated,
  } = await searchParams;

  if (!tenantId) {
    return (
      <main className="page">
        <h1>Products</h1>
        <p>No tenant is associated with this account yet.</p>
      </main>
    );
  }

  const {
    products,
    hasActiveShopifyConnection,
    hasActiveWalmartConnection,
    hasActiveAmazonConnection,
    hasEbaySellingSetup,
  } = await withTenant(pool, tenantId, async (client) => {
      const productsResult = await client.query<ProductRow>(
        `SELECT p.id, p.internal_sku, p.name,
                cl.listing_status AS shopify_listing_status,
                cl.list_price AS shopify_list_price,
                cl.external_sku AS shopify_external_sku,
                cw.id AS walmart_listing_id,
                cw.listing_status AS walmart_listing_status,
                cw.list_price AS walmart_list_price,
                cw.raw_payload AS walmart_raw_payload,
                ca.listing_status AS amazon_listing_status,
                ca.list_price AS amazon_list_price,
                ca.raw_payload AS amazon_raw_payload,
                ce.listing_status AS ebay_listing_status,
                ce.external_id AS ebay_listing_id,
                ce.list_price AS ebay_list_price
           FROM products p
           LEFT JOIN channel_listings cl
             ON cl.product_id = p.id AND cl.tenant_id = p.tenant_id AND cl.channel = 'shopify'
           LEFT JOIN channel_listings cw
             ON cw.product_id = p.id AND cw.tenant_id = p.tenant_id AND cw.channel = 'walmart'
           LEFT JOIN channel_listings ca
             ON ca.product_id = p.id AND ca.tenant_id = p.tenant_id AND ca.channel = 'amazon'
           LEFT JOIN channel_listings ce
             ON ce.product_id = p.id AND ce.tenant_id = p.tenant_id AND ce.channel = 'ebay'
          ORDER BY p.internal_sku`,
      );
      const shopifyConnectionResult = await client.query(
        `SELECT 1 FROM channel_connections WHERE channel = 'shopify' AND status = 'active' LIMIT 1`,
      );
      const walmartConnectionResult = await client.query(
        `SELECT 1 FROM channel_connections WHERE channel = 'walmart' AND status = 'active' LIMIT 1`,
      );
      const amazonConnectionResult = await client.query(
        `SELECT 1 FROM channel_connections WHERE channel = 'amazon' AND status = 'active' LIMIT 1`,
      );
      // Unlike the other three channels, "can this tenant list on eBay"
      // isn't just "is there an active connection" -- EbayConnector.
      // createListing() also needs all four Selling Setup columns
      // (migration 0026) filled in, so this checks for those directly
      // rather than duplicating hasActiveEbayConnection AND a separate
      // flag the way /settings/channels' own hasEbaySellingSetup does.
      const ebaySellingSetupResult = await client.query(
        `SELECT 1 FROM channel_connections
          WHERE channel = 'ebay' AND status = 'active'
            AND ebay_fulfillment_policy_id IS NOT NULL
            AND ebay_payment_policy_id IS NOT NULL
            AND ebay_return_policy_id IS NOT NULL
            AND ebay_merchant_location_key IS NOT NULL
          LIMIT 1`,
      );
      return {
        products: productsResult.rows,
        hasActiveShopifyConnection: shopifyConnectionResult.rows.length > 0,
        hasActiveWalmartConnection: walmartConnectionResult.rows.length > 0,
        hasActiveAmazonConnection: amazonConnectionResult.rows.length > 0,
        hasEbaySellingSetup: ebaySellingSetupResult.rows.length > 0,
      };
    });

  return (
    <main className="page">
      <h1>Products</h1>
      <p className="subtitle">
        Your internal catalog — push any of these out as a new Shopify listing. Pulling existing Shopify products in
        works the other way (Settings → Channels' automatic catalog sync); this is for creating a listing that
        doesn&apos;t exist on Shopify yet.
      </p>

      {shopifyListingCreated === "1" && (
        <div className="alert alert-success">
          Shopify listing created (status: draft — publish it from your Shopify admin to make it visible on your
          storefront). Starting stock was synced from your current available-to-sell quantity.
        </div>
      )}
      {productCreated === "1" && <div className="alert alert-success">Product added to your catalog.</div>}
      {walmartListingSubmitted === "1" && (
        <div className="alert alert-success">
          Offer submitted to Walmart (status: pending). Walmart processes feeds asynchronously — use the &quot;Check
          status&quot; button once you&apos;ve given it a few minutes to see whether it was accepted.
        </div>
      )}
      {walmartListingStillProcessing === "1" && (
        <div className="alert alert-info">Walmart is still processing this feed — check back again shortly.</div>
      )}
      {walmartListingStatusChecked === "1" && <div className="alert alert-success">Walmart listing status updated.</div>}
      {amazonListingCreated === "1" && (
        <div className="alert alert-success">
          Offer attached to the given ASIN and live on Amazon (this call is synchronous, unlike Walmart&apos;s feed —
          no &quot;check status&quot; step needed). Starting stock was synced from your current available-to-sell
          quantity.
        </div>
      )}
      {ebayListingCreated === "1" && (
        <div className="alert alert-success">
          Listing created and published on eBay (this call is synchronous, same as Amazon&apos;s offer above — no
          &quot;check status&quot; step needed). Starting stock was synced from your current available-to-sell
          quantity.
        </div>
      )}
      {error && <div className="alert alert-danger">{describeError(error)}</div>}

      <details className="stack" style={{ marginBottom: 16 }}>
        <summary>Add a product</summary>
        {/* Every existing product so far arrived via catalog sync or order persistence --
            this is the only way to get a brand-new internal product into the catalog on
            purpose, e.g. specifically to try the "List on Shopify" flow below on it. */}
        <form action="/api/products/create" method="POST" className="row" style={{ gap: 6, marginTop: 8 }}>
          <input type="text" name="internalSku" placeholder="internal-sku-001" required />
          <input type="text" name="name" placeholder="Product name" required />
          <button type="submit">Add product</button>
        </form>
      </details>

      {!hasActiveShopifyConnection && (
        <div className="alert alert-info">
          No active Shopify connection — connect one on the{" "}
          <a href="/settings/channels">Channels settings page</a> before creating a listing.
        </div>
      )}
      {!hasActiveWalmartConnection && (
        <div className="alert alert-info">
          No active Walmart connection — connect one on the{" "}
          <a href="/settings/channels">Channels settings page</a> before submitting an offer.
        </div>
      )}
      {!hasActiveAmazonConnection && (
        <div className="alert alert-info">
          No active Amazon connection — connect one on the{" "}
          <a href="/settings/channels">Channels settings page</a> before attaching an offer to an ASIN.
        </div>
      )}
      {!hasEbaySellingSetup && (
        <div className="alert alert-info">
          No active eBay connection with a completed Selling Setup (business policies + merchant location) —
          finish that on the <a href="/settings/channels">Channels settings page</a> before creating a listing.
        </div>
      )}

      {products.length === 0 ? (
        <p className="empty">No products yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>SKU</th>
                <th>Name</th>
                <th>Shopify</th>
                <th>Walmart</th>
                <th>Amazon</th>
                <th>eBay</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <tr key={product.id}>
                  <td className="mono">{product.internal_sku}</td>
                  <td>{product.name}</td>
                  <td>
                    {product.shopify_listing_status ? (
                      <div className="stack">
                        <span className={product.shopify_listing_status === "active" ? "badge badge-success" : "badge"}>
                          {product.shopify_listing_status}
                        </span>
                        <span className="muted">
                          sku {product.shopify_external_sku}
                          {product.shopify_list_price ? ` · $${product.shopify_list_price}` : ""}
                        </span>
                      </div>
                    ) : hasActiveShopifyConnection ? (
                      <CreateListingForm productId={product.id} />
                    ) : (
                      <span className="muted">not listed</span>
                    )}
                  </td>
                  <td>
                    {product.walmart_listing_status ? (
                      <div className="stack">
                        <span
                          className={
                            product.walmart_listing_status === "active"
                              ? "badge badge-success"
                              : product.walmart_listing_status === "error"
                                ? "badge badge-danger"
                                : "badge"
                          }
                        >
                          {product.walmart_listing_status}
                        </span>
                        <span className="muted">
                          sku {product.internal_sku}
                          {product.walmart_list_price ? ` · $${product.walmart_list_price}` : ""}
                        </span>
                        {product.walmart_listing_status === "error" && product.walmart_raw_payload?.error && (
                          <span className="muted">{product.walmart_raw_payload.error}</span>
                        )}
                        {product.walmart_listing_status === "pending" && product.walmart_listing_id && (
                          <form
                            action={`/api/channels/walmart/listings/${product.walmart_listing_id}/check-status`}
                            method="POST"
                          >
                            <button type="submit">Check status</button>
                          </form>
                        )}
                      </div>
                    ) : hasActiveWalmartConnection ? (
                      <CreateWalmartListingForm productId={product.id} />
                    ) : (
                      <span className="muted">not listed</span>
                    )}
                  </td>
                  <td>
                    {product.amazon_listing_status ? (
                      <div className="stack">
                        <span className={product.amazon_listing_status === "active" ? "badge badge-success" : "badge"}>
                          {product.amazon_listing_status}
                        </span>
                        <span className="muted">
                          sku {product.internal_sku}
                          {product.amazon_list_price ? ` · $${product.amazon_list_price}` : ""}
                          {product.amazon_raw_payload?.asin ? ` · asin ${product.amazon_raw_payload.asin}` : ""}
                        </span>
                      </div>
                    ) : hasActiveAmazonConnection ? (
                      <CreateAmazonListingForm productId={product.id} />
                    ) : (
                      <span className="muted">not listed</span>
                    )}
                  </td>
                  <td>
                    {product.ebay_listing_status ? (
                      <div className="stack">
                        <span className={product.ebay_listing_status === "active" ? "badge badge-success" : "badge"}>
                          {product.ebay_listing_status}
                        </span>
                        <span className="muted">
                          sku {product.internal_sku}
                          {product.ebay_list_price ? ` · $${product.ebay_list_price}` : ""}
                          {product.ebay_listing_id ? ` · listing ${product.ebay_listing_id}` : ""}
                        </span>
                      </div>
                    ) : hasEbaySellingSetup ? (
                      <CreateEbayListingForm productId={product.id} />
                    ) : (
                      <span className="muted">not listed</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

/** Plain HTML form, no client JS -- CLAUDE.md's Next.js conventions call for
 *  <form action method="POST"> submissions, same pattern as every other
 *  mutation form in this app (e.g. /settings/channels' ShopifyConnectForm,
 *  /rules' "New rule" form). */
function CreateListingForm({ productId }: { productId: string }): ReactElement {
  return (
    <form action="/api/channels/shopify/listings" method="POST" className="row" style={{ gap: 6 }}>
      <input type="hidden" name="productId" value={productId} />
      <input type="text" name="price" placeholder="19.99" required style={{ width: 80 }} />
      <button type="submit">List on Shopify</button>
    </form>
  );
}

/** Plain HTML form, no client JS -- see CreateListingForm's own comment for
 *  why. More fields than Shopify's equivalent form because Offer Setup by
 *  Match genuinely needs more from the tenant: a GTIN to match against an
 *  existing Walmart catalog item (Shopify's createListing() makes a brand
 *  new item and needs no such identifier), a shipping weight, and a product
 *  category -- see /api/channels/walmart/listings' own doc comment.
 *  Condition is fixed to "New" server-side (v1 scope), no field for it here. */
function CreateWalmartListingForm({ productId }: { productId: string }): ReactElement {
  return (
    <form action="/api/channels/walmart/listings" method="POST" className="stack" style={{ gap: 6 }}>
      <input type="hidden" name="productId" value={productId} />
      <input type="text" name="gtin" placeholder="GTIN" required style={{ width: 120 }} />
      <input type="text" name="price" placeholder="19.99" required style={{ width: 80 }} />
      <input type="text" name="shippingWeightLbs" placeholder="weight (lb)" required style={{ width: 100 }} />
      <input type="text" name="productCategory" placeholder="category" required style={{ width: 120 }} />
      <button type="submit">Submit offer to Walmart</button>
    </form>
  );
}

/** Plain HTML form, no client JS -- see CreateListingForm's own comment for
 *  why. Unlike Shopify's/Walmart's forms, this one needs an ASIN, not a SKU
 *  or GTIN: AmazonConnector.createListing() is offer-only (v1 scope) -- it
 *  attaches a new seller offer to an EXISTING Amazon catalog item identified
 *  by ASIN, rather than creating a brand-new item the way Shopify's flow
 *  does or matching by barcode the way Walmart's flow does. Condition is
 *  fixed to "new_new" server-side, no field for it here -- see
 *  AmazonConnector.createListing()'s own doc comment. */
function CreateAmazonListingForm({ productId }: { productId: string }): ReactElement {
  return (
    <form action="/api/channels/amazon/listings" method="POST" className="row" style={{ gap: 6 }}>
      <input type="hidden" name="productId" value={productId} />
      <input type="text" name="asin" placeholder="ASIN" required style={{ width: 110 }} />
      <input type="text" name="price" placeholder="19.99" required style={{ width: 80 }} />
      <button type="submit">Attach Amazon offer</button>
    </form>
  );
}

/** Plain HTML form, no client JS -- see CreateListingForm's own comment for
 *  why. Unlike every other channel's form here, this one creates a
 *  brand-new eBay item AND needs two fields no other channel's form
 *  collects: categoryId and imageUrl, both plain tenant-supplied values
 *  with no lookup/validation on this app's side (see
 *  EbayListingSubmission's own doc comment in ebay-connector.ts for why --
 *  eBay's category taxonomy and this codebase's total lack of an
 *  image-hosting feature are each their own real, deliberately
 *  out-of-scope pieces of work). Only rendered once /settings/channels'
 *  eBay Selling Setup (business policies + merchant location) is complete
 *  -- see hasEbaySellingSetup above -- since EbayConnector.createListing()
 *  fails fast without it anyway; this just avoids showing a form that's
 *  guaranteed to fail. Condition is fixed to "NEW" server-side, no field
 *  for it here, same v1 scope as every other channel's own form. */
function CreateEbayListingForm({ productId }: { productId: string }): ReactElement {
  return (
    <form action="/api/channels/ebay/listings" method="POST" className="stack" style={{ gap: 6 }}>
      <input type="hidden" name="productId" value={productId} />
      <input type="text" name="title" placeholder="Listing title" required style={{ width: 160 }} />
      <input type="text" name="description" placeholder="Description" required style={{ width: 160 }} />
      <input type="text" name="imageUrl" placeholder="Image URL" required style={{ width: 160 }} />
      <input type="text" name="categoryId" placeholder="eBay category ID" required style={{ width: 120 }} />
      <input type="text" name="price" placeholder="19.99" required style={{ width: 80 }} />
      <button type="submit">List on eBay</button>
    </form>
  );
}

function describeError(error: string): string {
  if (error === "product_missing_fields") return "Enter both a SKU and a name before submitting.";
  if (error === "product_sku_already_exists") return "A product with that SKU already exists.";
  if (error.startsWith("product_create_failed:")) {
    return `Could not add that product: ${error.slice("product_create_failed:".length)}`;
  }
  if (error === "shopify_listing_missing_fields") return "Enter a price before submitting.";
  if (error === "shopify_listing_invalid_price") return "Price must look like 19.99 (up to two decimal places).";
  if (error === "shopify_listing_product_not_found") return "That product could not be found.";
  if (error === "shopify_listing_already_exists") return "This product already has a Shopify listing.";
  if (error.startsWith("shopify_listing_no_connection:")) {
    return `No active Shopify connection (${error.slice("shopify_listing_no_connection:".length)}).`;
  }
  if (error.startsWith("shopify_listing_create_failed:")) {
    return `Shopify rejected the new listing: ${error.slice("shopify_listing_create_failed:".length)}`;
  }
  if (error.startsWith("shopify_listing_created_but_not_recorded:")) {
    return (
      `The listing was created on Shopify (product ${error.slice("shopify_listing_created_but_not_recorded:".length)}) ` +
      "but saving it here failed — check server logs; avoid creating it again from this page."
    );
  }
  if (error === "walmart_listing_missing_fields") return "Enter a GTIN, price, shipping weight, and category before submitting.";
  if (error === "walmart_listing_invalid_price") return "Price must look like 19.99 (up to two decimal places).";
  if (error === "walmart_listing_invalid_weight") return "Shipping weight must be a positive number (in pounds).";
  if (error === "walmart_listing_product_not_found") return "That product could not be found.";
  if (error === "walmart_listing_already_exists") return "This product already has a Walmart listing submission.";
  if (error === "walmart_listing_not_found") return "That Walmart listing could not be found.";
  if (error.startsWith("walmart_listing_no_connection:")) {
    return `No active Walmart connection (${error.slice("walmart_listing_no_connection:".length)}).`;
  }
  if (error.startsWith("walmart_listing_submit_failed:")) {
    return `Walmart rejected the offer submission: ${error.slice("walmart_listing_submit_failed:".length)}`;
  }
  if (error.startsWith("walmart_listing_submitted_but_not_recorded:")) {
    return (
      `The offer feed was submitted to Walmart (feed ${error.slice("walmart_listing_submitted_but_not_recorded:".length)}) ` +
      "but saving it here failed — check server logs before submitting again."
    );
  }
  if (error.startsWith("walmart_listing_status_check_failed:")) {
    return `Could not check Walmart feed status: ${error.slice("walmart_listing_status_check_failed:".length)}`;
  }
  if (error === "amazon_listing_missing_fields") return "Enter an ASIN and a price before submitting.";
  if (error === "amazon_listing_invalid_price") return "Price must look like 19.99 (up to two decimal places).";
  if (error === "amazon_listing_product_not_found") return "That product could not be found.";
  if (error === "amazon_listing_already_exists") return "This product already has an Amazon listing.";
  if (error.startsWith("amazon_listing_no_connection:")) {
    return `No active Amazon connection (${error.slice("amazon_listing_no_connection:".length)}).`;
  }
  if (error.startsWith("amazon_listing_create_failed:")) {
    return `Amazon rejected the offer submission: ${error.slice("amazon_listing_create_failed:".length)}`;
  }
  if (error.startsWith("amazon_listing_created_but_not_recorded:")) {
    return (
      `The offer was created on Amazon (asin ${error.slice("amazon_listing_created_but_not_recorded:".length)}) ` +
      "but saving it here failed — check server logs; avoid creating it again from this page."
    );
  }
  if (error === "ebay_listing_missing_fields") {
    return "Enter a title, description, image URL, category ID, and price before submitting.";
  }
  if (error === "ebay_listing_invalid_price") return "Price must look like 19.99 (up to two decimal places).";
  if (error === "ebay_listing_product_not_found") return "That product could not be found.";
  if (error === "ebay_listing_already_exists") return "This product already has an eBay listing.";
  if (error.startsWith("ebay_listing_no_connection:")) {
    return `No active eBay connection (${error.slice("ebay_listing_no_connection:".length)}).`;
  }
  if (error.startsWith("ebay_listing_create_failed:")) {
    return `eBay rejected the new listing: ${error.slice("ebay_listing_create_failed:".length)}`;
  }
  if (error.startsWith("ebay_listing_created_but_not_recorded:")) {
    return (
      `The listing was created on eBay (listing ${error.slice("ebay_listing_created_but_not_recorded:".length)}) ` +
      "but saving it here failed — check server logs; avoid creating it again from this page."
    );
  }
  return error;
}
