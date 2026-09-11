import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { FulfillmentType } from "@alltix/shared";
import type { AuthToken, NormalizedOrder, NormalizedOrderLine, SyncResult, TrackingInfo } from "./connector.js";

// Shopify Admin API connector -- channel #3 (CLAUDE.md §8 Phase 3).
// Researched live against shopify.dev before writing any of this (same
// discipline as amazon-connector.ts/walmart-connector.ts): every
// endpoint/mutation/scope below is cited to a specific doc page fetched
// while building this file.
//
// SCOPE (an explicit decision, not a default): this file implements
// authenticate(), pullOrders(), pushInventory(), and confirmShipment() --
// the same four-method subset AmazonConnector itself chose to implement
// first (see that file's own class doc comment: "Does NOT implement the
// full ChannelConnector interface yet"), and the subset that actually is
// this product's wedge feature (CLAUDE.md §1: "real-time inventory sync +
// rules-based order automation"). submitListing()/getFeedStatus() and
// subscribeToEvents() are deliberately NOT implemented here:
//  - submitListing/getFeedStatus: NormalizedListing ({productId, channel,
//    channelMarketplace, externalSku}) is missing every field Shopify's
//    product-creation mutations actually require (title, a price, at
//    least one variant) -- the identical gap WalmartConnector.submitListing
//    documents for Walmart's own feed. Not built speculatively against an
//    interface shape that can't carry real data yet.
//  - subscribeToEvents: unlike Walmart (genuinely poll-only, a real no-op),
//    Shopify *is* webhook-driven for real-time order/inventory events --
//    but receiving a webhook needs a public HTTP endpoint with HMAC
//    verification (CLAUDE.md §6), which is application/web-layer
//    infrastructure this connector-class-only pass doesn't build. Rather
//    than a dishonest no-op implying push events are handled, this method
//    simply isn't implemented -- see verifyShopifyWebhookHmac() below,
//    exported and unit-testable now so the future webhook route doesn't
//    start from zero, but not wired to anything yet.
//
// Wiring into channel_connections/the scheduler/Settings UI (so a tenant
// can actually connect a Shopify store from the app) is explicitly out of
// scope for this pass too -- see the session notes. This connector talks
// only to a single store via a directly-configured access token (env var
// today, loadShopifyCredentialsFromEnv() below), the same "prove the
// connector works before wiring per-tenant storage" order Amazon's own
// AMAZON_SANDBOX_* credentials were built and verified in.

// https://shopify.dev/docs/api/usage/versioning -- date-based, quarterly
// releases, each stable version supported >=12 months (>=9 months' overlap
// with the next). Pin an explicit version, never "latest" -- a version
// bump changing field/mutation shapes out from under this connector should
// be a deliberate upgrade, not a silent breakage. Re-verify against the
// versioning page before this goes stale; "2026-07" was the current stable
// release at the time this file was researched and written.
export const SHOPIFY_API_VERSION = "2026-07";

/**
 * Custom-app credentials (shopify.dev: "Generate access tokens for custom
 * apps" -- https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/generate-app-access-tokens-admin).
 * A custom app is created directly in one merchant's admin (via the Dev
 * Dashboard as of the current docs -- the in-admin "create custom app" flow
 * is deprecated for *new* apps, though existing ones still work) and hands
 * back a single Admin API access token (shpat_...) with no App Store
 * review, no OAuth round trip, and no client secret/refresh token pair at
 * all -- structurally simpler than both AmazonSandboxCredentials and
 * WalmartCredentials. This is this connector's only auth model for now; the
 * OAuth "authorization code grant" flow for a distributed/public app (the
 * eventual multi-tenant onboarding path, exactly analogous to Amazon's
 * separate OAuth "Connect" flow in amazon-oauth.ts) is documented here as
 * future work, not built.
 */
export interface ShopifyCredentials {
  /** The store's *.myshopify.com domain, without protocol -- e.g.
   *  "alltix-oms-dev.myshopify.com". Every Admin API call is scoped to
   *  exactly this one store (no cross-store concept exists). */
  shopDomain: string;
  /** The custom app's Admin API access token (shpat_...). Sent as-is on
   *  every request via the X-Shopify-Access-Token header -- there is no
   *  token exchange call and, per Shopify's docs, this token does not
   *  expire, unlike Amazon's LWA access tokens or Walmart's
   *  client_credentials tokens (both of which authenticate() actually
   *  refreshes on a timer). See {@link ShopifyConnector.authenticate}. */
  accessToken: string;
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  }
  return value;
}

/** Reads the two SHOPIFY_SANDBOX_* keys from process.env, failing fast if
 *  either is missing. "Sandbox" here means a Shopify development store
 *  (shopify.dev: "Dev stores are testing environments that you own and
 *  control... can't be used for production and can't process real
 *  transactions") -- not a separate sandbox *environment* the way Amazon's
 *  sandbox hosts are; a dev store is a real store on real Shopify
 *  infrastructure, just not able to take real payments. Same naming
 *  convention as loadAmazonSandboxCredentialsFromEnv/
 *  loadWalmartSandboxCredentialsFromEnv for consistency across connectors. */
export function loadShopifyCredentialsFromEnv(): ShopifyCredentials {
  return {
    shopDomain: readRequiredEnv("SHOPIFY_SANDBOX_SHOP_DOMAIN"),
    accessToken: readRequiredEnv("SHOPIFY_SANDBOX_ACCESS_TOKEN"),
  };
}

interface GraphQLUserError {
  field?: string[];
  message: string;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
  extensions?: { cost?: { requestedQueryCost: number; actualQueryCost: number; throttleStatus: { currentlyAvailable: number; maximumAvailable: number; restoreRate: number } } };
}

/** Raw shape of one order from the `orders` GraphQL query -- only the
 *  fields this connector maps are declared. See
 *  https://shopify.dev/docs/api/admin-graphql/latest/objects/Order and
 *  https://shopify.dev/docs/api/admin-graphql/latest/queries/orders */
export interface ShopifyOrder {
  id: string; // gid://shopify/Order/{id}
  name: string; // human-readable "#1001" -- NOT used as externalOrderId, see normalizeShopifyOrder()
  createdAt: string;
  displayFulfillmentStatus: string; // e.g. 'UNFULFILLED' | 'FULFILLED' | 'PARTIALLY_FULFILLED'
  email?: string | null;
  customer?: { email?: string | null } | null;
  shippingAddress?: Record<string, unknown> | null;
  lineItems: {
    edges: Array<{
      node: {
        id: string;
        sku?: string | null;
        quantity: number;
        originalUnitPriceSet: { shopMoney: { amount: string; currencyCode: string } };
      };
    }>;
  };
}

interface OrdersQueryResponse {
  orders: {
    edges: Array<{ cursor: string; node: ShopifyOrder }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

interface LocationsQueryResponse {
  locations: { edges: Array<{ node: { id: string; name: string } }> };
}

interface InventoryItemBySkuResponse {
  productVariants: { edges: Array<{ node: { sku: string | null; inventoryItem: { id: string } } }> };
}

interface InventorySetQuantitiesResponse {
  inventorySetQuantities: {
    inventoryAdjustmentGroup: { id: string } | null;
    userErrors: GraphQLUserError[];
  };
}

interface OrderFulfillmentOrdersResponse {
  order: {
    id: string;
    fulfillmentOrders: {
      edges: Array<{
        node: {
          id: string;
          status: string;
          lineItems: { edges: Array<{ node: { id: string; remainingQuantity: number } }> };
        };
      }>;
    };
  } | null;
}

interface FulfillmentCreateResponse {
  fulfillmentCreateV2: {
    fulfillment: { id: string; status: string } | null;
    userErrors: GraphQLUserError[];
  };
}

function normalizeShopifyOrderLine(node: ShopifyOrder["lineItems"]["edges"][number]["node"]): NormalizedOrderLine {
  return {
    externalLineId: node.id,
    // Falls back to the line item's own GID when sku is unset (e.g. a
    // custom/manually-added line) -- same "pass through, let downstream
    // channel_listings resolution fail loudly on an unmapped SKU rather
    // than silently dropping the line" reasoning insertOrderLines()
    // already applies to every channel, not something special-cased here.
    externalSku: node.sku ?? node.id,
    quantity: node.quantity,
    unitPrice: node.originalUnitPriceSet.shopMoney.amount,
    // Shopify has no AFN/WFS-style fulfillment-network concept exposed on
    // a line item the way Amazon's FulfillmentChannel or Walmart's
    // shipNodeType do -- every order defaults to seller_fulfilled, mirroring
    // WalmartConnector.mapShipNodeTypeToFulfillmentType's own default case
    // for an unrecognized type. Shopify Fulfillment Network (a real, less
    // common merchant-fulfilled-by-Shopify option) would need its own
    // detection if this connector ever needs to distinguish it.
    fulfillmentType: "seller_fulfilled" as FulfillmentType,
  };
}

export function normalizeShopifyOrder(order: ShopifyOrder): NormalizedOrder {
  return {
    // The order's GID ("gid://shopify/Order/123..."), not the human-facing
    // `name` ("#1001") -- deliberate: confirmShipment() and any future
    // per-order lookup need to re-query this exact order by id, and the
    // GID is what every Admin API `node`/single-object query expects. Long
    // and opaque compared to Amazon's AmazonOrderId, but orders.
    // external_order_id is plain TEXT with no length assumption baked in
    // anywhere else in this codebase.
    externalOrderId: order.id,
    channel: "shopify",
    // Shopify has no marketplace/region concept the way Amazon's
    // MarketplaceId does -- one connected store is one channel_connections
    // row, full stop. Left empty, same precedent as
    // WalmartConnector.normalizeWalmartOrder.
    channelMarketplace: "",
    channelStatus: order.displayFulfillmentStatus,
    placedAt: order.createdAt,
    customer: order.customer?.email ? { email: order.customer.email } : order.email ? { email: order.email } : {},
    shippingAddress: order.shippingAddress ?? {},
    lines: order.lineItems.edges.map((edge) => normalizeShopifyOrderLine(edge.node)),
    rawPayload: order,
  };
}

/**
 * Verifies an inbound Shopify webhook's `X-Shopify-Hmac-Sha256` header:
 * HMAC-SHA256 over the *raw* request body, keyed by the app's client
 * secret (not the Admin API access token -- a different credential this
 * connector doesn't hold, since custom apps don't have one the same way a
 * public/distributed app does), base64-encoded, compared with a
 * timing-safe comparison rather than `===` (constant-time, so a partial
 * match can't be timed to guess the correct signature byte-by-byte). See
 * https://shopify.dev/docs/apps/build/webhooks/verify-deliveries
 *
 * Exported standalone (not a method on ShopifyConnector, which has no
 * webhook-receiving responsibility -- see this file's header comment) so
 * the future webhook-receiving API route can import and unit-test it
 * without waiting on the rest of that route's infrastructure to exist.
 * `rawBody` MUST be the exact bytes Shopify sent (captured before any
 * JSON-parsing middleware re-serializes it) -- re-stringifying a parsed
 * body can reorder keys or change whitespace and silently break this.
 */
export function verifyShopifyWebhookHmac(rawBody: string, hmacHeader: string, clientSecret: string): boolean {
  const computed = createHmac("sha256", clientSecret).update(rawBody, "utf8").digest("base64");
  const computedBuffer = Buffer.from(computed, "base64");
  const headerBuffer = Buffer.from(hmacHeader, "base64");
  if (computedBuffer.length !== headerBuffer.length) return false;
  return timingSafeEqual(computedBuffer, headerBuffer);
}

/**
 * Shopify Admin API connector. Implements authenticate()/pullOrders()/
 * pushInventory()/confirmShipment() -- see this file's header comment for
 * exactly what's deliberately not implemented and why.
 *
 * UNVERIFIED IN ITS ENTIRETY at the time this file was written: every
 * request/mutation shape below is transcribed from shopify.dev, not yet
 * exercised against a live store -- treat this as a well-researched first
 * draft, not a proven implementation, until it's run against a real
 * development store's credentials (see loadShopifyCredentialsFromEnv,
 * scripts/shopify-sandbox-smoke-test.ts). Unlike WalmartConnector (which
 * has stayed unverified because Walmart's own approval gate makes
 * verification impossible without a business already being approved),
 * this one has no such external blocker -- it's unverified only until
 * someone runs the smoke test with a real dev-store token.
 */
export class ShopifyConnector {
  private readonly credentials: ShopifyCredentials;
  private cachedPrimaryLocationId: string | null = null;

  constructor(credentials: ShopifyCredentials = loadShopifyCredentialsFromEnv()) {
    this.credentials = credentials;
  }

  /**
   * A custom app's Admin API access token is the credential itself -- there
   * is no token-exchange call to make and, per Shopify's docs, no
   * expiry to track (unlike every other connector in this package, whose
   * authenticate() does a real network round trip and caches a token near
   * its expiry). This method still exists (rather than being dropped) to
   * keep ShopifyConnector's shape consistent with AmazonConnector/
   * WalmartConnector for any caller that calls authenticate() generically
   * before using a connector. expiresAt is a far-future placeholder, not a
   * real value Shopify ever returns -- AuthToken.expiresAt has no
   * "never expires" representation.
   */
  async authenticate(): Promise<AuthToken> {
    return { accessToken: this.credentials.accessToken, expiresAt: "9999-12-31T23:59:59.000Z" };
  }

  /**
   * POST https://{shop}/admin/api/{version}/graphql.json --
   * X-Shopify-Access-Token header, {query, variables} body. GraphQL always
   * responds 200 even for a query/mutation-level failure (top-level
   * `errors`, or a mutation's own `userErrors`) -- callers must check both,
   * not just response.ok, which this wrapper deliberately leaves to each
   * call site rather than collapsing into one generic error shape, since a
   * mutation's userErrors carry per-field detail worth preserving.
   * https://shopify.dev/docs/api/admin-graphql
   */
  private async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<GraphQLResponse<T>> {
    const { accessToken } = await this.authenticate();

    const response = await fetch(`https://${this.credentials.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      // A non-2xx here means something below the GraphQL layer itself
      // rejected the request (bad token, wrong shop domain, rate limit) --
      // real GraphQL errors come back as 200 + an `errors` array instead.
      throw new Error(`Shopify Admin API request failed: ${response.status} ${response.statusText}`);
    }

    return (await response.json()) as GraphQLResponse<T>;
  }

  private static formatGraphQLErrors(errors: Array<{ message: string }> | undefined, fallback: string): string {
    return errors?.map((e) => e.message).join("; ") || fallback;
  }

  private static formatUserErrors(errors: GraphQLUserError[], fallback: string): string {
    return errors.map((e) => (e.field?.length ? `${e.field.join(".")}: ${e.message}` : e.message)).join("; ") || fallback;
  }

  /**
   * `orders(first, after, query, sortKey: CREATED_AT)` -- cursor-paginated
   * (Relay-style `pageInfo`/`endCursor`), looped here until `hasNextPage`
   * is false so a caller always gets every order since `since`, unlike
   * AmazonConnector.pullOrders (which doesn't loop SP-API's own NextToken
   * at all -- a known, accepted gap there, not repeated here since GraphQL
   * cursor pagination is cheap to do correctly). Filters via Shopify's
   * search-syntax `query` string (`created_at:>=...`), the documented way
   * to scope a query by date rather than a dedicated since/until
   * parameter. Requires the `read_orders` scope.
   * https://shopify.dev/docs/api/admin-graphql/latest/queries/orders
   *
   * Sequential page-by-page (not concurrent) for the same rate-limit
   * reasoning every other connector in this package documents for its own
   * multi-request pulls (CLAUDE.md §4.4) -- each page's response also
   * reports `extensions.cost.throttleStatus`, which a production caller
   * should watch, but budgeting against it is left to the rate-limited job
   * queue CLAUDE.md §4.4 describes, not built here.
   */
  async pullOrders(since: Date): Promise<NormalizedOrder[]> {
    const searchQuery = `created_at:>=${since.toISOString()}`;
    const normalizedOrders: NormalizedOrder[] = [];
    let cursor: string | null = null;

    const query = `
      query PulledOrders($cursor: String, $searchQuery: String!) {
        orders(first: 50, after: $cursor, query: $searchQuery, sortKey: CREATED_AT) {
          edges {
            cursor
            node {
              id
              name
              createdAt
              displayFulfillmentStatus
              email
              customer { email }
              shippingAddress
              lineItems(first: 100) {
                edges {
                  node {
                    id
                    sku
                    quantity
                    originalUnitPriceSet { shopMoney { amount currencyCode } }
                  }
                }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;

    for (;;) {
      const response: GraphQLResponse<OrdersQueryResponse> = await this.graphql<OrdersQueryResponse>(query, { cursor, searchQuery });

      if (response.errors) {
        throw new Error(`Shopify orders query failed: ${ShopifyConnector.formatGraphQLErrors(response.errors, "unknown error")}`);
      }
      const page: OrdersQueryResponse["orders"] | undefined = response.data?.orders;
      if (!page) {
        throw new Error("Shopify orders query returned no data");
      }

      for (const edge of page.edges) {
        normalizedOrders.push(normalizeShopifyOrder(edge.node));
      }

      if (!page.pageInfo.hasNextPage) break;
      cursor = page.pageInfo.endCursor;
    }

    return normalizedOrders;
  }

  /**
   * Resolves and caches this store's first location -- Shopify's inventory
   * model is inherently per-location (InventoryLevel belongs to an
   * InventoryItem *and* a Location), unlike Amazon/Walmart's single global
   * quantity. A dev store has exactly one location by default, so "the
   * first one returned" is a reasonable simplification for this pass;
   * proper multi-location allocation is Phase 4 work (CLAUDE.md §8) not
   * built for any channel in this codebase yet. Cached for the life of
   * this connector instance, same pattern as WalmartConnector's cached
   * token -- a location doesn't change mid-process.
   * https://shopify.dev/docs/api/admin-graphql/latest/queries/locations
   */
  private async primaryLocationId(): Promise<string> {
    if (this.cachedPrimaryLocationId) return this.cachedPrimaryLocationId;

    const response = await this.graphql<LocationsQueryResponse>(
      `query { locations(first: 1) { edges { node { id name } } } }`,
    );
    if (response.errors) {
      throw new Error(`Shopify locations query failed: ${ShopifyConnector.formatGraphQLErrors(response.errors, "unknown error")}`);
    }
    const locationId = response.data?.locations.edges[0]?.node.id;
    if (!locationId) {
      throw new Error("Shopify store has no locations -- cannot push inventory");
    }
    this.cachedPrimaryLocationId = locationId;
    return locationId;
  }

  /**
   * Resolves a SKU to its InventoryItem id via `productVariants(query:
   * "sku:...")`, then writes an absolute quantity with
   * `inventorySetQuantities` (not the relative `inventoryAdjustQuantities`
   * -- ChannelConnector.pushInventory's own signature, `quantity: number`,
   * has always meant "the new total," matching how AmazonConnector.
   * pushInventory/WalmartConnector.pushInventory both set an absolute
   * value too). Shopify's own docs warn inventorySetQuantities is only for
   * "a system that acts as the source of truth for inventory quantities" --
   * exactly this platform's role per CLAUDE.md §1 ("owns the stock
   * ledger"), so it's the correct choice, not inventoryAdjustQuantities.
   * https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventorySetQuantities
   *
   * NOTE (interface mismatch, shared with every other connector's
   * pushInventory): the interface names this parameter `productId`, but
   * it must actually be the channel's own SKU -- the caller resolves the
   * internal product_id to channel_listings.external_sku for 'shopify'
   * first.
   *
   * UNVERIFIED DETAIL: Shopify's docs describe an idempotency requirement
   * for this mutation as of a recent API version but the fetched
   * documentation didn't pin down the exact mechanism (a header vs. an
   * input field) with full confidence -- `randomUUID()` is passed as
   * `input.name`'s sibling via a generated reference, flagged here to
   * confirm against a real response (or a GraphQL "unknown argument"
   * error) once dev-store credentials exist, rather than asserted as
   * correct.
   */
  async pushInventory(sku: string, quantity: number): Promise<SyncResult> {
    const variantResponse = await this.graphql<InventoryItemBySkuResponse>(
      `query ($skuQuery: String!) {
        productVariants(first: 1, query: $skuQuery) {
          edges { node { sku inventoryItem { id } } }
        }
      }`,
      { skuQuery: `sku:${sku}` },
    );
    if (variantResponse.errors) {
      return { success: false, error: `Shopify variant lookup failed: ${ShopifyConnector.formatGraphQLErrors(variantResponse.errors, "unknown error")}` };
    }
    const inventoryItemId = variantResponse.data?.productVariants.edges[0]?.node.inventoryItem.id;
    if (!inventoryItemId) {
      return { success: false, error: `Shopify: no product variant found with sku '${sku}'` };
    }

    const locationId = await this.primaryLocationId();

    const setResponse = await this.graphql<InventorySetQuantitiesResponse>(
      `mutation ($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) {
          inventoryAdjustmentGroup { id }
          userErrors { field message }
        }
      }`,
      {
        input: {
          name: "available",
          reason: "correction",
          ignoreCompareQuantityFailures: true,
          referenceDocumentUri: `urn:alltix-oms:inventory-sync:${randomUUID()}`,
          quantities: [{ inventoryItemId, locationId, quantity }],
        },
      },
    );
    if (setResponse.errors) {
      return { success: false, error: `Shopify inventory set failed: ${ShopifyConnector.formatGraphQLErrors(setResponse.errors, "unknown error")}` };
    }
    const userErrors = setResponse.data?.inventorySetQuantities.userErrors ?? [];
    if (userErrors.length > 0) {
      return { success: false, error: ShopifyConnector.formatUserErrors(userErrors, "unknown error") };
    }

    return { success: true, externalId: inventoryItemId };
  }

  /**
   * Looks up the order's open FulfillmentOrders (an order can have more
   * than one, e.g. split across locations -- not a case this dev-store-scale
   * connector needs to handle specially, but the query shape supports it),
   * then calls `fulfillmentCreateV2` covering every remaining line item
   * across all of them with one shared tracking number -- correct for the
   * common single-package case, same documented limitation
   * WalmartConnector.confirmShipment carries for a split shipment.
   * https://shopify.dev/docs/api/admin-graphql/latest/mutations/fulfillmentCreateV2
   *
   * SCOPE CORRECTION (from this file's own research, not the commonly
   * assumed name): this mutation does NOT require a scope literally named
   * `write_fulfillments` -- it requires one of
   * `write_assigned_fulfillment_orders` / `write_merchant_managed_fulfillment_orders`
   * / `write_third_party_fulfillment_orders` depending on who's assigned
   * to fulfill the order, which a custom app should request based on how
   * its dev store is configured (merchant-managed is the default/simplest
   * case). Flagged here so whoever configures the custom app's scopes
   * doesn't go looking for a scope that doesn't exist by that name.
   */
  async confirmShipment(orderId: string, tracking: TrackingInfo): Promise<void> {
    const orderResponse = await this.graphql<OrderFulfillmentOrdersResponse>(
      `query ($id: ID!) {
        order(id: $id) {
          id
          fulfillmentOrders(first: 10) {
            edges { node { id status lineItems(first: 100) { edges { node { id remainingQuantity } } } } }
          }
        }
      }`,
      { id: orderId },
    );
    if (orderResponse.errors) {
      throw new Error(`Shopify order lookup (for fulfillment) failed: ${ShopifyConnector.formatGraphQLErrors(orderResponse.errors, "unknown error")}`);
    }
    const order = orderResponse.data?.order;
    if (!order) {
      throw new Error(`Shopify order ${orderId} not found`);
    }

    const lineItemsByFulfillmentOrder = order.fulfillmentOrders.edges
      .filter((edge) => edge.node.status === "OPEN" || edge.node.status === "IN_PROGRESS")
      .map((edge) => ({
        fulfillmentOrderId: edge.node.id,
        fulfillmentOrderLineItems: edge.node.lineItems.edges
          .filter((lineEdge) => lineEdge.node.remainingQuantity > 0)
          .map((lineEdge) => ({ id: lineEdge.node.id, quantity: lineEdge.node.remainingQuantity })),
      }))
      .filter((f) => f.fulfillmentOrderLineItems.length > 0);

    if (lineItemsByFulfillmentOrder.length === 0) {
      throw new Error(`Shopify order ${orderId} has no open fulfillment orders with remaining line items to ship`);
    }

    const fulfillResponse = await this.graphql<FulfillmentCreateResponse>(
      `mutation ($fulfillment: FulfillmentV2Input!) {
        fulfillmentCreateV2(fulfillment: $fulfillment) {
          fulfillment { id status }
          userErrors { field message }
        }
      }`,
      {
        fulfillment: {
          lineItemsByFulfillmentOrder,
          trackingInfo: { company: tracking.carrier, number: tracking.trackingNumber },
          notifyCustomer: true,
        },
      },
    );
    if (fulfillResponse.errors) {
      throw new Error(`Shopify fulfillmentCreateV2 failed: ${ShopifyConnector.formatGraphQLErrors(fulfillResponse.errors, "unknown error")}`);
    }
    const userErrors = fulfillResponse.data?.fulfillmentCreateV2.userErrors ?? [];
    if (userErrors.length > 0) {
      throw new Error(`Shopify fulfillmentCreateV2 rejected: ${ShopifyConnector.formatUserErrors(userErrors, "unknown error")}`);
    }
  }
}
