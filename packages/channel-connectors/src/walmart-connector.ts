import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { withTenant, decryptChannelSecret } from "@alltix/db";
import type { FulfillmentType } from "@alltix/shared";
import type {
  AuthToken,
  ChannelConnector,
  EventHandler,
  NormalizedListing,
  NormalizedOrder,
  NormalizedOrderLine,
  SyncResult,
  TrackingInfo,
} from "./connector.js";

// Walmart Marketplace API connector -- channel #2 (CLAUDE.md §8 Phase 2).
// Researched live against developer.walmart.com before writing any of this
// (same discipline as amazon-connector.ts): every endpoint/shape below is
// cited to a specific doc page. Nothing here has been exercised against a
// real Walmart environment yet -- see the "UNVERIFIED" markers throughout
// and the session report for exactly what that means and why (short
// version: getting *any* API key pair at all requires either an approved
// Walmart seller account or an approved Solution Provider application --
// there is no self-serve sandbox the way SP-API's Private-app
// self-authorization gave us for Amazon. See CLAUDE.md follow-ups.)
//
// Unlike AmazonConnector (which explicitly does NOT implement the full
// ChannelConnector interface -- see its class doc comment), this class
// does `implements ChannelConnector`, per CLAUDE.md §4.3's own instruction
// not to trust that interface until channel #2 is built against it. Three
// places where the fit is genuinely bad are flagged inline below and
// summarized in the session report; they're implemented as pragmatic
// workarounds here, not silently papered over.

const WALMART_TOKEN_URL = "https://marketplace.walmartapis.com/v3/token";

// https://developer.walmart.com/us-marketplace/docs/walmart-api-sandbox-2 --
// "route calls to https://sandbox.walmartapis.com and include WM_SANDBOX: v2".
// UNVERIFIED: whether the *token* endpoint itself is sandbox-specific or
// whether sandbox-scoped credentials exchange through the same production
// token URL above with the environment distinction living entirely in the
// resource-server host + WM_SANDBOX header. Assumed the latter (the more
// common OAuth client-credentials pattern) since no doc page fetched this
// session said otherwise -- needs confirming against a real sandbox key pair.
export const WALMART_SANDBOX_BASE_URL = "https://sandbox.walmartapis.com";
export const WALMART_PRODUCTION_BASE_URL = "https://marketplace.walmartapis.com";
const WM_SANDBOX_HEADER_VALUE = "v2";

// https://developer.walmart.com/us-marketplace/docs/retrieve-access-token-details
// -- access tokens are valid for 900s (15 min). Refreshed by re-issuing a
// client_credentials token request (sellers), not a stored refresh_token --
// that grant type is Solution-Provider/authorization_code-flow-specific per
// the token endpoint doc and isn't needed for the client_credentials path
// this connector uses.
const TOKEN_REFRESH_SKEW_MS = 60_000;

// https://developer.walmart.com/us-marketplace/docs/get-all-orders -- "By
// default, GET All orders retrieves only customer orders that you fulfill
// (SellerFulfilled)... to get WFS orders, set shipNodeType to WFSFulfilled
// instead." There is no documented "all fulfillment types" wildcard value
// -- pullOrders() below calls this once per type and merges the results,
// the same real-request-volume tradeoff CLAUDE.md §4.1 already notes for
// Amazon's per-order getOrderItems call.
const WALMART_SHIP_NODE_TYPES = ["SellerFulfilled", "WFSFulfilled", "3PLFulfilled"] as const;
// Exported for the pure-function unit tests below (test/walmart-connector.test.ts)
// to construct without depending on this module's own internal constant --
// same "export the type, not just the value, so a test can build one"
// reasoning as every other exported *Connector type in this file.
export type WalmartShipNodeType = (typeof WALMART_SHIP_NODE_TYPES)[number];

export interface WalmartCredentials {
  clientId: string;
  clientSecret: string;
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  }
  return value;
}

/** Reads the two WALMART_SANDBOX_* keys from process.env, failing fast if either is missing. */
export function loadWalmartSandboxCredentialsFromEnv(): WalmartCredentials {
  return {
    clientId: readRequiredEnv("WALMART_SANDBOX_CLIENT_ID"),
    clientSecret: readRequiredEnv("WALMART_SANDBOX_CLIENT_SECRET"),
  };
}

/**
 * Loads a tenant's own Walmart Marketplace API credentials from their
 * channel_connections row -- the per-tenant counterpart to
 * loadWalmartSandboxCredentialsFromEnv() above (which is for this repo's own
 * dev-testing script, scripts/walmart-sandbox-smoke-test.ts, not real
 * tenants). Mirrors
 * loadShopifyCredentialsFromChannelConnection/createShopifyConnectorFromChannelConnection
 * in shopify-connector.ts exactly, including the column-reuse decision:
 *
 * Unlike Amazon (a shared platform OAuth app + per-seller refresh token) or
 * Shopify (a single static access token), Walmart's client_credentials grant
 * means the tenant's own clientId+clientSecret pair -- issued directly to
 * their Walmart seller/Solution Provider account -- *is* the entire
 * long-lived credential; there is no separate refresh token to store at all
 * (see WalmartConnector.authenticate()'s own doc comment: a fresh access
 * token is derived from clientId+clientSecret every time, not refreshed from
 * a stored refresh_token). That maps cleanly onto two columns
 * channel_connections (0012) already has, both already relaxed to nullable
 * by migration 0019 for Shopify's sake:
 *  - `lwa_client_id` -- named for Amazon's OAuth client id, but generically
 *    "the channel's own OAuth client id" is exactly what a Walmart clientId
 *    is too. Reused rather than adding a new column, same reasoning 0019
 *    itself documents for encrypted_client_secret.
 *  - `encrypted_client_secret` -- Walmart's clientSecret is the same shape
 *    and sensitivity (long-lived, high-value, pgcrypto-encrypted-at-rest) as
 *    Amazon's client secret already stored here.
 *  - `encrypted_refresh_token` stays NULL for a Walmart row -- there is
 *    nothing to put in it, same as a Shopify row.
 *  - `external_account_id` (NOT NULL, part of the table's UNIQUE constraint)
 *    has no independent Walmart concept the way Amazon's seller id or
 *    Shopify's shop domain does -- the connect route sets it to the
 *    clientId itself (see that route's own comment), which is sufficient to
 *    keep one row per tenant per connected Walmart account and to show
 *    *something* identifying on /settings/channels without inventing a
 *    "Walmart Seller ID" form field this connector's calls don't actually
 *    need.
 *  - `marketplace` is stored as '' -- Walmart, like Shopify, has no
 *    per-connection marketplace/region concept this connector targets (see
 *    normalizeWalmartOrder's own channelMarketplace: "" comment); one
 *    connected account is one connection, full stop.
 */
export async function loadWalmartCredentialsFromChannelConnection(
  pool: Pool,
  tenantId: string,
): Promise<WalmartCredentials> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query<{ lwa_client_id: string | null; encrypted_client_secret: Buffer | null }>(
      `SELECT lwa_client_id, encrypted_client_secret
         FROM channel_connections
        WHERE channel = 'walmart' AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 1`,
    );

    const row = result.rows[0];
    if (!row || !row.lwa_client_id || !row.encrypted_client_secret) {
      throw new Error(`No active 'walmart' channel_connections row found for tenant ${tenantId}`);
    }

    const clientSecret = await decryptChannelSecret(client, row.encrypted_client_secret);
    return { clientId: row.lwa_client_id, clientSecret };
  });
}

/** Builds a {@link WalmartConnector} from a tenant's channel_connections row
 *  instead of process.env, always against WALMART_PRODUCTION_BASE_URL -- a
 *  real tenant connects their own real Walmart seller account, never this
 *  repo's internal sandbox (see WALMART_SANDBOX_BASE_URL's own comment: that
 *  base URL is for scripts/walmart-sandbox-smoke-test.ts only). */
export async function createWalmartConnectorFromChannelConnection(pool: Pool, tenantId: string): Promise<WalmartConnector> {
  const credentials = await loadWalmartCredentialsFromChannelConnection(pool, tenantId);
  return new WalmartConnector(credentials, WALMART_PRODUCTION_BASE_URL);
}

/** Raw shape of one order line from GET /v3/orders -- only the fields this
 *  connector maps are declared; Walmart's real payload carries several more
 *  (returnInfo, promotion, various charge subtypes, etc).
 *  UNVERIFIED: whether `orderLines` is a bare array or wrapped as
 *  `{ orderLine: [...] }` the way `orderLineStatuses`/`charges` are
 *  documented to be (see the doc comment on WalmartOrder) -- Walmart's
 *  XML-derived JSON has historically wrapped every repeated element that
 *  way, so this is modeled as wrapped, but no fetched doc page this session
 *  showed a complete raw example nailing this one field down. */
export interface WalmartOrderLine {
  lineNumber: string;
  item: { sku: string; productName?: string };
  charges?: { charge: Array<{ chargeType: string; chargeAmount: { currency: string; amount: number } }> };
  orderLineQuantity: { unitOfMeasurement: string; amount: string };
  orderLineStatuses?: { orderLineStatus: Array<{ status: string }> };
}

/** Raw shape of one order from GET /v3/orders. See
 *  https://developer.walmart.com/us-marketplace/docs/get-all-released-orders
 *  and https://developer.walmart.com/us-marketplace/docs/get-all-orders */
export interface WalmartOrder {
  purchaseOrderId: string;
  customerOrderId: string;
  orderDate: number;
  shippingInfo?: {
    postalAddress?: Record<string, unknown>;
    phone?: string;
  };
  customerEmailId?: string;
  orderLines: { orderLine: WalmartOrderLine[] };
}

interface GetOrdersResponse {
  list?: {
    meta?: { totalCount?: number; limit?: number; nextCursor?: string };
    elements?: { order?: WalmartOrder[] };
  };
}

interface WalmartErrorResponse {
  error?: Array<{ code?: string; description?: string; info?: string }>;
}

/** https://developer.walmart.com/us-marketplace/docs/list-all-feed-statuses
 *  and https://developer.walmart.com/us-marketplace/docs/feed-item-status-api-for-tracking-fitment-files
 *  -- only the fields this connector inspects (overall + per-item outcome). */
interface FeedStatusResponse {
  feedId: string;
  feedStatus: string; // e.g. 'RECEIVED' | 'INPROGRESS' | 'PROCESSED' | 'ERROR'
  itemsReceived?: number;
  itemsSucceeded?: number;
  itemsFailed?: number;
  itemDetails?: {
    itemIngestionStatus?: Array<{
      sku?: string;
      ingestionStatus?: string;
      ingestionErrors?: { ingestionError?: Array<{ code?: string; description?: string }> };
    }>;
  };
}

/** Thrown by {@link WalmartConnector.getFeedStatus} when a feed is still
 *  RECEIVED/INPROGRESS -- distinguishes "not done yet, poll again" from a
 *  genuine failure (a SyncResult with success:false), since SyncResult
 *  itself has no non-terminal state to express that. */
export class FeedStillProcessingError extends Error {
  constructor(
    public readonly feedId: string,
    public readonly feedStatus: string,
  ) {
    super(`Walmart feed ${feedId} is still ${feedStatus}`);
    this.name = "FeedStillProcessingError";
  }
}

/** Exported for unit testing (see test/walmart-connector.test.ts) -- same
 *  "pure mapping function, no network, export it so a test can call it
 *  directly" precedent normalizeShopifyOrder/normalizeShopifyProductVariant
 *  already set in shopify-connector.ts. */
export function mapShipNodeTypeToFulfillmentType(shipNodeType: WalmartShipNodeType): FulfillmentType {
  switch (shipNodeType) {
    case "WFSFulfilled":
      return "wfs";
    case "3PLFulfilled":
      return "3pl";
    case "SellerFulfilled":
    default:
      return "seller_fulfilled";
  }
}

/** Exported for unit testing -- see mapShipNodeTypeToFulfillmentType's own comment. */
export function normalizeWalmartOrderLine(line: WalmartOrderLine, fulfillmentType: FulfillmentType): NormalizedOrderLine {
  const productCharge = line.charges?.charge.find((c) => c.chargeType === "PRODUCT");
  return {
    externalLineId: line.lineNumber,
    externalSku: line.item.sku,
    quantity: Number(line.orderLineQuantity.amount),
    unitPrice: productCharge ? productCharge.chargeAmount.amount.toFixed(2) : "0.00",
    fulfillmentType,
  };
}

/** Exported for unit testing -- see mapShipNodeTypeToFulfillmentType's own comment. */
export function normalizeWalmartOrder(order: WalmartOrder, shipNodeType: WalmartShipNodeType): NormalizedOrder {
  const fulfillmentType = mapShipNodeTypeToFulfillmentType(shipNodeType);
  return {
    externalOrderId: order.purchaseOrderId,
    channel: "walmart",
    // Walmart orders don't carry a marketplace/region id the way Amazon's
    // MarketplaceId does (US Marketplace is the only one this connector
    // targets) -- left empty like Amazon's normalizeAmazonOrder does when
    // order.MarketplaceId is absent.
    channelMarketplace: "",
    channelStatus: order.orderLines.orderLine[0]?.orderLineStatuses?.orderLineStatus[0]?.status ?? "Created",
    placedAt: new Date(order.orderDate).toISOString(),
    customer: order.customerEmailId ? { email: order.customerEmailId } : {},
    shippingAddress: order.shippingInfo?.postalAddress ?? {},
    lines: order.orderLines.orderLine.map((line) => normalizeWalmartOrderLine(line, fulfillmentType)),
    rawPayload: order,
  };
}

/**
 * Walmart Marketplace API connector. Implements the full ChannelConnector
 * interface (unlike AmazonConnector) as the interface's first real stress
 * test per CLAUDE.md §4.3 -- see the class-level comment above for where
 * that fit is genuinely strained rather than clean.
 *
 * UNVERIFIED IN ITS ENTIRETY: no Walmart sandbox credentials exist yet (see
 * the session report on the Solution Provider application gate). Every
 * request shape below is transcribed from developer.walmart.com, not
 * exercised against a live endpoint -- treat this as a well-researched
 * first draft, not a proven implementation, until it's run against real
 * sandbox credentials the way amazon-connector.ts has been.
 */
export class WalmartConnector implements ChannelConnector {
  private readonly credentials: WalmartCredentials;
  private readonly baseUrl: string;
  private cachedToken: CachedToken | null = null;

  constructor(
    credentials: WalmartCredentials = loadWalmartSandboxCredentialsFromEnv(),
    baseUrl: string = WALMART_SANDBOX_BASE_URL,
  ) {
    this.credentials = credentials;
    this.baseUrl = baseUrl;
  }

  /**
   * POST /v3/token -- Basic auth (base64 client_id:client_secret),
   * grant_type=client_credentials. See
   * https://developer.walmart.com/us-marketplace/docs/get-an-access-token
   * and https://developer.walmart.com/us-marketplace/docs/retrieve-access-token-details.
   * Caches the token in memory, refreshing near its 900s expiry -- same
   * pattern as AmazonConnector.authenticate().
   */
  async authenticate(): Promise<AuthToken> {
    const cached = this.cachedToken;
    if (cached && cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS > Date.now()) {
      return { accessToken: cached.accessToken, expiresAt: new Date(cached.expiresAtMs).toISOString() };
    }

    const basicAuth = Buffer.from(`${this.credentials.clientId}:${this.credentials.clientSecret}`).toString("base64");

    const response = await fetch(WALMART_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "WM_QOS.CORRELATION_ID": randomUUID(),
        "WM_SVC.NAME": "alltix-oms",
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });

    if (!response.ok) {
      // Deliberately not including the response body -- same reasoning as
      // AmazonConnector.authenticate(): no upside to risking an accidental
      // secret echo in an error path.
      throw new Error(`Walmart token exchange failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { access_token: string; expires_in: number; token_type: string };
    const expiresAtMs = Date.now() + data.expires_in * 1000;
    this.cachedToken = { accessToken: data.access_token, expiresAtMs };

    return { accessToken: data.access_token, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  /**
   * Every non-token Marketplace API call needs WM_SEC.ACCESS_TOKEN plus a
   * fresh WM_QOS.CORRELATION_ID -- CLAUDE.md §4.2 flags this as "mandatory
   * for support escalations, build it into the HTTP client wrapper
   * globally, not per-call." This is that wrapper: every call site below
   * goes through here instead of generating its own GUID.
   */
  private async request<T>(path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data: T }> {
    const { accessToken } = await this.authenticate();

    const headers: Record<string, string> = {
      "WM_SEC.ACCESS_TOKEN": accessToken,
      "WM_QOS.CORRELATION_ID": randomUUID(),
      "WM_SVC.NAME": "alltix-oms",
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(this.baseUrl === WALMART_SANDBOX_BASE_URL ? { WM_SANDBOX: WM_SANDBOX_HEADER_VALUE } : {}),
      ...(init.headers as Record<string, string> | undefined),
    };

    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    const data = (await response.json()) as T;
    return { ok: response.ok, status: response.status, data };
  }

  private formatError(data: WalmartErrorResponse, fallback: string): string {
    return data.error?.map((e) => `${e.code ?? "?"}: ${e.description ?? e.info ?? "unknown error"}`).join("; ") ?? fallback;
  }

  /**
   * GET /v3/orders, called once per shipNodeType (see WALMART_SHIP_NODE_TYPES
   * above) and merged -- there is no single call that returns every
   * fulfillment type at once, so unlike Amazon's per-order FulfillmentChannel
   * field, the fulfillment type here comes from *which call* returned the
   * order, not a field on the order itself. This is exactly the kind of
   * structurally-different shape CLAUDE.md §4.3 expected channel #2 to
   * surface. https://developer.walmart.com/us-marketplace/docs/get-all-orders
   *
   * Sequential across the three ship-node types for the same rate-limit
   * reasoning AmazonConnector.pullOrders documents for its per-order
   * getOrderItems calls.
   */
  async pullOrders(since: Date): Promise<NormalizedOrder[]> {
    const createdStartDate = since.toISOString();
    const normalizedOrders: NormalizedOrder[] = [];

    for (const shipNodeType of WALMART_SHIP_NODE_TYPES) {
      const query = new URLSearchParams({ createdStartDate, shipNodeType });
      const { ok, status, data } = await this.request<GetOrdersResponse & WalmartErrorResponse>(
        `/v3/orders?${query.toString()}`,
      );

      if (!ok) {
        throw new Error(`Walmart orders (${shipNodeType}) failed: ${status} ${this.formatError(data, "unknown error")}`);
      }

      const orders = data.list?.elements?.order ?? [];
      for (const order of orders) {
        normalizedOrders.push(normalizeWalmartOrder(order, shipNodeType));
      }
    }

    return normalizedOrders;
  }

  /**
   * PUT /v3/inventory -- the real-time single-SKU path (CLAUDE.md §4.2),
   * confirmed distinct from the Feeds-based bulk inventory update. Fits
   * ChannelConnector.pushInventory() cleanly: genuinely synchronous, one
   * call, one result -- unlike pushListing() below.
   * https://developer.walmart.com/us-marketplace/docs/update-single-item-inventory
   *
   * NOTE (interface mismatch, shared with AmazonConnector.pushInventory):
   * the interface names this parameter `productId`, but Walmart's endpoint
   * -- like Amazon's Listings Items API -- only knows the channel's own
   * SKU. The caller must resolve the internal product_id to its
   * channel_listings.external_sku for 'walmart' before calling this; this
   * method's `productId` parameter must actually be that external SKU.
   */
  async pushInventory(productId: string, quantity: number): Promise<SyncResult> {
    const sku = productId;
    const { ok, status, data } = await this.request<
      { sku: string; quantity: { unit: string; amount: number } } & WalmartErrorResponse
    >(`/v3/inventory?sku=${encodeURIComponent(sku)}`, {
      method: "PUT",
      body: JSON.stringify({ sku, quantity: { unit: "EACH", amount: quantity } }),
    });

    if (!ok) {
      return { success: false, error: `Walmart inventory update failed: ${status} ${this.formatError(data, "unknown error")}` };
    }

    return { success: true, externalId: data.sku };
  }

  /**
   * Offer Setup by Match, the correct method for matching against an
   * existing channel_listings SKU rather than creating a new catalog item
   * (per this task's own framing), is fundamentally a Feed submission --
   * POST /v3/feeds?feedType=MP_ITEM_MATCH returns only a `feedId`; actual
   * accept/reject per SKU is only knowable by polling GET
   * /v3/feeds/{feedId} afterwards, and real feeds can take minutes. This
   * is the confirmed reason ChannelConnector.pushListing() was split into
   * submitListing()/getFeedStatus() -- Amazon's synchronous Listings Items
   * API had no equivalent shape to force this fit, so it took building
   * this connector, channel #2, to surface it.
   * https://developer.walmart.com/us-marketplace/docs/create-an-offer-for-an-existing-walmart-item
   * https://developer.walmart.com/us-marketplace/docs/list-all-feed-statuses
   *
   * REMAINING MISMATCH: NormalizedListing ({productId, channel,
   * channelMarketplace, externalSku}) doesn't carry the fields Walmart's
   * match-feed payload actually requires (price, productIdentifiers,
   * condition, shippingWeight -- see the doc page above). Rather than
   * fabricate placeholder values for a real marketplace write, this
   * throws naming the missing fields instead of submitting bad data.
   * NormalizedListing needs to grow those fields (optional,
   * channel-specific) before this can submit anything real.
   */
  async submitListing(listing: NormalizedListing): Promise<{ feedId: string }> {
    throw new Error(
      `WalmartConnector.submitListing: NormalizedListing is missing fields Walmart's Offer-Setup-by-Match feed ` +
        `requires (price, productIdentifiers, condition, shippingWeight) for sku=${listing.externalSku}. ` +
        `NormalizedListing needs to grow these before this can submit a real feed.`,
    );
  }

  /**
   * GET /v3/feeds/{feedId}?includeDetails=true -- one status query,
   * translated to a terminal SyncResult. Deliberately not a bounded-poll
   * loop: that retry cadence belongs to the caller (the rate-limited job
   * queue, CLAUDE.md §4.4), which can space calls to this method out
   * appropriately instead of a connector method blocking on its own timer.
   * https://developer.walmart.com/us-marketplace/docs/list-all-feed-statuses
   *
   * RESIDUAL GAP: feedStatus 'RECEIVED'/'INPROGRESS' is genuinely
   * non-terminal -- neither success nor failure yet -- and SyncResult has
   * no "pending" variant to express that in-band. Throwing
   * FeedStillProcessingError (instead of returning a success:false
   * SyncResult) lets a caller distinguish "poll again later" from a real
   * failure via `instanceof`, without lying about the outcome the way a
   * bounded-poll-then-give-up implementation would.
   */
  async getFeedStatus(feedId: string): Promise<SyncResult> {
    const { ok, status, data } = await this.request<FeedStatusResponse & WalmartErrorResponse>(
      `/v3/feeds/${encodeURIComponent(feedId)}?includeDetails=true`,
    );

    if (!ok) {
      return { success: false, error: `Walmart feed status lookup failed: ${status} ${this.formatError(data, "unknown error")}` };
    }

    if (data.feedStatus === "RECEIVED" || data.feedStatus === "INPROGRESS") {
      throw new FeedStillProcessingError(feedId, data.feedStatus);
    }

    if (data.feedStatus === "ERROR" || (data.itemsFailed ?? 0) > 0) {
      const perItemErrors = data.itemDetails?.itemIngestionStatus
        ?.filter((item) => item.ingestionErrors?.ingestionError?.length)
        .map(
          (item) =>
            `${item.sku ?? "?"}: ${item.ingestionErrors?.ingestionError?.map((e) => `${e.code ?? "?"}: ${e.description ?? ""}`).join(", ")}`,
        )
        .join("; ");
      return { success: false, error: perItemErrors || `Walmart feed ${feedId} ended in status ${data.feedStatus}` };
    }

    return { success: true, externalId: feedId };
  }

  /**
   * Walmart requires an order to be acknowledged before it can be shipped
   * (POST /v3/orders/{id}/acknowledge, then POST /v3/orders/{id}/shipping)
   * -- an internal two-step sequence the ChannelConnector interface
   * doesn't need to know about, so both calls happen inside this one
   * method. https://developer.walmart.com/us-marketplace/docs/acknowledge-order
   * https://developer.walmart.com/us-marketplace/docs/update-shipment-tracking-details
   *
   * INTERFACE MISMATCH: TrackingInfo carries one {carrier, trackingNumber,
   * shippedAt} for the whole order, but Walmart's shipping call is
   * per-orderLine (a multi-line order can ship in separate packages with
   * different tracking numbers). This applies the same tracking info to
   * every line, which is correct for the common single-package case but
   * can't represent a partial/split shipment. TrackingInfo would need a
   * per-line shape to fix this properly.
   */
  async confirmShipment(orderId: string, tracking: TrackingInfo): Promise<void> {
    const ackResponse = await this.request<WalmartErrorResponse>(`/v3/orders/${encodeURIComponent(orderId)}/acknowledge`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    if (!ackResponse.ok) {
      throw new Error(
        `Walmart order acknowledge failed: ${ackResponse.status} ${this.formatError(ackResponse.data, "unknown error")}`,
      );
    }

    const orderResponse = await this.request<{ order?: WalmartOrder } & WalmartErrorResponse>(
      `/v3/orders/${encodeURIComponent(orderId)}`,
    );
    if (!orderResponse.ok || !orderResponse.data.order) {
      throw new Error(
        `Walmart order lookup (for shipping) failed: ${orderResponse.status} ` +
          `${this.formatError(orderResponse.data, "unknown error")}`,
      );
    }
    const lineNumbers = orderResponse.data.order.orderLines.orderLine.map((line) => line.lineNumber);

    const shipResponse = await this.request<WalmartErrorResponse>(`/v3/orders/${encodeURIComponent(orderId)}/shipping`, {
      method: "POST",
      body: JSON.stringify({
        orderLines: lineNumbers.map((lineNumber) => ({
          lineNumber,
          trackingInfo: {
            shipDateTime: new Date(tracking.shippedAt).getTime(),
            carrierName: tracking.carrier,
            trackingNumber: tracking.trackingNumber,
          },
        })),
      }),
    });
    if (!shipResponse.ok) {
      throw new Error(
        `Walmart order shipping update failed: ${shipResponse.status} ${this.formatError(shipResponse.data, "unknown error")}`,
      );
    }
  }

  /** No-op: Walmart's Orders/Items/Inventory APIs are poll-only (GET /v3/orders
   *  on a schedule) -- there's no push-notification mechanism analogous to
   *  Amazon's Notifications API/SQS. Already anticipated by
   *  ChannelConnector.subscribeToEvents's own doc comment in connector.ts. */
  subscribeToEvents(_handler: EventHandler): void {
    // Intentionally empty.
  }
}
