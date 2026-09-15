import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { withTenant, decryptChannelSecret } from "@alltix/db";
import type { FulfillmentType } from "@alltix/shared";
import type { AuthToken, NormalizedOrder, NormalizedOrderLine, SyncResult, TrackingInfo } from "./connector.js";
// CLAUDE.md §4.4's in-process retry/backoff -- see retry.ts's own doc
// comment and amazon-connector.ts's identical import for the full
// reasoning. Shopify has no separate token-exchange call to leave alone
// the way Walmart's does (authenticate() here just reads the
// already-issued offline access token out of storage, no network call) --
// graphql() is the one and only outbound HTTP call this connector makes.
import { fetchWithBackoff } from "./retry.js";

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

/**
 * Reads the most recent active 'shopify' channel_connections row for a
 * tenant and decrypts its access token, via {@link withTenant} so RLS
 * scopes the lookup to `tenantId` (CLAUDE.md §2.4) -- mirrors
 * AmazonConnector's loadAmazonCredentialsFromChannelConnection exactly,
 * just against the one column a custom app's credential actually needs
 * (see migrations/0019_channel_connections_shopify.sql for why
 * lwa_client_id/encrypted_client_secret/encrypted_refresh_token, all
 * Amazon-OAuth concepts, are irrelevant to a Shopify row). Never logs the
 * decrypted token -- only returns it.
 */
export async function loadShopifyCredentialsFromChannelConnection(
  pool: Pool,
  tenantId: string,
): Promise<ShopifyCredentials> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query<{ external_account_id: string; encrypted_access_token: Buffer | null }>(
      `SELECT external_account_id, encrypted_access_token
         FROM channel_connections
        WHERE channel = 'shopify' AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 1`,
    );

    const row = result.rows[0];
    if (!row || !row.encrypted_access_token) {
      throw new Error(`No active 'shopify' channel_connections row found for tenant ${tenantId}`);
    }

    const accessToken = await decryptChannelSecret(client, row.encrypted_access_token);
    return { shopDomain: row.external_account_id, accessToken };
  });
}

/** Builds a {@link ShopifyConnector} from a tenant's channel_connections row instead of process.env. */
export async function createShopifyConnectorFromChannelConnection(pool: Pool, tenantId: string): Promise<ShopifyConnector> {
  const credentials = await loadShopifyCredentialsFromChannelConnection(pool, tenantId);
  return new ShopifyConnector(credentials);
}

interface GraphQLUserError {
  field?: string[];
  message: string;
}

// `message` alone was proven insufficient in practice: a variable-coercion
// error against InventorySetQuantitiesInput came back as just "was provided
// invalid value" with the offending field/path only present in `extensions`
// (Shopify's GraphQL errors carry structured detail there, not always in the
// message text) -- captured here now so formatGraphQLErrors() can surface it
// instead of leaving a caller to guess.
interface GraphQLError {
  message: string;
  path?: Array<string | number>;
  extensions?: Record<string, unknown>;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLError[];
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

/** Raw shape of one node from the `productVariants` query used by
 *  {@link pullProductCatalog} -- deliberately the same
 *  `inventoryItem { id inventoryLevels(...) }` sub-selection
 *  pushInventory()'s own variant lookup already uses and has verified live,
 *  reused here rather than re-derived. */
export interface RawProductVariantNode {
  id: string;
  sku: string | null;
  title: string;
  product: { title: string };
  inventoryItem: {
    id: string;
    inventoryLevels: { edges: Array<{ node: { location: { id: string }; quantities: Array<{ quantity: number }> } }> };
  };
}

interface ProductVariantsQueryResponse {
  productVariants: {
    edges: Array<{ cursor: string; node: RawProductVariantNode }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

interface LocationsQueryResponse {
  locations: { edges: Array<{ node: { id: string; name: string } }> };
}

interface InventoryItemBySkuResponse {
  productVariants: {
    edges: Array<{
      node: {
        sku: string | null;
        inventoryItem: {
          id: string;
          inventoryLevels: { edges: Array<{ node: { location: { id: string }; quantities: Array<{ quantity: number }> } }> };
        };
      };
    }>;
  };
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

/** One SKU-mapped variant pulled by {@link ShopifyConnector.pullProductCatalog} --
 *  the shape a catalog-sync job needs to upsert a `products`/`channel_listings`
 *  row and seed a baseline stock level (mirrors the exact fields
 *  `scripts/add-channel-listing.ts` already asks a human to supply by hand
 *  for one SKU at a time). */
export interface NormalizedShopifyProductVariant {
  /** Matches pullOrders()'s own NormalizedOrderLine.externalSku exactly --
   *  this is what channel_listings.external_sku must equal for
   *  OrderService.persistPulledOrders to resolve an order line to a
   *  product_id. */
  externalSku: string;
  /** Shopify's InventoryItem gid -- a natural per-variant identifier
   *  distinct from the SKU, recorded as channel_listings.external_id (the
   *  same "seller id / merchant id, channel-specific" column Amazon's ASIN
   *  and Walmart's Item ID already use for their own per-listing id). */
  inventoryItemId: string;
  /** "<Product title> - <Variant title>", except Shopify's own default
   *  "Default Title" variant name is dropped so a single-variant product
   *  (the common case for a small seller) doesn't get a meaningless
   *  " - Default Title" suffix on its internal products.name. */
  title: string;
  /** Summed across every Location this item has a reported level at.
   *  Deliberately NOT per-location: this codebase's own `locations` table
   *  (CLAUDE.md §2.4) has no established mapping to a *Shopify* location
   *  yet, and real multi-location allocation is Phase 4 work (CLAUDE.md
   *  §8) -- summing gives a correct single total rather than an arbitrary
   *  single location's partial count, consistent with the "one location
   *  per item" simplification pushInventory()/primaryLocationId() already
   *  document. */
  totalAvailable: number;
}

/** Pure normalization -- no network access -- so it's unit-testable without
 *  a live store, unlike {@link ShopifyConnector.pullProductCatalog} itself.
 *  Returns null for a variant with no SKU set: an order line can only
 *  resolve to a product via channel_listings.external_sku (see
 *  OrderService.persistPulledOrders -> insertOrderLines), so a SKU-less
 *  variant has nothing this connector can map it by -- pullProductCatalog
 *  counts and warns about these rather than silently dropping them. */
export function normalizeShopifyProductVariant(node: RawProductVariantNode): NormalizedShopifyProductVariant | null {
  if (!node.sku) return null;

  const totalAvailable = node.inventoryItem.inventoryLevels.edges.reduce(
    (sum, edge) => sum + (edge.node.quantities[0]?.quantity ?? 0),
    0,
  );
  const title = node.title && node.title !== "Default Title" ? `${node.product.title} - ${node.title}` : node.product.title;

  return { externalSku: node.sku, inventoryItemId: node.inventoryItem.id, title, totalAvailable };
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

/** The three webhook topics {@link ShopifyConnector.registerWebhooks}
 *  subscribes a store to -- chosen to close exactly the gaps flagged when
 *  webhooks were scoped: `ORDERS_CREATE` replaces the up-to-24h-stale daily
 *  cron (packages/scheduler's syncShopifyOrders) with near-real-time order
 *  pull for the common case; `ORDERS_CANCELLED` lets a channel-side
 *  cancellation release the ledger reservation without waiting for a human
 *  to notice on their next visit to /orders; `APP_UNINSTALLED` flips the
 *  connection to 'disconnected' the moment a merchant revokes access from
 *  their own Shopify admin, instead of every subsequent call failing
 *  silently against a dead token forever (the "no alerting" gap syncTenant's
 *  own doc comment in packages/scheduler already flags for Amazon -- closed
 *  for real here, for the one signal Shopify volunteers for free).
 *  https://shopify.dev/docs/api/admin-graphql/latest/enums/WebhookSubscriptionTopic */
export const SHOPIFY_WEBHOOK_TOPICS = ["ORDERS_CREATE", "ORDERS_CANCELLED", "APP_UNINSTALLED"] as const;
export type ShopifyWebhookTopic = (typeof SHOPIFY_WEBHOOK_TOPICS)[number];

export interface ShopifyWebhookRegistrationResult {
  topic: ShopifyWebhookTopic;
  success: boolean;
  webhookSubscriptionId: string | null;
  error: string | null;
}

interface WebhookSubscriptionCreateResponse {
  webhookSubscriptionCreate: {
    webhookSubscription: { id: string } | null;
    userErrors: GraphQLUserError[];
  };
}

/** Raw shape of the JSON body Shopify POSTs for `orders/create` and
 *  `orders/cancelled` webhook deliveries -- Shopify's flat REST-style Order
 *  resource, NOT the `edges`/`node` GraphQL shape {@link ShopifyOrder} above
 *  uses. pullOrders() (via the GraphQL `orders` query) and the webhook route
 *  (via a raw POST body) normalize two physically different payload shapes
 *  into the same NormalizedOrder -- see
 *  {@link normalizeShopifyOrderWebhookPayload}. Only the fields actually
 *  mapped are declared, same "declare what's used, not the whole resource"
 *  discipline as ShopifyOrder itself.
 *  https://shopify.dev/docs/apps/build/webhooks/delivery-structure */
export interface ShopifyOrderWebhookPayload {
  id: number;
  /** The same GID pullOrders()/normalizeShopifyOrder() use as
   *  externalOrderId -- present on every Shopify REST resource for exactly
   *  this cross-reference purpose. Using this (never the numeric `id`) is
   *  what keeps an order created via cron pull and the same order arriving
   *  again via webhook (or vice versa) deduping onto one
   *  orders.external_order_id row instead of two different ids for the same
   *  underlying Shopify order. */
  admin_graphql_api_id: string;
  name: string;
  created_at: string;
  fulfillment_status: string | null;
  email?: string | null;
  customer?: { email?: string | null } | null;
  shipping_address?: Record<string, unknown> | null;
  line_items: Array<{
    id: number;
    sku?: string | null;
    quantity: number;
    price: string;
  }>;
}

/**
 * Pure normalization (no network access, unit-testable without a live
 * store) mirroring {@link normalizeShopifyOrder} field-for-field, but
 * reading Shopify's flat webhook/REST payload shape instead of the GraphQL
 * `edges`/`node` shape -- see {@link ShopifyOrderWebhookPayload}'s own doc
 * comment for why these need to be two separate functions rather than one,
 * and why `admin_graphql_api_id` (never the numeric `id`) is used as
 * externalOrderId. Used by both the `orders/create` and `orders/cancelled`
 * webhook handlers (packages/web's `/api/webhooks/shopify` route) -- an
 * `orders/cancelled` delivery's body is the full current Order, the same
 * shape `orders/create` sends, just with fulfillment/cancellation fields
 * updated, so one normalizer covers both topics' payloads.
 */
export function normalizeShopifyOrderWebhookPayload(payload: ShopifyOrderWebhookPayload): NormalizedOrder {
  return {
    externalOrderId: payload.admin_graphql_api_id,
    channel: "shopify",
    channelMarketplace: "",
    channelStatus: payload.fulfillment_status ?? "unfulfilled",
    placedAt: payload.created_at,
    customer: payload.customer?.email ? { email: payload.customer.email } : payload.email ? { email: payload.email } : {},
    shippingAddress: payload.shipping_address ?? {},
    lines: payload.line_items.map((line) => ({
      externalLineId: String(line.id),
      // Same "pass through, let downstream channel_listings resolution fail
      // loudly on an unmapped SKU" fallback normalizeShopifyOrderLine uses
      // for the GraphQL path.
      externalSku: line.sku ?? String(line.id),
      quantity: line.quantity,
      unitPrice: line.price,
      fulfillmentType: "seller_fulfilled" as FulfillmentType,
    })),
    rawPayload: payload,
  };
}

/** Input for {@link ShopifyConnector.createListing} -- the minimum data
 *  needed to create a brand-new, single-variant Shopify product from an
 *  internal product (packages/web's `/api/channels/shopify/listings` route
 *  supplies these from `products.internal_sku`/`products.name` plus a price
 *  the tenant enters, persisted to the new `channel_listings.list_price`
 *  column -- see migration 0020). Deliberately narrower than a full
 *  "push anything" shape: v1 scope is single-variant only, matching every
 *  other per-SKU simplification this connector already makes
 *  (primaryLocationId, the "one location per item" assumption in
 *  pushInventory). */
export interface ShopifyListingSubmission {
  internalSku: string;
  title: string;
  /** A Money-scalar-compatible string, e.g. "19.99" -- the same string
   *  convention NormalizedOrderLine.unitPrice already uses, not a float
   *  (floats and money don't mix). */
  price: string;
}

export interface ShopifyListingResult {
  success: boolean;
  productGid: string | null;
  /** The single default variant's InventoryItem gid -- the same id
   *  pullProductCatalog()/pushInventory() use as channel_listings.external_id,
   *  so a listing created here is indistinguishable in storage from one
   *  discovered later by catalog sync. */
  inventoryItemGid: string | null;
  error: string | null;
}

interface ProductSetResponse {
  productSet: {
    product: {
      id: string;
      variants: { edges: Array<{ node: { id: string; sku: string | null; inventoryItem: { id: string } } }> };
    } | null;
    userErrors: GraphQLUserError[];
  };
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
   * A minimal real API call (`{ shop { name } }`) used only to prove a
   * shop domain + access token pair is actually valid -- unlike
   * authenticate() above, which never touches the network at all and so
   * can't catch a wrong domain or a revoked/mistyped token. Used by the
   * Settings UI's "Connect Shopify" form (see
   * packages/web/src/app/api/channels/shopify/connect/route.ts) to reject
   * bad input before it's ever persisted, and its return value doubles as
   * a friendlier label than the raw *.myshopify.com domain for that same
   * UI. Not used anywhere in the already-verified pullOrders/
   * pushInventory/confirmShipment path -- those don't need an extra
   * round trip to confirm what a failing call would show anyway.
   */
  async verifyConnection(): Promise<{ shopName: string }> {
    const response = await this.graphql<{ shop: { name: string } }>(`query { shop { name } }`);
    if (response.errors) {
      throw new Error(`Shopify connection check failed: ${ShopifyConnector.formatGraphQLErrors(response.errors, "unknown error")}`);
    }
    const shopName = response.data?.shop.name;
    if (!shopName) {
      throw new Error("Shopify connection check failed: no shop data returned");
    }
    return { shopName };
  }

  /**
   * Registers this store for near-real-time delivery of each topic in
   * {@link SHOPIFY_WEBHOOK_TOPICS} via `webhookSubscriptionCreate`, POSTing
   * to `callbackUrl` (packages/web's `/api/webhooks/shopify` route). Uses
   * the same Admin API access token as every other call on this class --
   * registering a subscription needs no client secret at all. The client
   * secret is a *separate* credential, generated alongside a custom app's
   * access token, used only to verify the HMAC signature on each *inbound*
   * delivery (see {@link verifyShopifyWebhookHmac}) -- this method never
   * touches it, and doesn't need to.
   *
   * `uri` (not the deprecated `callbackUrl` input field -- see
   * https://shopify.dev/changelog/consolidate-webhook-graphql-surfaces,
   * which folded callbackUrl into a single `uri` field across every
   * delivery method as of API version 2025-10, before this connector's
   * pinned 2026-07) is the endpoint Shopify POSTs each delivery to.
   * `format: "JSON"` is passed explicitly rather than relying on whatever
   * Shopify defaults to if the field is omitted.
   *
   * Never throws for a single topic's failure -- same per-item error
   * isolation this file already applies elsewhere (pullOrders' per-page
   * partial-data warning, pullProductCatalog's per-variant skip count): a
   * tenant whose custom app is missing one scope shouldn't lose
   * registration for the other two topics. Callers should still surface
   * every non-success result to the tenant/logs; this only isolates one
   * topic's failure from blocking the others.
   *
   * Confirmed against a real dev store: registration succeeded 3/3 topics
   * from the /settings/channels "Connect Shopify" flow, and the full round
   * trip was proven too -- a genuinely new order placed after registration
   * arrived at POST /api/webhooks/shopify and appeared in /orders within
   * seconds (see CLAUDE.md §4.5's "Real-time webhooks" for the write-up,
   * including the one real production incident this run surfaced: an order
   * for a product with no channel_listings mapping correctly failed loudly
   * and rolled back rather than persisting a broken order).
   *
   * Still genuinely unknown: whether Shopify treats a *repeat* registration
   * for a topic+uri pair already subscribed (e.g. a tenant reconnecting
   * without changing anything) as a harmless no-op or a rejected userError
   * -- this method doesn't special-case a guess, it just surfaces whatever
   * userErrors come back. Not exercised by the verification above, which
   * only ever registered once per tenant.
   */
  async registerWebhooks(callbackUrl: string): Promise<ShopifyWebhookRegistrationResult[]> {
    const results: ShopifyWebhookRegistrationResult[] = [];

    for (const topic of SHOPIFY_WEBHOOK_TOPICS) {
      try {
        const response = await this.graphql<WebhookSubscriptionCreateResponse>(
          `mutation ($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
            webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
              webhookSubscription { id }
              userErrors { field message }
            }
          }`,
          { topic, webhookSubscription: { uri: callbackUrl, format: "JSON" } },
        );

        if (response.errors) {
          results.push({
            topic,
            success: false,
            webhookSubscriptionId: null,
            error: ShopifyConnector.formatGraphQLErrors(response.errors, "unknown error"),
          });
          continue;
        }

        const userErrors = response.data?.webhookSubscriptionCreate.userErrors ?? [];
        if (userErrors.length > 0) {
          results.push({
            topic,
            success: false,
            webhookSubscriptionId: null,
            error: ShopifyConnector.formatUserErrors(userErrors, "unknown error"),
          });
          continue;
        }

        const webhookSubscriptionId = response.data?.webhookSubscriptionCreate.webhookSubscription?.id ?? null;
        if (!webhookSubscriptionId) {
          results.push({ topic, success: false, webhookSubscriptionId: null, error: "no webhookSubscription returned" });
          continue;
        }

        results.push({ topic, success: true, webhookSubscriptionId, error: null });
      } catch (err) {
        results.push({
          topic,
          success: false,
          webhookSubscriptionId: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
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
   *
   * Idempotency, CONFIRMED against a real dev store (API version 2026-07):
   * the original "header vs. input field" uncertainty this connector once
   * flagged (see pushInventory's doc comment) resolves to neither -- it's a
   * directive *argument*. A mutation Shopify has opted into idempotency for
   * (inventorySetQuantities among them) first rejects a call missing the
   * `@idempotent` directive entirely ("The @idempotent directive is
   * required for this mutation but was not provided"), and, once tagged,
   * rejects a bare `@idempotent` too ("Directive 'idempotent' is missing
   * required arguments: key") -- it must be `@idempotent(key:
   * $someVariable)` with that variable supplied like any other, no special
   * HTTP header involved. See pushInventory for the working shape.
   */
  private async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<GraphQLResponse<T>> {
    const { accessToken } = await this.authenticate();

    const response = await fetchWithBackoff(`https://${this.credentials.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
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

  private static formatGraphQLErrors(errors: GraphQLError[] | undefined, fallback: string): string {
    return (
      errors
        ?.map((e) => {
          const path = e.path?.length ? ` [path: ${e.path.join(".")}]` : "";
          const extensions = e.extensions && Object.keys(e.extensions).length ? ` ${JSON.stringify(e.extensions)}` : "";
          return `${e.message}${path}${extensions}`;
        })
        .join("; ") || fallback
    );
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
   *
   * Protected Customer Data: Shopify gates any PII-bearing field (the
   * `customer` object, `shippingAddress`, `billingAddress`, etc.) behind a
   * Partner-Dashboard-level "Protected customer data access" approval that
   * is separate from Admin API scopes, and -- for a custom/legacy app like
   * this one -- also requires the store to be on the Shopify/Advanced/Plus
   * plan tier (not Basic). This is the same shape of restriction as
   * Amazon SP-API's Restricted Data Token for PII (CLAUDE.md §4.1), just
   * gating a different field set. `customer { email }` was dropped from
   * this query outright for that reason (normalizeShopifyOrder() falls
   * back to the order-level `email` scalar, which is not similarly
   * gated). `shippingAddress` is left in the query, because production
   * fulfillment needs it and a real seller on Shopify/Advanced/Plus with
   * approval will get it -- but on a store/app that lacks that approval
   * (this dev store included: Basic plan), Shopify returns the rest of
   * the order normally and nulls out just `shippingAddress`, reporting it
   * as a GraphQL error alongside otherwise-successful data. Treat that as
   * a per-field warning, not a fatal failure -- see below.
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
              shippingAddress {
                firstName
                lastName
                company
                address1
                address2
                city
                province
                provinceCode
                zip
                country
                countryCodeV2
                phone
              }
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

      const page: OrdersQueryResponse["orders"] | undefined = response.data?.orders;
      if (!page) {
        // No usable data at all -- e.g. auth failure, throttling, a malformed
        // query -- unlike the partial-field case below, this is fatal.
        throw new Error(`Shopify orders query failed: ${ShopifyConnector.formatGraphQLErrors(response.errors, "unknown error")}`);
      }
      if (response.errors?.length) {
        // Data is present alongside the error(s): a per-field access
        // restriction (see the Protected Customer Data note on this
        // method's doc comment above) nulled out one or more fields rather
        // than failing the whole query. Surface it so it's not silently
        // invisible, but don't abort the pull over it.
        console.warn(
          `Shopify orders query returned partial data (field(s) unavailable, likely Protected Customer Data restrictions): ${ShopifyConnector.formatGraphQLErrors(response.errors, "unknown error")}`,
        );
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
   * Pulls every product variant in the store (paginated the same
   * cursor-loop way as pullOrders()) and normalizes each one that has a
   * SKU set. Not part of the `ChannelConnector` interface -- no other
   * connector in this package has an inbound "read the channel's own
   * catalog" capability yet (Amazon/Walmart only ever push a listing OUT
   * via submitListing/getFeedStatus), so this stays Shopify-specific
   * rather than speculatively shaping a cross-channel interface method
   * with only one implementation to validate it against -- the same
   * "don't trust the interface until forced by a second implementation"
   * discipline this file's own header comment already applies to
   * `ChannelConnector` itself.
   *
   * This is what closes the gap `scripts/add-channel-listing.ts` is a
   * manual stopgap for: instead of a human supplying one SKU/product
   * name/quantity at a time, a catalog-sync job (packages/scheduler)
   * calls this, upserts a products/channel_listings row per variant the
   * same way that script does, and seeds each SKU's starting stock from
   * Shopify's own currently-reported quantity -- the realistic version of
   * "onboarding an existing store's catalog." See
   * NormalizedShopifyProductVariant's own doc comment for the shape and
   * why it sums quantity across locations rather than picking one.
   *
   * No `since`/incremental pagination the way pullOrders() has: a
   * catalog's size doesn't grow unboundedly the way an order history does
   * (CLAUDE.md §0's target of 50-5,000 orders/month is a very different
   * scale than a seller's typical product count), so a full re-pull every
   * run is simple and correct rather than a premature optimization -- a
   * consuming job re-upserting a SKU it already knows about is a cheap,
   * idempotent no-op (see syncShopifyCatalog in packages/scheduler).
   * Requires the `read_products` scope (already documented in .env.example
   * for pushInventory's own variant lookup).
   *
   * CONFIRMED against a real dev store (alltixoms-dev.myshopify.com,
   * `npm run shopify:sandbox-smoke-test`): correctly pulled every SKU'd
   * variant with the right quantities and skipped 22 SKU-less demo
   * variants (this store's stock Shopify sample products) with the
   * expected warning, on the very first live attempt -- no fix needed,
   * unlike pullOrders/pushInventory/confirmShipment, each of which took
   * multiple rounds of live debugging (see their own doc comments). Most
   * likely because this method reuses the exact
   * `inventoryItem { inventoryLevels(...) }` sub-selection pushInventory's
   * own variant lookup already proved live, rather than untested new
   * query shape.
   */
  async pullProductCatalog(): Promise<NormalizedShopifyProductVariant[]> {
    const variants: NormalizedShopifyProductVariant[] = [];
    let cursor: string | null = null;
    let skippedNoSku = 0;

    const query = `
      query PulledProductVariants($cursor: String) {
        productVariants(first: 100, after: $cursor) {
          edges {
            cursor
            node {
              id
              sku
              title
              product { title }
              inventoryItem {
                id
                inventoryLevels(first: 10) {
                  edges { node { location { id } quantities(names: ["available"]) { quantity } } }
                }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;

    for (;;) {
      const response: GraphQLResponse<ProductVariantsQueryResponse> = await this.graphql<ProductVariantsQueryResponse>(query, {
        cursor,
      });

      const page = response.data?.productVariants;
      if (!page) {
        throw new Error(`Shopify productVariants query failed: ${ShopifyConnector.formatGraphQLErrors(response.errors, "unknown error")}`);
      }
      if (response.errors?.length) {
        // Same partial-data tolerance as pullOrders() -- a restricted field
        // elsewhere in the response shouldn't block variants that came
        // back fine.
        console.warn(
          `Shopify productVariants query returned partial data: ${ShopifyConnector.formatGraphQLErrors(response.errors, "unknown error")}`,
        );
      }

      for (const edge of page.edges) {
        const normalized = normalizeShopifyProductVariant(edge.node);
        if (normalized) {
          variants.push(normalized);
        } else {
          skippedNoSku++;
        }
      }

      if (!page.pageInfo.hasNextPage) break;
      cursor = page.pageInfo.endCursor;
    }

    if (skippedNoSku > 0) {
      console.warn(
        `Shopify pullProductCatalog: skipped ${skippedNoSku} variant(s) with no SKU set -- cannot map an unSKU'd variant to channel_listings.external_sku.`,
      );
    }

    return variants;
  }

  /**
   * Resolves and caches *a* location for this store -- Shopify's inventory
   * model is inherently per-location (InventoryLevel belongs to an
   * InventoryItem *and* a Location), unlike Amazon/Walmart's single global
   * quantity. Proper multi-location allocation is Phase 4 work (CLAUDE.md
   * §8) not built for any channel in this codebase yet. Cached for the
   * life of this connector instance, same pattern as WalmartConnector's
   * cached token -- a location doesn't change mid-process.
   * https://shopify.dev/docs/api/admin-graphql/latest/queries/locations
   *
   * CORRECTED, against a real dev store: this was originally documented as
   * "a dev store has exactly one location by default, so 'the first one
   * returned' is a reasonable simplification" -- false in practice. This
   * store has more than one Location, and `locations(first: 1)` (no
   * explicit sort key) is not guaranteed to return the one any given item
   * is actually stocked at; a real bug in pushInventory() traced back to
   * exactly that (see its doc comment). This method is now ONLY the
   * fallback for an item with no existing inventory level anywhere yet
   * (a genuinely new/never-stocked item, where there's no better signal to
   * pick a location from) -- callers that already know an item's existing
   * location should use that instead of calling this at all.
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
   * CONFIRMED against a real dev store (API version 2026-07):
   * `ignoreCompareQuantityFailures` is NOT a field on this version's
   * `InventorySetQuantitiesInput` -- the mutation rejects it outright at
   * variable-coercion time ("Field is not defined on
   * InventorySetQuantitiesInput"), before even reaching `userErrors`. That
   * field only matters when a per-item `compareQuantity` is also set (an
   * optimistic-concurrency check -- "only apply this if the quantity was
   * still X"), which this method doesn't use: it's an unconditional
   * absolute set, matching pushInventory's own "the new total" contract
   * (see above), so there's no compare-quantity failure to ignore in the
   * first place. `referenceDocumentUri` (a fresh `randomUUID()` per call)
   * is kept as the request-level identifier Shopify's docs do call for.
   *
   * CONFIRMED (same dev store, same API version): `InventoryQuantityInput`
   * (each entry in `quantities`) requires `changeFromQuantity` -- the
   * quantity the caller believes is currently set, so Shopify can validate
   * the write is against the state it expects (a mandatory version of what
   * `compareQuantity`/`ignoreCompareQuantityFailures` used to make
   * optional). That forces a read before this write: the variant lookup
   * below also fetches the current `available` quantity at the target
   * location (0 if the item has no inventory level there yet, e.g. it's
   * never been stocked at this location before) and passes it back as
   * `changeFromQuantity`.
   *
   * CONFIRMED against the real dev store, after two false leads worth
   * recording so they aren't re-tried blind if this ever regresses: this
   * `changeFromQuantity` read kept computing as 0 against a location that
   * provably DID have a persisted non-zero quantity (inventorySetQuantities
   * itself rejected 0 as stale). First theory: a propagation lag, "fixed"
   * with a delayed retry -- didn't help, failed identically across four
   * delayed attempts. Second theory: the singular
   * `InventoryItem.inventoryLevel(locationId: ...)` field being unreliable
   * -- switched to the plural `inventoryLevels` connection instead, which
   * also didn't help. Diagnostic logging of every location this item
   * actually has an inventoryLevel at (not just whether the *expected*
   * location matched) revealed the real cause: this dev store has more
   * than one Location, and `primaryLocationId()`'s `locations(first: 1)`
   * (no explicit sort) was not reliably resolving to the location this SKU
   * is actually stocked at -- every read against the *wrong* location was
   * correctly finding no level there (hence 0), which then correctly
   * failed to match the real level's quantity at the *right* location. Fix
   * (below): resolve the location from the item's own existing
   * `inventoryLevels` first, falling back to `primaryLocationId()` only
   * for an item with no existing level anywhere (a genuinely new/
   * never-stocked item) -- see the inline comment at that resolution.
   *
   * The delayed retry loop is left in place as defense-in-depth for a
   * genuinely concurrent external writer changing this SKU's quantity
   * between this read and the mutation (a real race, just not the one that
   * caused the failures above) -- that class of problem is still what
   * CLAUDE.md §4.4's per-tenant rate-limited job queue is meant to
   * serialize away, not something a bounded in-process retry can guarantee
   * against on its own.
   *
   * CONFIRMED (same dev store, same API version): `inventorySetQuantities`
   * also requires `@idempotent(key: $idempotencyKey)` on the mutation
   * field itself (see graphql()'s doc comment for the two-step rejection
   * that pinned this down -- directive missing, then the directive's own
   * `key` argument missing). A fresh `randomUUID()` is generated per
   * attempt and used as both that key variable and (folded into a URN)
   * the unrelated `referenceDocumentUri` input field, so a retried call
   * with the same key would be deduped by Shopify rather than
   * double-applied -- though each retry here is a genuinely new attempt
   * (new changeFromQuantity), so it gets its own fresh key rather than
   * reusing the previous attempt's.
   */
  async pushInventory(sku: string, quantity: number): Promise<SyncResult> {
    const MAX_ATTEMPTS = 4;
    const RETRY_DELAYS_MS = [300, 600, 1200];
    let lastError = "unknown error";

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 2] ?? 1200));
      }
      const variantResponse = await this.graphql<InventoryItemBySkuResponse>(
        `query ($skuQuery: String!) {
          productVariants(first: 1, query: $skuQuery) {
            edges {
              node {
                sku
                inventoryItem {
                  id
                  inventoryLevels(first: 10) {
                    edges { node { location { id } quantities(names: ["available"]) { quantity } } }
                  }
                }
              }
            }
          }
        }`,
        { skuQuery: `sku:${sku}` },
      );
      if (variantResponse.errors) {
        return { success: false, error: `Shopify variant lookup failed: ${ShopifyConnector.formatGraphQLErrors(variantResponse.errors, "unknown error")}` };
      }
      const variantNode = variantResponse.data?.productVariants.edges[0]?.node;
      const inventoryItemId = variantNode?.inventoryItem.id;
      if (!inventoryItemId) {
        return { success: false, error: `Shopify: no product variant found with sku '${sku}'` };
      }

      // CONFIRMED against the real dev store, and the actual root cause
      // (two misdiagnoses preceded this one -- see git history/prior
      // comments on this method if resurrected): this store has more than
      // one Location, and `primaryLocationId()`'s `locations(first: 1)`
      // (no explicit sort) does NOT reliably return the location this SKU
      // is actually stocked at -- diagnostic logging caught it returning a
      // *different* location than the one holding this item's real
      // inventory level. Every prior "stale changeFromQuantity" failure
      // was really this: reading (correctly!) that the item has no level
      // at the wrong location, then having that correct-for-the-wrong-
      // location `0` rejected against the real level's actual quantity at
      // the *right* location. Fix: target wherever this item's existing
      // inventory level actually is (first entry in `inventoryLevels`,
      // consistent with "a dev store has exactly one location per item"
      // still being a fine simplification -- CLAUDE.md §8 Phase 4 is where
      // real multi-location allocation belongs), falling back to
      // primaryLocationId() only when the item has no existing level
      // anywhere yet (a genuinely new/never-stocked item).
      const existingLevels = variantNode.inventoryItem.inventoryLevels.edges;
      const locationId = existingLevels[0]?.node.location.id ?? (await this.primaryLocationId());
      const changeFromQuantity = existingLevels.find((edge) => edge.node.location.id === locationId)?.node.quantities[0]?.quantity ?? 0;

      const idempotencyKey = randomUUID();
      const setResponse = await this.graphql<InventorySetQuantitiesResponse>(
        `mutation ($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
          inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
            inventoryAdjustmentGroup { id }
            userErrors { field message }
          }
        }`,
        {
          input: {
            name: "available",
            reason: "correction",
            referenceDocumentUri: `urn:alltix-oms:inventory-sync:${idempotencyKey}`,
            quantities: [{ inventoryItemId, locationId, quantity, changeFromQuantity }],
          },
          idempotencyKey,
        },
      );
      if (setResponse.errors) {
        return { success: false, error: `Shopify inventory set failed: ${ShopifyConnector.formatGraphQLErrors(setResponse.errors, "unknown error")}` };
      }
      const userErrors = setResponse.data?.inventorySetQuantities.userErrors ?? [];
      if (userErrors.length === 0) {
        return { success: true, externalId: inventoryItemId };
      }

      lastError = ShopifyConnector.formatUserErrors(userErrors, "unknown error");
      const isStaleChangeFromQuantity = userErrors.some((e) => e.message.includes("no longer matches the persisted quantity"));
      if (!isStaleChangeFromQuantity || attempt === MAX_ATTEMPTS) {
        return { success: false, error: `${lastError} (after ${attempt} attempt${attempt === 1 ? "" : "s"})` };
      }
      // else: loop again, re-reading the (now presumably caught-up)
      // current quantity before retrying the mutation.
    }

    return { success: false, error: `${lastError} (after ${MAX_ATTEMPTS} attempts)` };
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
      // Include what was actually found, not just the fact that nothing
      // qualified -- this was previously a dead end to debug (e.g. an
      // order whose sole line item is on a third-party-fulfilled product,
      // like Shopify's own demo "3p Fulfilled" product, needs
      // write_third_party_fulfillment_orders rather than the
      // merchant-managed scope this connector is configured with by
      // default; that shows up here as either zero fulfillmentOrders
      // edges at all -- not visible to this app's scope -- or edges
      // present with a status/remainingQuantity that doesn't qualify).
      const observed = order.fulfillmentOrders.edges
        .map((edge) => `${edge.node.id} status=${edge.node.status} remaining=${edge.node.lineItems.edges.map((l) => l.node.remainingQuantity).join(",") || "none"}`)
        .join("; ");
      throw new Error(
        `Shopify order ${orderId} has no open fulfillment orders with remaining line items to ship (found ${order.fulfillmentOrders.edges.length}: ${observed || "none"})`,
      );
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

  /**
   * Creates a brand-new, single-variant Shopify product via `productSet`
   * (shopify.dev: "If your app syncs product data from an external source,
   * use the productSet mutation to add data in a single operation" -- the
   * modern replacement for the older productCreate + productVariantsBulkCreate
   * + inventorySetQuantities sequence, doing the same thing in one call).
   * Requires the `write_products` scope, which no other method in this
   * class has needed before now (see .env.example's Shopify scope list).
   * https://shopify.dev/docs/api/admin-graphql/latest/mutations/productSet
   *
   * SCOPE (an explicit decision, matching this file's "don't build
   * speculatively" discipline):
   *  - Single-variant only, one default option ("Title" / "Default Title")
   *    -- no multi-variant/option support. Same per-SKU simplification
   *    every other method in this class already makes.
   *  - Does NOT publish the product to any sales channel. Shopify's newer
   *    product model needs a *separate* `publishablePublish` mutation
   *    (against a specific publicationId, e.g. "Online Store") before a
   *    product is actually visible/purchasable -- `status: ACTIVE` on
   *    productSet alone is not enough (shopify.dev: "A product won't appear
   *    on a sales channel until published to that channel's publication,
   *    regardless of its active status"). That mutation needs its own
   *    `write_publications` scope, and whether a *custom* app (this
   *    connector's entire auth model -- see this file's header comment) can
   *    even be granted that scope, or has a "current channel" of its own to
   *    publish to at all, is genuinely unclear from shopify.dev's docs and
   *    untested. Rather than guess at an extra scope and a publish call
   *    that might silently fail for exactly the app type this connector
   *    targets, this method stops at creating an ACTIVE-status product and
   *    documents the gap instead: the tenant makes it visible with one
   *    click from their own Shopify admin (Products -> the new product ->
   *    Publish). This is *why* the caller should record
   *    channel_listings.listing_status as 'draft', not 'active', for a
   *    listing created this way -- unlike a listing catalog sync discovers
   *    (recorded 'active' because it was *already* live on Shopify by
   *    definition), one created here exists but isn't confirmed published.
   *  - Does not seed initial inventory itself -- the caller is expected to
   *    follow a successful createListing() with the existing
   *    pushInventory(sku, currentAvailableQty) call, the same absolute-set
   *    write every other inventory sync in this app already uses, rather
   *    than this method inventing a second inventory-writing code path.
   *
   * Not part of the shared ChannelConnector interface's submitListing()/
   * getFeedStatus() pair -- that shape is Walmart's async
   * submit-a-feed-then-poll pattern (see WalmartConnector.submitListing's
   * own doc comment), and productSet is a single synchronous call with no
   * feed/polling concept at all, so forcing it through a `{feedId}` handle
   * would invent a fake pending state that never actually happens. Same
   * "don't trust the interface, add a channel-specific method instead" call
   * this file already made for pullProductCatalog().
   *
   * CONFIRMED against a real dev store -- succeeded end-to-end from the
   * /products UI on the first live attempt once the app's access token
   * actually carried write_products. The `productOptions`/`optionValues`
   * shape (a single "Title" option valued "Default Title") was the part
   * flagged as riskiest pre-verification, since no worked single-variant
   * productSet example was found during research; it worked as written.
   *
   * Real-world gotcha this surfaced, not specific to this method's own
   * logic: adding write_products to a custom app and saving does not
   * retroactively grant it to an already-issued access token -- the
   * existing token keeps failing with ACCESS_DENIED ("productSet failed")
   * until the tenant reinstalls the app and reconnects with the newly
   * issued token (CLAUDE.md §4.5 records this under "Outbound listing
   * creation").
   */
  async createListing(input: ShopifyListingSubmission): Promise<ShopifyListingResult> {
    // Shopify handles must be URL-safe; derived from the SKU (stable,
    // unique per tenant) rather than the title (which a merchant could
    // reuse across products, and which may contain characters a handle
    // can't). Falls back to letting Shopify auto-generate one from the
    // title (by omitting the field, dropped from the JSON body by
    // JSON.stringify) if the SKU happens to reduce to nothing usable.
    const handle = input.internalSku
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

    const response = await this.graphql<ProductSetResponse>(
      `mutation ($input: ProductSetInput!) {
        productSet(input: $input, synchronous: true) {
          product {
            id
            variants(first: 1) {
              edges { node { id sku inventoryItem { id } } }
            }
          }
          userErrors { field message }
        }
      }`,
      {
        input: {
          title: input.title,
          handle: handle || undefined,
          status: "ACTIVE",
          productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
          variants: [
            {
              price: input.price,
              sku: input.internalSku,
              optionValues: [{ optionName: "Title", name: "Default Title" }],
            },
          ],
        },
      },
    );

    if (response.errors) {
      return {
        success: false,
        productGid: null,
        inventoryItemGid: null,
        error: `Shopify productSet failed: ${ShopifyConnector.formatGraphQLErrors(response.errors, "unknown error")}`,
      };
    }

    const userErrors = response.data?.productSet.userErrors ?? [];
    if (userErrors.length > 0) {
      return {
        success: false,
        productGid: null,
        inventoryItemGid: null,
        error: `Shopify productSet rejected: ${ShopifyConnector.formatUserErrors(userErrors, "unknown error")}`,
      };
    }

    const product = response.data?.productSet.product;
    const variant = product?.variants.edges[0]?.node;
    if (!product || !variant) {
      return { success: false, productGid: null, inventoryItemGid: null, error: "Shopify productSet returned no product/variant" };
    }

    return { success: true, productGid: product.id, inventoryItemGid: variant.inventoryItem.id, error: null };
  }
}
