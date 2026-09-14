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
}

interface ProductsPageProps {
  searchParams: Promise<{ error?: string; shopify_listing_created?: string; product_created?: string }>;
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
  const { error, shopify_listing_created: shopifyListingCreated, product_created: productCreated } = await searchParams;

  if (!tenantId) {
    return (
      <main className="page">
        <h1>Products</h1>
        <p>No tenant is associated with this account yet.</p>
      </main>
    );
  }

  const { products, hasActiveShopifyConnection } = await withTenant(pool, tenantId, async (client) => {
    const productsResult = await client.query<ProductRow>(
      `SELECT p.id, p.internal_sku, p.name,
              cl.listing_status AS shopify_listing_status,
              cl.list_price AS shopify_list_price,
              cl.external_sku AS shopify_external_sku
         FROM products p
         LEFT JOIN channel_listings cl
           ON cl.product_id = p.id AND cl.tenant_id = p.tenant_id AND cl.channel = 'shopify'
        ORDER BY p.internal_sku`,
    );
    const connectionResult = await client.query(
      `SELECT 1 FROM channel_connections WHERE channel = 'shopify' AND status = 'active' LIMIT 1`,
    );
    return { products: productsResult.rows, hasActiveShopifyConnection: connectionResult.rows.length > 0 };
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
  return error;
}
