import type { Pool } from "pg";
import { withTenant, decryptChannelSecret } from "@alltix/db";
import type { FulfillmentType } from "@alltix/shared";
import type { AuthToken, NormalizedOrder, NormalizedOrderLine, SyncResult, TrackingInfo } from "./connector.js";
// CLAUDE.md §4.4's in-process retry/backoff (see retry.ts's own doc
// comment) -- every call site below is a drop-in swap, not a behavior
// change for the success/hard-failure paths; only sustained 429/503s or
// thrown network errors behave differently (RateLimitExhaustedError instead
// of a response the caller's own `if (!response.ok)` would still have to
// handle, or a raw thrown fetch error).
import { fetchWithBackoff } from "./retry.js";

// SP-API auth has been LWA-only since Oct 2023 -- no AWS IAM/SigV4 signing
// required (CLAUDE.md §4.1). This is a smoke-test-only implementation:
// authenticate() plus one real sandbox call, to prove the credential chain
// works end to end before pullOrders/pushInventory/pushListing are built
// (CLAUDE.md §11.5: sandbox-first, one channel at a time).

const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";

// EU sandbox host, for a UK/EU seller account (CLAUDE.md §4.1 marketplace
// regions: NA/EU/FE each have their own SP-API host).
export const SP_API_EU_SANDBOX_BASE_URL = "https://sandbox.sellingpartnerapi-eu.amazon.com";

// NA sandbox host. Needed for pushInventory(): unlike every Orders-related
// endpoint this connector calls (which accept the EU host + a US
// marketplaceId without complaint in the sandbox), the Listings Items
// API's patchListingsItem enforces that marketplaceIds actually belong to
// the host's region -- calling the EU host with MarketplaceIds=ATVPDKIKX0DER
// (US) 403s with "The marketplaces you provided are not valid for region",
// confirmed live. Our sandbox account is US-only (per
// getMarketplaceParticipations), so pushInventory needs a connector
// constructed with this base URL, not the EU default used elsewhere.
export const SP_API_NA_SANDBOX_BASE_URL = "https://sandbox.sellingpartnerapi-na.amazon.com";

// Production hosts -- confirmed live against
// https://developer-docs.amazon.com/sp-api/docs/sp-api-endpoints, not
// assumed to mirror the sandbox names: they do turn out to be the sandbox
// hosts above with the "sandbox." prefix dropped, but that was verified,
// not guessed. Region coverage per that same page: NA = Canada/US/Mexico/
// Amazon Brazil; EU = Ireland/Spain/UK/France/Belgium/Netherlands/Germany/
// Italy/Sweden/South Africa/Poland/Saudi Arabia/Egypt/Turkey/UAE/Amazon
// India; FE = Singapore/Australia/Amazon Japan. Unused by anything in this
// file yet -- see loadAmazonProductionCredentialsFromEnv() and
// scripts/amazon-production-smoke-test.ts, both read-only, both requiring
// Arif's own real Seller Central credentials to exercise at all.
export const SP_API_NA_PRODUCTION_BASE_URL = "https://sellingpartnerapi-na.amazon.com";
export const SP_API_EU_PRODUCTION_BASE_URL = "https://sellingpartnerapi-eu.amazon.com";
export const SP_API_FE_PRODUCTION_BASE_URL = "https://sellingpartnerapi-fe.amazon.com";

// The Orders API sandbox doesn't accept an arbitrary real CreatedAfter date
// the way marketplaceParticipations accepts arbitrary input -- it pattern-
// matches CreatedAfter against a fixed set of documented literal trigger
// strings to pick a canned response; anything else (including a real
// ISO8601 date) fails with "InvalidInput: Could not match input arguments".
// This is Amazon's own official onboarding-guide example value. See
// https://developer-docs.amazon.com/sp-api/docs/onboarding-step-5-make-your-first-call-to-the-sp-api-sandbox
export const SP_API_SANDBOX_TEST_CASE_CREATED_AFTER = "TEST_CASE_200";

// Unlike GetOrders (where a real MarketplaceIds + the CreatedAfter trigger
// above returns real-looking orders with their own real AmazonOrderId
// values), the sandbox's GetOrderItems has no scenario keyed to an order's
// own id at all -- only this exact literal path segment returns 200; a real
// AmazonOrderId (including ones GetOrders itself just returned) 400s with
// the same "Could not match input arguments" error. Confirmed directly
// against the live EU sandbox while building this connector. The canned
// response always describes the same single item regardless of which
// order you ask about, so every pulled order gets identical line data in
// the sandbox -- a sandbox limitation, not a bug in this connector.
export const SP_API_SANDBOX_TEST_CASE_ORDER_ID = "TEST_CASE_200";

// GET /orders/v0/orders requires at least one MarketplaceIds value and,
// unlike getMarketplaceParticipations, actually validates it against the
// seller account's real participations -- a mismatched id fails fast with
// "InvalidInput: Could not match input arguments" rather than falling back
// to canned data. This default (US, ATVPDKIKX0DER) is only correct for a
// sandbox account provisioned for the US marketplace; confirm via
// getMarketplaceParticipations() before assuming it for a different
// account, even one calling the EU sandbox host.
export const SP_API_SANDBOX_MARKETPLACE_ID = "ATVPDKIKX0DER";

// Refresh ahead of actual expiry so an in-flight request never races a token
// that expires mid-call.
const TOKEN_REFRESH_SKEW_MS = 60_000;

export interface AmazonSandboxCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** The seller's own Amazon Merchant/Seller ID -- required as a path
   *  segment by the Listings Items API (pushInventory). Stored in
   *  channel_connections.external_account_id (CLAUDE.md §2.3 migration
   *  0012's "seller id / merchant id, channel-specific"). */
  sellerId: string;
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

export interface MarketplaceParticipation {
  marketplace: {
    id: string;
    countryCode: string;
    defaultCurrencyCode: string;
    defaultLanguageCode: string;
    domainName: string;
  };
  participation: {
    isParticipating: boolean;
    hasSuspendedListings: boolean;
  };
}

interface MarketplaceParticipationsResponse {
  payload?: MarketplaceParticipation[];
  errors?: Array<{ code: string; message: string; details?: string }>;
}

/** Raw shape of one order from the SP-API sandbox's GET /orders/v0/orders --
 *  only the fields this connector actually maps are declared; the sandbox's
 *  canned responses carry more. */
export interface AmazonOrder {
  AmazonOrderId: string;
  PurchaseDate: string;
  OrderStatus: string;
  MarketplaceId?: string;
  /** 'AFN' = Fulfilled by Amazon, 'MFN' = merchant/seller fulfilled. Lives on
   *  the order header, not per line item -- see mapFulfillmentType(). */
  FulfillmentChannel?: string;
  ShippingAddress?: Record<string, unknown>;
  BuyerInfo?: Record<string, unknown>;
}

interface GetOrdersResponse {
  payload?: { Orders: AmazonOrder[]; NextToken?: string };
  errors?: Array<{ code: string; message: string; details?: string }>;
}

/** Raw shape of one item from GET /orders/v0/orders/{orderId}/orderItems --
 *  only the fields this connector maps are declared; the sandbox's canned
 *  response carries several more (ConditionId, IsGift, etc). */
export interface AmazonOrderItem {
  ASIN: string;
  OrderItemId: string;
  /** Present for a seller-fulfilled (MFN) item; may be absent for FBA (AFN). */
  SellerSKU?: string;
  QuantityOrdered: number;
  ItemPrice?: { CurrencyCode: string; Amount: string };
}

interface GetOrderItemsResponse {
  payload?: { AmazonOrderId: string; OrderItems: AmazonOrderItem[] };
  errors?: Array<{ code: string; message: string; details?: string }>;
}

/** Response shape of PATCH/PUT /listings/2021-08-01/items/{sellerId}/{sku} --
 *  both operations return the same ListingsItemSubmissionResponse shape
 *  (confirmed from the API's own OpenAPI model, which references this one
 *  schema from both operations); reused for {@link AmazonConnector.createListing}
 *  below rather than declaring a second, identical type. */
interface ListingsPatchResponse {
  sku: string;
  status: string; // 'ACCEPTED' (normal request) | 'VALID' | 'INVALID' (mode=VALIDATION_PREVIEW)
  submissionId?: string;
  issues?: Array<{ code: string; message: string; severity: string }>;
  errors?: Array<{ code: string; message: string; details?: string }>;
}

/** Input for {@link AmazonConnector.createListing} -- the minimum data
 *  needed to attach a new seller offer to an EXISTING Amazon catalog item.
 *  Deliberately narrower than a full new-item listing, same "v1 scope" spirit
 *  as {@link ShopifyListingSubmission}/Walmart's GTIN-only Offer-Setup-by-Match
 *  scope -- see createListing()'s own doc comment for exactly why. */
export interface AmazonListingSubmission {
  /** The existing Amazon catalog item this offer attaches to. Confirmed
   *  (via a real code example found during this pass, not just prose) as
   *  the `merchant_suggested_asin` attribute -- Amazon's alternative,
   *  barcode-based matching (`externally_assigned_product_identifier`,
   *  the closer analog to Walmart's GTIN-matching flow) was only described
   *  in prose, never in a literal confirmed payload, so it isn't
   *  implemented here; a tenant must already know the ASIN. */
  asin: string;
  /** The seller's own SKU for this offer -- the path segment AND the
   *  `sku` this listing is created/found under, same "channel only knows
   *  its own SKU" convention `pushInventory()`'s own doc comment already
   *  documents for this connector. */
  sellerSku: string;
  /** Money-scalar-compatible string, e.g. "19.99" -- same convention
   *  NormalizedOrderLine.unitPrice/ShopifyListingSubmission.price already
   *  use. Submitted as `purchasable_offer`, priced in USD only (v1
   *  simplification -- this connector's `marketplaceIds` isn't threaded
   *  through to a matching currency code yet; only correct for a
   *  USD-priced US-marketplace listing). */
  price: string;
  /** Starting stock for the `fulfillment_availability` attribute --
   *  merchant-fulfilled (MFN) only, same "fulfillment_channel_code:
   *  'DEFAULT'" scope `pushInventory()` already documents; FBA/AFN
   *  inventory isn't set through this call. */
  quantity: number;
  /** Amazon's own `condition_type` attribute value, e.g. "new_new" --
   *  confirmed literal value from a real code example found during this
   *  pass. Defaults to "new_new" when omitted -- new-condition-only is
   *  this codebase's v1 scope everywhere outbound listing creation
   *  appears (Shopify/Walmart included). */
  conditionType?: string;
}

export interface AmazonListingResult {
  success: boolean;
  sku: string | null;
  error: string | null;
}

/** The PUT /listings/2021-08-01/items/{sellerId}/{sku} request body shape --
 *  only the fields {@link buildCreateListingRequestBody} actually sets are
 *  declared. */
export interface CreateListingRequestBody {
  productType: "PRODUCT";
  requirements: "LISTING_OFFER_ONLY";
  attributes: {
    merchant_suggested_asin: Array<{ value: string; marketplace_id: string }>;
    condition_type: Array<{ value: string; marketplace_id: string }>;
    purchasable_offer: Array<{
      marketplace_id: string;
      currency: string;
      our_price: Array<{ schedule: Array<{ value_with_tax: number }> }>;
    }>;
    fulfillment_availability: Array<{ fulfillment_channel_code: string; quantity: number }>;
  };
}

/** Pure request-body builder for {@link AmazonConnector.createListing}, split
 *  out the same way WalmartConnector's buildMpItemMatchFeedPayload is --
 *  provable without a live/mocked network call. See createListing()'s own
 *  doc comment for where each attribute shape was confirmed from. */
export function buildCreateListingRequestBody(
  input: AmazonListingSubmission,
  marketplaceId: string,
): CreateListingRequestBody {
  return {
    productType: "PRODUCT",
    requirements: "LISTING_OFFER_ONLY",
    attributes: {
      merchant_suggested_asin: [{ value: input.asin, marketplace_id: marketplaceId }],
      condition_type: [{ value: input.conditionType ?? "new_new", marketplace_id: marketplaceId }],
      purchasable_offer: [
        {
          marketplace_id: marketplaceId,
          currency: "USD",
          our_price: [{ schedule: [{ value_with_tax: Number(input.price) }] }],
        },
      ],
      fulfillment_availability: [{ fulfillment_channel_code: "DEFAULT", quantity: input.quantity }],
    },
  };
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name} (see .env.example)`,
    );
  }
  return value;
}

/** Reads the four AMAZON_SANDBOX_* keys from process.env, failing fast if any are missing. */
export function loadAmazonSandboxCredentialsFromEnv(): AmazonSandboxCredentials {
  return {
    clientId: readRequiredEnv("AMAZON_SANDBOX_CLIENT_ID"),
    clientSecret: readRequiredEnv("AMAZON_SANDBOX_CLIENT_SECRET"),
    refreshToken: readRequiredEnv("AMAZON_SANDBOX_REFRESH_TOKEN"),
    sellerId: readRequiredEnv("AMAZON_SANDBOX_SELLER_ID"),
  };
}

/** Same shape as {@link AmazonSandboxCredentials} (LWA credentials are
 *  structurally identical between environments) -- aliased under its own
 *  name so a caller reading loadAmazonProductionCredentialsFromEnv()'s
 *  signature isn't told it's returning "sandbox" credentials. */
export type AmazonProductionCredentials = AmazonSandboxCredentials;

/** Reads the four AMAZON_PRODUCTION_* keys from process.env, failing fast
 *  if any are missing. Mirrors {@link loadAmazonSandboxCredentialsFromEnv}
 *  exactly, with separate env var names so sandbox and production
 *  credentials can be configured side by side in the same .env without
 *  collision -- the sandbox loader and its env vars are untouched by this.
 *  These are Arif's own real Seller Central credentials, not shared
 *  sandbox-app credentials; see scripts/amazon-production-smoke-test.ts. */
export function loadAmazonProductionCredentialsFromEnv(): AmazonProductionCredentials {
  return {
    clientId: readRequiredEnv("AMAZON_PRODUCTION_CLIENT_ID"),
    clientSecret: readRequiredEnv("AMAZON_PRODUCTION_CLIENT_SECRET"),
    refreshToken: readRequiredEnv("AMAZON_PRODUCTION_REFRESH_TOKEN"),
    sellerId: readRequiredEnv("AMAZON_PRODUCTION_SELLER_ID"),
  };
}

/**
 * Reads the most recent active 'amazon' channel_connections row for a
 * tenant and decrypts its client_secret/refresh_token, via {@link withTenant}
 * so RLS scopes the lookup to `tenantId` (CLAUDE.md §2.4). Never logs the
 * decrypted values -- only returns them.
 */
export async function loadAmazonCredentialsFromChannelConnection(
  pool: Pool,
  tenantId: string,
): Promise<AmazonSandboxCredentials> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query<{
      lwa_client_id: string;
      encrypted_client_secret: Buffer;
      encrypted_refresh_token: Buffer;
      external_account_id: string;
    }>(
      `SELECT lwa_client_id, encrypted_client_secret, encrypted_refresh_token, external_account_id
         FROM channel_connections
        WHERE channel = 'amazon' AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 1`,
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(
        `No active 'amazon' channel_connections row found for tenant ${tenantId}`,
      );
    }

    const [clientSecret, refreshToken] = await Promise.all([
      decryptChannelSecret(client, row.encrypted_client_secret),
      decryptChannelSecret(client, row.encrypted_refresh_token),
    ]);

    return { clientId: row.lwa_client_id, clientSecret, refreshToken, sellerId: row.external_account_id };
  });
}

/** Builds an {@link AmazonConnector} from a tenant's channel_connections row instead of process.env. */
export async function createAmazonConnectorFromChannelConnection(
  pool: Pool,
  tenantId: string,
  baseUrl: string = SP_API_EU_SANDBOX_BASE_URL,
  marketplaceIds: string[] = [SP_API_SANDBOX_MARKETPLACE_ID],
): Promise<AmazonConnector> {
  const credentials = await loadAmazonCredentialsFromChannelConnection(pool, tenantId);
  return new AmazonConnector(credentials, baseUrl, marketplaceIds);
}

/**
 * Amazon SP-API connector -- implements authenticate(), the
 * getMarketplaceParticipations sandbox smoke-test call, pullOrders(),
 * pushInventory(), createListing(), and confirmShipment(). Does NOT
 * implement the full ChannelConnector interface; submitListing()/
 * getFeedStatus() (the async submit-then-poll pair Walmart's connector
 * implements for real) don't fit this class at all -- Amazon's own
 * outbound listing write (createListing(), below) is genuinely synchronous,
 * so it's a separate, non-interface method instead, the same shape
 * decision ShopifyConnector.createListing() already made for the same
 * reason.
 *
 * Credentials come either from process.env (the default, via
 * {@link loadAmazonSandboxCredentialsFromEnv}, used by
 * scripts/amazon-sandbox-smoke-test.ts) or from a tenant's
 * channel_connections row (via {@link createAmazonConnectorFromChannelConnection}).
 */
export class AmazonConnector {
  private readonly credentials: AmazonSandboxCredentials;
  private readonly baseUrl: string;
  private readonly marketplaceIds: string[];
  private cachedToken: CachedToken | null = null;

  constructor(
    credentials: AmazonSandboxCredentials = loadAmazonSandboxCredentialsFromEnv(),
    baseUrl: string = SP_API_EU_SANDBOX_BASE_URL,
    marketplaceIds: string[] = [SP_API_SANDBOX_MARKETPLACE_ID],
  ) {
    this.credentials = credentials;
    this.baseUrl = baseUrl;
    this.marketplaceIds = marketplaceIds;
  }

  private get sellerId(): string {
    return this.credentials.sellerId;
  }

  /** Whether this connector talks to an SP-API sandbox host (EU or NA)
   *  rather than production -- public so a caller (e.g. the scheduled
   *  order-sync job, packages/scheduler) can decide whether to pass a real
   *  computed date or the sandbox's literal CreatedAfter trigger (see
   *  SP_API_SANDBOX_TEST_CASE_CREATED_AFTER) into pullOrders(), the same
   *  substitution pullOrders()/confirmShipment() already make internally
   *  for the sandbox's order-id quirk. Checking both sandbox hosts (not
   *  just EU) matters now that a production host is a real possibility:
   *  before that, only EU sandbox was ever used for anything this method
   *  gates (NA sandbox was pushInventory-only, which never calls
   *  isSandbox()), so missing the NA case was latent, not yet a live bug --
   *  worth fixing now regardless, since a production host is by definition
   *  neither of the two sandbox ones and must always resolve to false. */
  isSandbox(): boolean {
    return this.baseUrl === SP_API_EU_SANDBOX_BASE_URL || this.baseUrl === SP_API_NA_SANDBOX_BASE_URL;
  }

  /**
   * Exchanges the refresh token for an LWA access token, caching it in
   * memory and transparently refreshing near expiry. The access token is
   * never logged, printed, or persisted -- it lives only on this instance.
   */
  async authenticate(): Promise<AuthToken> {
    const cached = this.cachedToken;
    if (cached && cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS > Date.now()) {
      return {
        accessToken: cached.accessToken,
        expiresAt: new Date(cached.expiresAtMs).toISOString(),
      };
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.credentials.refreshToken,
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
    });

    const response = await fetchWithBackoff(LWA_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!response.ok) {
      // Deliberately not including the response body: LWA error responses
      // don't echo secrets back, but there's no upside to risking it.
      throw new Error(
        `LWA token exchange failed: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
      token_type: string;
    };

    const expiresAtMs = Date.now() + data.expires_in * 1000;
    this.cachedToken = { accessToken: data.access_token, expiresAtMs };

    return {
      accessToken: data.access_token,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  /** GET /sellers/v1/marketplaceParticipations -- the sandbox smoke test call. */
  async getMarketplaceParticipations(): Promise<MarketplaceParticipation[]> {
    const { accessToken } = await this.authenticate();

    const response = await fetchWithBackoff(
      `${this.baseUrl}/sellers/v1/marketplaceParticipations`,
      {
        method: "GET",
        headers: {
          "x-amz-access-token": accessToken,
          "Content-Type": "application/json",
        },
      },
    );

    const data = (await response.json()) as MarketplaceParticipationsResponse;

    if (!response.ok) {
      const message =
        data.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ??
        response.statusText;
      throw new Error(
        `SP-API marketplaceParticipations failed: ${response.status} ${message}`,
      );
    }

    return data.payload ?? [];
  }

  /** GET /orders/v0/orders/{orderId}/orderItems -- one order's line items. */
  async getOrderItems(amazonOrderId: string): Promise<AmazonOrderItem[]> {
    const { accessToken } = await this.authenticate();

    const response = await fetchWithBackoff(
      `${this.baseUrl}/orders/v0/orders/${encodeURIComponent(amazonOrderId)}/orderItems`,
      {
        method: "GET",
        headers: {
          "x-amz-access-token": accessToken,
          "Content-Type": "application/json",
        },
      },
    );

    const data = (await response.json()) as GetOrderItemsResponse;

    if (!response.ok) {
      const message =
        data.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ??
        response.statusText;
      throw new Error(`SP-API orderItems failed: ${response.status} ${message}`);
    }

    return data.payload?.OrderItems ?? [];
  }

  /**
   * GET /orders/v0/orders with CreatedAfter=since -- pulls order headers,
   * then calls {@link getOrderItems} once per order (CLAUDE.md §4.1: line
   * items require a separate call) to populate `lines`.
   *
   * Deliberately sequential (not Promise.all/unbounded concurrency): one
   * order-items request per order is real request volume against SP-API's
   * per-tenant/per-endpoint rate limits (CLAUDE.md §4.4). Production should
   * route this through the rate-limited job queue CLAUDE.md §4.4 describes,
   * with order-status writes prioritized over it, once that queue exists;
   * plain sequential is fine at today's sandbox scale (a handful of orders).
   *
   * `since` accepts a real Date (production: converted to ISO8601) or a raw
   * string (sandbox: one of Amazon's documented literal trigger values, e.g.
   * {@link SP_API_SANDBOX_TEST_CASE_CREATED_AFTER}, which the real API would
   * reject as an invalid date but the sandbox requires instead of one).
   */
  async pullOrders(since: Date | string): Promise<NormalizedOrder[]> {
    const { accessToken } = await this.authenticate();

    const query = new URLSearchParams({
      MarketplaceIds: this.marketplaceIds.join(","),
      CreatedAfter: since instanceof Date ? since.toISOString() : since,
    });

    const response = await fetchWithBackoff(`${this.baseUrl}/orders/v0/orders?${query.toString()}`, {
      method: "GET",
      headers: {
        "x-amz-access-token": accessToken,
        "Content-Type": "application/json",
      },
    });

    const data = (await response.json()) as GetOrdersResponse;

    if (!response.ok) {
      const message =
        data.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ??
        response.statusText;
      throw new Error(`SP-API orders failed: ${response.status} ${message}`);
    }

    const orders = data.payload?.Orders ?? [];

    // The sandbox has no scenario keyed to a real AmazonOrderId (see
    // SP_API_SANDBOX_TEST_CASE_ORDER_ID) -- substitute its one documented
    // trigger there. This branch goes away once this connector talks to a
    // real (non-sandbox) base URL, where a real order's own id is correct.
    const isSandbox = this.isSandbox();

    const normalizedOrders: NormalizedOrder[] = [];
    for (const order of orders) {
      const items = await this.getOrderItems(isSandbox ? SP_API_SANDBOX_TEST_CASE_ORDER_ID : order.AmazonOrderId);
      normalizedOrders.push(normalizeAmazonOrder(order, items));
    }
    return normalizedOrders;
  }

  /**
   * PATCH /listings/2021-08-01/items/{sellerId}/{sku} -- the current
   * near-real-time path for updating one SKU's quantity. CLAUDE.md §4.1
   * previously described only the (async, bulk, submission-based) Feeds
   * API for this; that's still correct for bulk catalog/price/inventory
   * writes, but the Listings Items API's patchListingsItem is the right
   * fit here since ChannelConnector.pushInventory is single-item, and it
   * responds synchronously rather than requiring a poll-for-completion
   * feed job. See CLAUDE.md §4.1 (updated alongside this method) and
   * https://developer-docs.amazon.com/sp-api/docs/listings-items-api-v2021-08-01-use-case-guide
   *
   * Only meaningful for merchant-fulfilled (MFN) stock -- fulfillment_
   * channel_code 'DEFAULT' is the self-managed/seller-fulfilled supply
   * source; FBA (AFN) inventory isn't updated through this call at all,
   * Amazon manages it. Confirmed live: the sandbox accepts any sellerId/sku
   * and returns `status: 'ACCEPTED'` for a normal (non-preview) request --
   * it doesn't validate the SKU against a real catalog or actually persist
   * anything queryable back, so this call round-trips the request shape and
   * an HTTP-level success, not genuine state change; the sandbox's own
   * response even substitutes a random unrelated `sku` in that scenario.
   * `mode=VALIDATION_PREVIEW` with sku='VALIDATION_VALID'/'VALIDATION_INVALID'
   * are also live-confirmed canned scenarios, unused here since they don't
   * submit anything.
   */
  async pushInventory(sellerSku: string, quantity: number): Promise<SyncResult> {
    const { accessToken } = await this.authenticate();

    const response = await fetchWithBackoff(
      `${this.baseUrl}/listings/2021-08-01/items/${encodeURIComponent(this.sellerId)}/${encodeURIComponent(sellerSku)}` +
        `?marketplaceIds=${this.marketplaceIds.join(",")}`,
      {
        method: "PATCH",
        headers: {
          "x-amz-access-token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          productType: "PRODUCT",
          patches: [
            {
              op: "replace",
              path: "/attributes/fulfillment_availability",
              value: [{ fulfillment_channel_code: "DEFAULT", quantity }],
            },
          ],
        }),
      },
    );

    const data = (await response.json()) as ListingsPatchResponse;

    if (!response.ok) {
      const message =
        data.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ?? response.statusText;
      return { success: false, error: `SP-API listings patch failed: ${response.status} ${message}` };
    }

    if (data.status !== "ACCEPTED" && data.status !== "VALID") {
      const message =
        data.issues?.map((i) => `${i.code}: ${i.message}`).join("; ") ?? `unexpected status '${data.status}'`;
      return { success: false, externalId: data.sku, error: message };
    }

    return { success: true, externalId: data.sku };
  }

  /**
   * PUT /listings/2021-08-01/items/{sellerId}/{sku} -- outbound listing
   * creation, closing (in part) the "Amazon still has no outbound
   * listing-creation path at all" gap CLAUDE.md flagged once Shopify's
   * createListing() and Walmart's real submitListing() existed. `requirements:
   * "LISTING_OFFER_ONLY"` + `productType: "PRODUCT"` attaches a new seller
   * offer (price/quantity/condition) to an EXISTING Amazon catalog item
   * identified by ASIN, rather than creating a brand-new catalog item from
   * scratch.
   *
   * DELIBERATELY NARROW, same spirit as ShopifyConnector.createListing()'s
   * single-variant-only scope and WalmartConnector.submitListing()'s
   * GTIN-only scope: a full new-item listing (`requirements: "LISTING"`)
   * needs a category-specific attribute schema -- item_name, bullet_points,
   * images, and more, all varying by `productType` -- fetched from Amazon's
   * separate Product Type Definitions API first. Not built here; see
   * CLAUDE.md's own note on this scope decision.
   *
   * Same-shape, non-interface method as ShopifyConnector.createListing() --
   * NOT ChannelConnector.submitListing()/getFeedStatus() -- because this
   * call is genuinely synchronous (the outcome comes back in the same HTTP
   * response, exactly like pushInventory()'s PATCH call above), unlike
   * Walmart's real async feed submission that interface pair exists for.
   *
   * Attribute shapes below (merchant_suggested_asin, condition_type,
   * purchasable_offer, fulfillment_availability) are confirmed from real,
   * literal example payloads found in Amazon SP-API community discussions
   * (github.com/amzn/selling-partner-api-models) during this pass --
   * fulfillment_availability's shape is additionally already live-confirmed
   * in THIS codebase by pushInventory() above. UNVERIFIED AS A WHOLE
   * REQUEST, same status as everything else in this class: no live call has
   * been made against this exact PUT + requirements=LISTING_OFFER_ONLY
   * combination -- this environment's outbound network policy blocks
   * api.amazon.com entirely (confirmed while researching this feature), on
   * top of this class's pre-existing "not run against a real account"
   * status for anything beyond the original sandbox pass.
   */
  async createListing(input: AmazonListingSubmission): Promise<AmazonListingResult> {
    const { accessToken } = await this.authenticate();
    // this.marketplaceIds always has at least one entry -- both the
    // constructor's own default and createAmazonConnectorFromChannelConnection's
    // default supply a one-element array, and nothing in this class ever
    // empties it -- but noUncheckedIndexedAccess still types index access as
    // possibly-undefined, so fail loudly rather than silently sending
    // marketplace_id: undefined to a real marketplace write if that
    // invariant is ever violated.
    const marketplaceId = this.marketplaceIds[0];
    if (!marketplaceId) {
      return { success: false, sku: null, error: "AmazonConnector has no configured marketplaceIds" };
    }

    const response = await fetchWithBackoff(
      `${this.baseUrl}/listings/2021-08-01/items/${encodeURIComponent(this.sellerId)}/${encodeURIComponent(input.sellerSku)}` +
        `?marketplaceIds=${this.marketplaceIds.join(",")}`,
      {
        method: "PUT",
        headers: {
          "x-amz-access-token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildCreateListingRequestBody(input, marketplaceId)),
      },
    );

    const data = (await response.json()) as ListingsPatchResponse;

    if (!response.ok) {
      const message = data.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ?? response.statusText;
      return { success: false, sku: null, error: `SP-API listings create failed: ${response.status} ${message}` };
    }

    if (data.status !== "ACCEPTED" && data.status !== "VALID") {
      const message =
        data.issues?.map((i) => `${i.code}: ${i.message}`).join("; ") ?? `unexpected status '${data.status}'`;
      return { success: false, sku: data.sku ?? null, error: message };
    }

    return { success: true, sku: data.sku ?? input.sellerSku, error: null };
  }

  /**
   * POST /orders/v0/orders/{orderId}/shipmentConfirmation -- confirms
   * shipment with tracking info back to Amazon, the call CLAUDE.md §4.1/
   * §4.2 flagged as closing the loop from allocated through to a real
   * confirmed-shipment API call. Researched live against
   * https://developer-docs.amazon.com/sp-api/reference/confirmshipment
   * (Orders API v0 -- still the version every other method in this file
   * uses; Amazon's newer v2026-01-01 Orders API is the documented
   * migration target but out of scope for matching this file's existing
   * v0 usage).
   *
   * SP-API requires the full per-item quantity breakdown, not just an
   * order-level tracking number, so this fetches real items via
   * getOrderItems() first -- same sandbox order-id substitution as
   * pullOrders (see SP_API_SANDBOX_TEST_CASE_ORDER_ID).
   *
   * Single-package assumption (documented, not fixed by this task): every
   * item on the order ships in one package, packageReferenceId '1'.
   * carrierCode is always 'Other' with tracking.carrier passed through as
   * carrierName -- SP-API's carrierCode enum wasn't confirmed against a
   * canonical list this session, and 'Other' + carrierName is documented
   * as always a valid combination regardless of the actual carrier.
   *
   * SANDBOX LIMITATION (confirmed live, not assumed): every call this
   * connector makes to this endpoint -- against TEST_CASE_200 and a real
   * GetOrders-returned order id, with both this method's own request
   * shape and Amazon's own documented example values from
   * github.com/amzn/selling-partner-api-models issue #4329
   * (orderItemId '60696125413094', packageReferenceId '123') -- gets the
   * identical `400 InvalidInput: Could not match input arguments`. That's
   * the SP-API static sandbox's generic "no canned scenario matched"
   * response (the same shape pullOrders/getOrderItems get for an
   * unrecognized trigger), not a malformed-request or auth error -- LWA
   * auth and the request/response shape are confirmed correct against
   * live infrastructure, but this operation has no matching sandbox
   * scenario for this account, so a genuine success path can only be
   * verified against a real order in production, the same category of
   * gap CLAUDE.md §4.1 already documents for the OAuth "Connect" flow.
   */
  async confirmShipment(orderId: string, tracking: TrackingInfo): Promise<void> {
    const { accessToken } = await this.authenticate();

    const isSandbox = this.isSandbox();
    const items = await this.getOrderItems(isSandbox ? SP_API_SANDBOX_TEST_CASE_ORDER_ID : orderId);

    const response = await fetchWithBackoff(
      `${this.baseUrl}/orders/v0/orders/${encodeURIComponent(orderId)}/shipmentConfirmation`,
      {
        method: "POST",
        headers: {
          "x-amz-access-token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          marketplaceId: this.marketplaceIds[0],
          packageDetail: {
            packageReferenceId: "1",
            carrierCode: "Other",
            carrierName: tracking.carrier,
            shippingMethod: "Standard",
            trackingNumber: tracking.trackingNumber,
            shipDate: new Date(tracking.shippedAt).toISOString(),
            orderItems: items.map((item) => ({ orderItemId: item.OrderItemId, quantity: item.QuantityOrdered })),
          },
        }),
      },
    );

    if (!response.ok) {
      const data = (await response.json()) as { errors?: Array<{ code: string; message: string; details?: string }> };
      const message =
        data.errors?.map((e) => `${e.code}: ${e.message}${e.details ? ` (${e.details})` : ""}`).join("; ") ??
        response.statusText;
      throw new Error(`SP-API shipmentConfirmation failed: ${response.status} ${message}`);
    }
  }
}

function mapFulfillmentType(fulfillmentChannel: string | undefined): FulfillmentType {
  return fulfillmentChannel === "AFN" ? "fba" : "seller_fulfilled";
}

// No third-party marketplace order predates Amazon opening it up in 2000, so
// anything before that is definitionally not a real purchase timestamp.
// Confirmed live (fetched straight from the sandbox host, bypassing this
// connector entirely) that the SP-API *sandbox's own* canned TEST_CASE_200
// response embeds PurchaseDate: "1970-01-19T03:58:30Z" on every order it
// returns -- so this isn't something normalizeAmazonOrder, the INSERT into
// orders.placed_at, or the /orders page's formatting corrupts; the raw
// upstream value already *is* that string, unmodified end to end. That
// string decodes to Unix epoch *seconds* 1569510000 (2019-09-26T15:00:00Z)
// -- looks like Amazon's own fixture generator formatted a seconds-based
// timestamp as if it were milliseconds. Can't fix it at the source, so
// treat it like the other documented sandbox-only oddities in this file
// (SP_API_SANDBOX_TEST_CASE_ORDER_ID): validate before trusting it, and
// store null (orders.placed_at is nullable; /orders already renders "—")
// rather than a nonsensical prehistoric date presented as a business fact.
const EARLIEST_PLAUSIBLE_PURCHASE_DATE_MS = Date.parse("2000-01-01T00:00:00Z");

export function parsePurchaseDate(raw: string): string | null {
  const parsedMs = Date.parse(raw);
  if (Number.isNaN(parsedMs) || parsedMs < EARLIEST_PLAUSIBLE_PURCHASE_DATE_MS) {
    console.warn(`AmazonConnector: ignoring implausible PurchaseDate '${raw}' (not a real purchase timestamp)`);
    return null;
  }
  return raw;
}

function normalizeAmazonOrderLine(item: AmazonOrderItem, fulfillmentType: FulfillmentType): NormalizedOrderLine {
  return {
    externalLineId: item.OrderItemId,
    externalSku: item.SellerSKU ?? item.ASIN,
    quantity: item.QuantityOrdered,
    unitPrice: item.ItemPrice?.Amount ?? "0.00",
    fulfillmentType,
  };
}

function normalizeAmazonOrder(order: AmazonOrder, items: AmazonOrderItem[]): NormalizedOrder {
  const fulfillmentType = mapFulfillmentType(order.FulfillmentChannel);
  return {
    externalOrderId: order.AmazonOrderId,
    channel: "amazon",
    channelMarketplace: order.MarketplaceId ?? "",
    channelStatus: order.OrderStatus,
    placedAt: parsePurchaseDate(order.PurchaseDate),
    customer: order.BuyerInfo ?? {},
    shippingAddress: order.ShippingAddress ?? {},
    lines: items.map((item) => normalizeAmazonOrderLine(item, fulfillmentType)),
    rawPayload: order,
  };
}
