import type { Pool } from "pg";
import { withTenant, decryptChannelSecret } from "@alltix/db";
import type { FulfillmentType } from "@alltix/shared";
import type { AuthToken, NormalizedOrder, NormalizedOrderLine, SyncResult, TrackingInfo } from "./connector.js";
import { EBAY_TOKEN_PRODUCTION_URL, EBAY_TOKEN_SANDBOX_URL, EBAY_OAUTH_SCOPES } from "./ebay-oauth.js";
// Same in-process retry/backoff every other connector in this package uses
// -- see retry.ts's own doc comment (CLAUDE.md §4.4).
import { fetchWithBackoff } from "./retry.js";

// eBay Sell APIs -- channel #4 (CLAUDE.md §8 Phase 5's roadmap: "eBay/TikTok
// Shop/additional channels", picked up early because the connector
// abstraction has now proven itself across three structurally different
// APIs -- Shopify's event-driven/synchronous shape, Walmart's feed/poll-
// heavy shape, Amazon's SP-API sandbox-and-Listings-Items shape). This is a
// FIRST DRAFT built from live-fetched official eBay documentation, in the
// same spirit and with the same caveats as WalmartConnector carried before
// this repo had a self-serve Walmart sandbox: no eBay sandbox/production
// credentials exist anywhere in this codebase (see .env.example), and this
// environment's outbound network policy blocks BOTH api.ebay.com and
// api.sandbox.ebay.com entirely (confirmed directly -- a token-exchange
// curl to each host was rejected at the proxy level, independent of
// credentials or code, the same class of block already documented for
// api.amazon.com in AmazonConnector's own class doc comment). So nothing in
// this file has been exercised against live infrastructure of any kind --
// UNVERIFIED IN ITS ENTIRETY, more so even than Walmart's connector (which
// at least confirmed its own request shapes against a single official doc
// page with literal JSON examples for the one payload that mattered most);
// several of this file's shapes were cross-confirmed across MULTIPLE
// independent sources (official eBay doc pages, a real OpenAPI spec file
// mirror, and community-written client-library docs) specifically because
// individual eBay doc pages fetched during this pass were frequently
// thin/templated and didn't render literal request/response examples the
// way Amazon's and Walmart's better-preserved doc pages did -- see each
// method's own doc comment for exactly what was confirmed where.
//
// V1 SCOPE: authenticate() / pullOrders() / pushInventory() /
// confirmShipment() -- the same four methods Amazon and Walmart each got
// built first, before either got outbound listing creation as a separate,
// later, explicitly-picked task -- PLUS createListing(), added once the
// prerequisite gap this file used to describe as "out of scope entirely"
// was itself closed (see fetchBusinessPolicies()/createMerchantLocation()
// below and migration 0026_channel_connections_ebay_selling_setup.sql).
// eBay's own three-step Inventory API flow (createOrReplaceInventoryItem ->
// createOffer -> publishOffer) needs tenant-level business policies
// (payment/return/fulfillment policy ids) and a merchantLocationKey --
// this codebase does NOT create business policies on a tenant's behalf
// (that's its own, bigger scope -- see fetchBusinessPolicies()'s own doc
// comment for why), only reads the ones a tenant has already set up in
// their own eBay account; merchant locations ARE created by this codebase
// (createMerchantLocation()), since that prerequisite is small and bounded
// enough to build in full, unlike business policies.

const EBAY_API_PRODUCTION_BASE_URL = "https://api.ebay.com";
/** Naming-convention inference, NOT individually doc-confirmed the way the
 *  OAuth hosts in ebay-oauth.ts are (those came with literal example URLs
 *  on an official doc page) -- api.sandbox.ebay.com is eBay's documented
 *  general pattern for every REST Sell API's sandbox host (mirroring
 *  auth.sandbox.ebay.com's own confirmed "auth." -> "auth.sandbox."
 *  pattern), consistent with community client libraries fetched during
 *  this pass, but no official doc page's literal example URL for the
 *  Fulfillment or Inventory API specifically was found to confirm this
 *  exact string during this research pass. */
export const EBAY_API_SANDBOX_BASE_URL = "https://api.sandbox.ebay.com";

/** Refresh ahead of actual expiry so an in-flight request never races a
 *  token that expires mid-call -- same value/reasoning as AmazonConnector's
 *  own TOKEN_REFRESH_SKEW_MS. */
const TOKEN_REFRESH_SKEW_MS = 60_000;

/** eBay's own documented max page size for GET /sell/fulfillment/v1/order.
 *  Exported so pullOrders()'s pagination loop is testable against it
 *  directly rather than a test re-typing the literal 200. */
export const EBAY_ORDERS_PAGE_SIZE = 200;

/** Hard cap on how many pages pullOrders() will follow in one call -- see
 *  that method's own doc comment for why this exists and why 250 (not a
 *  round "big enough" guess: 250 * EBAY_ORDERS_PAGE_SIZE = 50,000, the same
 *  figure as CLAUDE.md §0's monthly order ceiling). */
export const EBAY_ORDERS_MAX_PAGES = 250;

export interface EbayCredentials {
  clientId: string;
  clientSecret: string;
  /** A real, long-lived (per eBay's own docs: refresh_token_expires_in is
   *  47304000 seconds, ~18 months, in the one literal example fetched)
   *  OAuth refresh token -- obtained via the redirect consent flow
   *  (ebay-oauth.ts) or, for local/sandbox testing, eBay's own developer
   *  dashboard "Get a Token from eBay via Your Application" tool (a manual
   *  consent-screen click that hands back a token directly, the same
   *  self-authorization shape AMAZON_SANDBOX_REFRESH_TOKEN already relies
   *  on for this codebase's Amazon connector -- see
   *  loadAmazonSandboxCredentialsFromEnv's own doc comment). Unlike
   *  AmazonSandboxCredentials, there is no separate seller/merchant id
   *  field here: eBay's REST APIs identify the seller from the access
   *  token itself, with no Amazon-style path-segment identifier needed on
   *  any call this connector makes. */
  refreshToken: string;
  /** The four fields createListing() needs and none of the other three
   *  methods on this class do -- see migration
   *  0026_channel_connections_ebay_selling_setup.sql's own comment for why
   *  these are plain, unencrypted values (opaque ids, not secrets) and why
   *  all four are optional here: a connection created before this feature
   *  existed, or one that's never had its eBay Selling Setup form filled
   *  in, legitimately has none of them yet. createListing() checks for all
   *  four itself and fails with an actionable error rather than assuming
   *  they're present. */
  fulfillmentPolicyId?: string;
  paymentPolicyId?: string;
  returnPolicyId?: string;
  merchantLocationKey?: string;
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

interface EbayTokenRefreshSuccess {
  access_token: string;
  expires_in: number;
  token_type: string;
}

interface EbayTokenError {
  error: string;
  error_description?: string;
}

/** Raw shape of one order from GET /sell/fulfillment/v1/order -- only the
 *  fields this connector actually maps are declared (same "declare only
 *  what's mapped" convention AmazonOrder/WalmartOrder already use); the
 *  real API returns more (paymentSummary, cancelStatus, program, etc. --
 *  confirmed present via developer.ebay.com's sel:Order type reference
 *  page, fetched live during this pass). */
export interface EbayOrder {
  orderId: string;
  creationDate: string;
  orderFulfillmentStatus: string;
  buyer?: Record<string, unknown>;
  fulfillmentStartInstructions?: Array<{ shippingStep?: { shipTo?: Record<string, unknown> } }>;
  lineItems: EbayLineItem[];
}

/** Raw shape of one line item -- sku/legacyItemId/lineItemCost.value all
 *  confirmed present on the type via developer.ebay.com's sel:LineItem type
 *  reference page; a real fetched community example response
 *  (gist.github.com/ali-cedcoss/30ca29ecf7dc67c43b29873bb3e0fa01) shows a
 *  real order's lineItems WITHOUT a populated `sku` field, which is why
 *  normalizeEbayOrderLine() below falls back to legacyItemId -- sku is
 *  real but apparently not always populated (e.g. for a listing not
 *  created through the Inventory API), same "channel doesn't always have
 *  what we'd prefer" reasoning AmazonOrderItem.SellerSKU's own optional
 *  status already documents for this codebase. */
export interface EbayLineItem {
  lineItemId: string;
  sku?: string;
  legacyItemId?: string;
  title: string;
  quantity: number;
  /** "The selling price of the line item before applying any discounts...
   *  calculated by multiplying the single unit price by the number of
   *  units purchased" -- an exact quote from developer.ebay.com's own
   *  sel:LineItem field description, fetched live during this pass. This
   *  is the TOTAL for the line, not a per-unit price -- see
   *  normalizeEbayOrderLine() for the division this requires. */
  lineItemCost?: { value: string; currency: string };
}

/** `next`/`href` are eBay's standard REST collection-pagination fields --
 *  confirmed present (both populated with a full next-page URL) on a real,
 *  community-fetched example GetOrdersResponse. pullOrders() only checks
 *  `next` for truthiness (see its own doc comment for why it never fetches
 *  the literal URL) -- `href` and `total` are declared here for
 *  completeness/documentation but not read anywhere. */
interface GetOrdersResponse {
  orders?: EbayOrder[];
  total?: number;
  href?: string;
  next?: string;
}

interface EbayApiErrorResponse {
  errors?: Array<{ errorId: number; message: string; longMessage?: string }>;
}

/** GET /sell/inventory/v1/inventory_item/{sku} response / PUT request body
 *  shape -- only `sku` and `availability.shipToLocationAvailability.quantity`
 *  are declared and touched by this connector (confirmed field path via
 *  developer.ebay.com's bulk-updates.html static guide and the
 *  inventory-item-to-offer.html overview, both fetched live during this
 *  pass: "availability: Specifies quantity via shipToLocationAvailability
 *  (ship-to-home)... quantity"). `[key: string]: unknown` deliberately
 *  preserves every other field (product, condition, packageWeightAndSize,
 *  etc. -- real fields per those same pages, but not confirmed against a
 *  literal JSON example the way the quantity path is) untouched across the
 *  GET-then-PUT round trip pushInventory() does -- see that method's own
 *  doc comment for why a merge-and-PUT-back approach was chosen over
 *  constructing a full inventory item body from scratch. */
export interface EbayInventoryItem {
  sku?: string;
  availability?: {
    shipToLocationAvailability?: { quantity: number; [key: string]: unknown };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** One entry from GET /sell/account/v1/{fulfillment,payment,return}_policy
 *  -- only `id`/`name` are declared (same "declare only what's mapped"
 *  convention EbayOrder/EbayLineItem already use above); the real response
 *  carries many more policy-type-specific fields (handling time, payment
 *  methods, return window, etc.) this codebase never reads, since it only
 *  ever lets a tenant PICK an existing policy, never edits or inspects one
 *  beyond its name. */
export interface EbayBusinessPolicySummary {
  id: string;
  name: string;
}

export interface EbayBusinessPolicies {
  fulfillmentPolicies: EbayBusinessPolicySummary[];
  paymentPolicies: EbayBusinessPolicySummary[];
  returnPolicies: EbayBusinessPolicySummary[];
}

/** Response shape for all three GET .../​{fulfillment,payment,return}_policy
 *  endpoints -- confirmed as `{fulfillmentPolicyId, name, ...}` for the
 *  fulfillment case via that type's own `{fulfillmentPolicyId}` path
 *  parameter on the sibling getFulfillmentPolicy (singular) endpoint
 *  (developer.ebay.com's own Account API resource listing); the payment/
 *  return equivalents (`paymentPolicyId`/`returnPolicyId`) follow the same
 *  confirmed naming convention by direct analogy, not independently
 *  doc-confirmed each. The plural wrapper field name
 *  (`fulfillmentPolicies`/`paymentPolicies`/`returnPolicies`) is inferred
 *  from eBay's own consistent REST pluralization pattern across this API
 *  family, not confirmed from a literal rendered JSON example -- official
 *  Account API doc pages fetched during this pass rendered as thin
 *  navigation pages without one, the same limitation already documented
 *  throughout this file for several other shapes. */
interface EbayPolicyListResponse {
  fulfillmentPolicies?: Array<{ fulfillmentPolicyId: string; name: string }>;
  paymentPolicies?: Array<{ paymentPolicyId: string; name: string }>;
  returnPolicies?: Array<{ returnPolicyId: string; name: string }>;
}

/** Input for {@link EbayConnector.createMerchantLocation} -- confirmed
 *  minimum viable address shape (developer.ebay.com/api-docs/sell/static/
 *  inventory/publishing-offers.html: "address with either (city +
 *  stateOrProvince + country) OR (postalCode + country)") over-satisfied
 *  here by always collecting all four plus addressLine1, since a real
 *  merchant address realistically has all of them and eBay's own docs
 *  don't say a fuller address is ever rejected. `country` is eBay's
 *  2-letter country code (e.g. "US") -- not independently confirmed
 *  against an enum list this pass, same "confirmed the shape, not every
 *  valid value" caveat this file already carries for `shippingCarrierCode`
 *  in confirmShipment(). */
export interface EbayMerchantLocationInput {
  name: string;
  addressLine1: string;
  city: string;
  stateOrProvince: string;
  postalCode: string;
  country: string;
}

/** Input for {@link EbayConnector.createListing} -- deliberately narrower
 *  than what a full-featured eBay listing tool would collect. `categoryId`
 *  and `imageUrl` are plain tenant-supplied fields, not looked up or
 *  validated by this codebase: eBay's category taxonomy (~20,000+
 *  categories, marketplace-specific, its own separate Taxonomy API) and
 *  image hosting (this codebase has no image-upload feature anywhere) are
 *  each their own real scope this pass does not take on -- same "push a
 *  gap the automation doesn't cover onto a form field the tenant fills in
 *  themselves" pattern Walmart's own `productCategory` field already
 *  established for this codebase. A wrong categoryId is rejected by eBay
 *  itself at publishOffer() time (surfaced as this method's own `error`),
 *  not validated here. */
export interface EbayListingSubmission {
  sellerSku: string;
  title: string;
  description: string;
  imageUrl: string;
  categoryId: string;
  /** Money-scalar-compatible string, e.g. "19.99" -- same convention
   *  AmazonListingSubmission.price/ShopifyListingSubmission.price already
   *  use. USD only, same v1 simplification as every other channel's own
   *  outbound listing path in this codebase. */
  price: string;
  quantity: number;
}

export interface EbayListingResult {
  success: boolean;
  listingId: string | null;
  error: string | null;
}

/** PUT /sell/inventory/v1/inventory_item/{sku} request body shape for a
 *  brand-new item (as opposed to pushInventory()'s own GET-then-merge
 *  approach against an item that may already exist) -- condition fixed to
 *  `"NEW"`, same "new-condition-only is this codebase's v1 scope
 *  everywhere outbound listing creation appears" rule
 *  AmazonListingSubmission's own doc comment already documents. */
export interface CreateEbayInventoryItemBody {
  condition: "NEW";
  product: { title: string; description: string; imageUrls: string[] };
  availability: { shipToLocationAvailability: { quantity: number } };
}

export function buildEbayInventoryItemBody(input: EbayListingSubmission): CreateEbayInventoryItemBody {
  return {
    condition: "NEW",
    product: { title: input.title, description: input.description, imageUrls: [input.imageUrl] },
    availability: { shipToLocationAvailability: { quantity: input.quantity } },
  };
}

/** POST /sell/inventory/v1/offer request body shape -- field names
 *  (categoryId, listingDescription, listingPolicies.{fulfillmentPolicyId,
 *  paymentPolicyId, returnPolicyId}, merchantLocationKey, pricingSummary,
 *  availableQuantity, format, marketplaceId) confirmed via
 *  community-fetched generated API-client docs
 *  (github.com/zVPS/ebay-sell-inventory-php-client's OfferApi.md) cross-
 *  referenced against developer.ebay.com's own publishing-offers.html
 *  prose description, since the official createOffer reference page itself
 *  rendered as a thin navigation page without a literal request-body
 *  example -- same cross-source confirmation discipline as every other
 *  eBay shape in this file. `format: "FIXED_PRICE"` and
 *  `marketplaceId: "EBAY_US"` are hardcoded -- no per-region/format concept
 *  is threaded through this codebase's eBay wiring anywhere else either
 *  (normalizeEbayOrder's own `channelMarketplace: ""`). */
export interface CreateEbayOfferBody {
  sku: string;
  marketplaceId: "EBAY_US";
  format: "FIXED_PRICE";
  availableQuantity: number;
  categoryId: string;
  listingDescription: string;
  listingPolicies: { fulfillmentPolicyId: string; paymentPolicyId: string; returnPolicyId: string };
  merchantLocationKey: string;
  pricingSummary: { price: { value: string; currency: "USD" } };
}

export function buildEbayOfferBody(
  input: EbayListingSubmission,
  listingPolicies: { fulfillmentPolicyId: string; paymentPolicyId: string; returnPolicyId: string },
  merchantLocationKey: string,
): CreateEbayOfferBody {
  return {
    sku: input.sellerSku,
    marketplaceId: "EBAY_US",
    format: "FIXED_PRICE",
    availableQuantity: input.quantity,
    categoryId: input.categoryId,
    listingDescription: input.description,
    listingPolicies,
    merchantLocationKey,
    pricingSummary: { price: { value: input.price, currency: "USD" } },
  };
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  }
  return value;
}

/** Reads the three EBAY_SANDBOX_* keys from process.env, failing fast if any are missing. */
export function loadEbaySandboxCredentialsFromEnv(): EbayCredentials {
  return {
    clientId: readRequiredEnv("EBAY_SANDBOX_CLIENT_ID"),
    clientSecret: readRequiredEnv("EBAY_SANDBOX_CLIENT_SECRET"),
    refreshToken: readRequiredEnv("EBAY_SANDBOX_REFRESH_TOKEN"),
  };
}

/**
 * Reads the most recent active 'ebay' channel_connections row for a tenant
 * and decrypts its client_secret/refresh_token, via {@link withTenant} so
 * RLS scopes the lookup to `tenantId` (CLAUDE.md §2.4) -- same shape as
 * loadAmazonCredentialsFromChannelConnection, the closer analog of the two
 * existing credential loaders since eBay's own auth model (real refresh
 * token, real OAuth consent) matches Amazon's, not Walmart's
 * client_credentials pair. Never logs the decrypted values -- only returns
 * them.
 */
export async function loadEbayCredentialsFromChannelConnection(pool: Pool, tenantId: string): Promise<EbayCredentials> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query<{
      lwa_client_id: string;
      encrypted_client_secret: Buffer;
      encrypted_refresh_token: Buffer;
      ebay_fulfillment_policy_id: string | null;
      ebay_payment_policy_id: string | null;
      ebay_return_policy_id: string | null;
      ebay_merchant_location_key: string | null;
    }>(
      `SELECT lwa_client_id, encrypted_client_secret, encrypted_refresh_token,
              ebay_fulfillment_policy_id, ebay_payment_policy_id,
              ebay_return_policy_id, ebay_merchant_location_key
         FROM channel_connections
        WHERE channel = 'ebay' AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 1`,
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(`No active 'ebay' channel_connections row found for tenant ${tenantId}`);
    }

    const [clientSecret, refreshToken] = await Promise.all([
      decryptChannelSecret(client, row.encrypted_client_secret),
      decryptChannelSecret(client, row.encrypted_refresh_token),
    ]);

    return {
      clientId: row.lwa_client_id,
      clientSecret,
      refreshToken,
      fulfillmentPolicyId: row.ebay_fulfillment_policy_id ?? undefined,
      paymentPolicyId: row.ebay_payment_policy_id ?? undefined,
      returnPolicyId: row.ebay_return_policy_id ?? undefined,
      merchantLocationKey: row.ebay_merchant_location_key ?? undefined,
    };
  });
}

/** Builds an {@link EbayConnector} from a tenant's channel_connections row
 *  instead of process.env -- always against EBAY_API_PRODUCTION_BASE_URL,
 *  never this repo's internal sandbox host, same "a real tenant is
 *  connecting their real seller account" reasoning
 *  createWalmartConnectorFromChannelConnection's own doc comment gives. */
export async function createEbayConnectorFromChannelConnection(pool: Pool, tenantId: string): Promise<EbayConnector> {
  const credentials = await loadEbayCredentialsFromChannelConnection(pool, tenantId);
  return new EbayConnector(credentials, EBAY_API_PRODUCTION_BASE_URL);
}

/**
 * eBay Sell API connector -- implements authenticate(), pullOrders(),
 * pushInventory(), and confirmShipment(), plus createListing()/
 * fetchBusinessPolicies()/createMerchantLocation() for outbound listing
 * creation (see this file's header comment). Deliberately does NOT
 * implement the full ChannelConnector interface (no submitListing()/
 * getFeedStatus()) -- createListing() is a separate, non-interface method,
 * the same shape decision Amazon's/Shopify's own createListing() each made
 * (CLAUDE.md §4.3), since eBay's publishOffer() is genuinely synchronous,
 * not a submit-then-poll feed the way Walmart's real submitListing()/
 * getFeedStatus() pair is. subscribeToEvents() has no eBay analog built
 * here either, same "no-op for poll-only channels" status Walmart/Amazon
 * both carry (CLAUDE.md §4.2/§4.3).
 *
 * Credentials come either from process.env (the default, via
 * {@link loadEbaySandboxCredentialsFromEnv}) or from a tenant's
 * channel_connections row (via
 * {@link createEbayConnectorFromChannelConnection}) -- same two-source
 * pattern every other connector in this file uses.
 */
export class EbayConnector {
  private readonly credentials: EbayCredentials;
  private readonly baseUrl: string;
  private cachedToken: CachedToken | null = null;

  constructor(
    credentials: EbayCredentials = loadEbaySandboxCredentialsFromEnv(),
    baseUrl: string = EBAY_API_SANDBOX_BASE_URL,
  ) {
    this.credentials = credentials;
    this.baseUrl = baseUrl;
  }

  /** Whether this connector talks to eBay's sandbox host rather than
   *  production -- public for the same reason AmazonConnector.isSandbox()
   *  is (a caller, e.g. the scheduler, may need to branch on it), though
   *  nothing in this connector actually branches on it internally today --
   *  unlike Amazon's SP-API sandbox, no eBay-sandbox-specific canned-data
   *  quirk has been documented (or could be, given this environment can't
   *  reach either host at all -- see this file's header comment). */
  isSandbox(): boolean {
    return this.baseUrl === EBAY_API_SANDBOX_BASE_URL;
  }

  /**
   * Exchanges the refresh token for a short-lived access token, caching it
   * in memory and transparently refreshing near expiry -- same
   * caching/skew shape as AmazonConnector.authenticate(). POST
   * /identity/v1/oauth2/token, grant_type=refresh_token, HTTP Basic
   * client_id:client_secret -- confirmed request shape (including the
   * literal example response, which notably does NOT include a new
   * refresh_token on this grant type, unlike the authorization_code grant
   * ebay-oauth.ts's exchangeEbayAuthorizationCode() uses) from
   * developer.ebay.com/api-docs/static/oauth-auth-code-grant-request.html,
   * fetched live during this pass. The access token is never logged,
   * printed, or persisted -- it lives only on this instance.
   */
  async authenticate(): Promise<AuthToken> {
    const cached = this.cachedToken;
    if (cached && cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS > Date.now()) {
      return { accessToken: cached.accessToken, expiresAt: new Date(cached.expiresAtMs).toISOString() };
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.credentials.refreshToken,
      scope: EBAY_OAUTH_SCOPES.join(" "),
    });

    const response = await fetchWithBackoff(this.isSandbox() ? EBAY_TOKEN_SANDBOX_URL : EBAY_TOKEN_PRODUCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${this.credentials.clientId}:${this.credentials.clientSecret}`).toString("base64")}`,
      },
      body,
    });

    const data = (await response.json()) as EbayTokenRefreshSuccess | EbayTokenError;

    if (!response.ok || !("access_token" in data)) {
      const message = "error" in data ? `${data.error}: ${data.error_description ?? ""}`.trim() : response.statusText;
      throw new Error(`eBay refresh-token exchange failed: ${response.status} ${message}`);
    }

    const expiresAtMs = Date.now() + data.expires_in * 1000;
    this.cachedToken = { accessToken: data.access_token, expiresAtMs };

    return { accessToken: data.access_token, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  private async authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const { accessToken } = await this.authenticate();
    return fetchWithBackoff(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${accessToken}` },
    });
  }

  /**
   * GET /sell/fulfillment/v1/order?filter=creationdate:[since..] -- pulls
   * orders whose creationDate is at/after `since`. Base URL/scope
   * (`sell.fulfillment`/`sell.fulfillment.readonly`) confirmed from a real
   * OpenAPI spec file mirror
   * (github.com/rwth-acis/apis-guru-statistics/.../ebay.comsell-fulfillment.json,
   * fetched live during this pass -- more reliable than the official doc
   * page for this specific detail, which rendered as a thin navigation
   * page without it). The `filter=creationdate:[...]` range-filter syntax
   * (date, two literal dots, percent-encoded brackets) is confirmed from
   * developers.ebay.com/api-docs/sell/static/orders/discovering-unfulfilled-orders.html's
   * own literal example, fetched live during this pass -- unlike
   * Amazon/Walmart, eBay's date filter takes a real, unbounded-open-ended
   * range (no separate sandbox-vs-production literal-trigger quirk to
   * special-case here).
   *
   * PAGINATION -- previously a real, documented, NOT-fixed gap: this used
   * to fetch only the first EBAY_ORDERS_PAGE_SIZE-order page and ignore the
   * response's own `next`/`href` fields entirely, so a tenant with more new
   * orders than that since their last sync silently lost the rest until a
   * later run's own `since` cursor happened to land past them (a real gap
   * at this codebase's target scale, CLAUDE.md §0: up to 50,000
   * orders/month -- one seller's single busy day could plausibly exceed
   * 200 new orders). Now loops on `data.next` (confirmed present on a real,
   * community-fetched example response -- see GetOrdersResponse's own
   * comment) until either a page comes back with no `next`, or a page comes
   * back with zero orders despite claiming one (defensive: a malformed/
   * looping response must not spin forever). Deliberately does NOT fetch
   * the literal `next` URL eBay returns -- that URL embeds eBay's own host,
   * and blindly following a response-supplied absolute URL is exactly the
   * class of bug the real Amazon SP-API 403 production incident this
   * codebase already fixed once came from (a connector silently talking to
   * the wrong host). Instead, `next`'s presence is only ever treated as a
   * boolean "is there another page," and the next page is requested the
   * same way every other page is: through authorizedFetch(), against
   * this.baseUrl, with the offset advanced by one page's worth. Bounded by
   * EBAY_ORDERS_MAX_PAGES as a hard safety cap -- not expected to ever be
   * hit at this codebase's target scale (250 pages * 200/page = 50,000
   * orders, deliberately the same figure as CLAUDE.md §0's own monthly
   * ceiling), but a cap that can never be hit isn't a cap; hitting it logs a
   * warning and returns what was collected rather than looping forever or
   * throwing away an otherwise-successful sync.
   */
  async pullOrders(since: Date): Promise<NormalizedOrder[]> {
    const filter = `creationdate:[${since.toISOString()}..]`;
    const allOrders: EbayOrder[] = [];

    for (let page = 0; page < EBAY_ORDERS_MAX_PAGES; page++) {
      const offset = page * EBAY_ORDERS_PAGE_SIZE;
      const query = new URLSearchParams({ filter, limit: String(EBAY_ORDERS_PAGE_SIZE), offset: String(offset) });

      const response = await this.authorizedFetch(`/sell/fulfillment/v1/order?${query.toString()}`, { method: "GET" });
      const data = (await response.json()) as GetOrdersResponse & EbayApiErrorResponse;

      if (!response.ok) {
        const message = data.errors?.map((e) => `${e.errorId}: ${e.message}`).join("; ") ?? response.statusText;
        throw new Error(`eBay getOrders failed: ${response.status} ${message}`);
      }

      const pageOrders = data.orders ?? [];
      allOrders.push(...pageOrders);

      if (!data.next || pageOrders.length === 0) {
        return allOrders.map(normalizeEbayOrder);
      }
    }

    console.warn(
      `eBay getOrders: hit the ${EBAY_ORDERS_MAX_PAGES}-page pagination safety cap (${allOrders.length} orders) ` +
        `without exhausting \`next\` -- returning what was collected instead of looping further. ` +
        `If this fires in practice, the cap (not the loop) needs raising.`,
    );
    return allOrders.map(normalizeEbayOrder);
  }

  /**
   * GET then PUT /sell/inventory/v1/inventory_item/{sku} -- narrower than
   * Amazon's/Walmart's own pushInventory() in a specific way neither of
   * those needs: eBay's own docs explicitly state quantity "must be
   * updated at both the inventory item and offer level" for a live
   * listing's displayed quantity to actually change (confirmed from
   * developer.ebay.com's bulk-updates.html static guide, fetched live
   * during this pass) -- the offer-level half needs an offerId this
   * codebase has no onboarding flow to ever capture anywhere (see this
   * file's header comment on why listing creation is out of scope
   * entirely), so this method only ever does the inventory-item half. That
   * means a SKU with an existing PUBLISHED offer may not show the new
   * quantity live on eBay even though this call succeeds -- a real,
   * documented gap, not a theoretical one, same spirit as Amazon's/
   * Walmart's own "MFN/DEFAULT fulfillment channel only" pushInventory()
   * narrowing.
   *
   * GET-then-merge-then-PUT (rather than constructing a full inventory
   * item body from scratch) is deliberate: createOrReplaceInventoryItem is
   * a full REPLACE, and this codebase doesn't have a confirmed-against-a-
   * literal-example shape for the `product`/`condition`/
   * `packageWeightAndSize` fields a from-scratch body would need (see
   * EbayInventoryItem's own doc comment) -- fetching whatever's already
   * there and only touching the one field this call is actually
   * responsible for avoids ever submitting fabricated data for fields it
   * has no business touching. A 404 GET (no inventory item exists yet for
   * this SKU -- expected for any SKU that was never created through the
   * Inventory API, since listing creation isn't built here) is treated as
   * a clean failure, not an attempt to self-heal by constructing one.
   *
   * Content-Language: en-US is sent on the PUT -- confirmed required
   * (community-fetched generated API-client docs list it alongside
   * Content-Type/Accept/Authorization as createOrReplaceInventoryItem's
   * required headers) but hardcoded rather than threaded through from
   * anywhere, the same "USD-only, no per-marketplace currency mapping"
   * simplification AmazonConnector.createListing()'s own doc comment
   * already accepts for this codebase's v1 scope. `productId` here is the
   * eBay SKU (`channel_listings.external_sku`), same "the interface's
   * productId parameter must actually be the channel's own SKU" contract
   * WalmartConnector.pushInventory()'s own doc comment documents -- the
   * caller resolves that mapping before calling in.
   */
  async pushInventory(productId: string, quantity: number): Promise<SyncResult> {
    const path = `/sell/inventory/v1/inventory_item/${encodeURIComponent(productId)}`;

    const getResponse = await this.authorizedFetch(path, { method: "GET" });
    if (!getResponse.ok) {
      const data = (await getResponse.json().catch(() => ({}))) as EbayApiErrorResponse;
      const message = data.errors?.map((e) => `${e.errorId}: ${e.message}`).join("; ") ?? getResponse.statusText;
      return { success: false, error: `eBay getInventoryItem failed: ${getResponse.status} ${message}` };
    }
    const existing = (await getResponse.json()) as EbayInventoryItem;

    const merged: EbayInventoryItem = {
      ...existing,
      availability: {
        ...existing.availability,
        shipToLocationAvailability: { ...existing.availability?.shipToLocationAvailability, quantity },
      },
    };

    const putResponse = await this.authorizedFetch(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Content-Language": "en-US" },
      body: JSON.stringify(merged),
    });

    if (!putResponse.ok) {
      const data = (await putResponse.json().catch(() => ({}))) as EbayApiErrorResponse;
      const message = data.errors?.map((e) => `${e.errorId}: ${e.message}`).join("; ") ?? putResponse.statusText;
      return { success: false, error: `eBay createOrReplaceInventoryItem failed: ${putResponse.status} ${message}` };
    }

    return { success: true, externalId: productId };
  }

  /**
   * GET one order (for its lineItems), then POST
   * /sell/fulfillment/v1/order/{orderId}/shipping_fulfillment -- confirmed
   * endpoint pattern and body field names (lineItems, shippedDate,
   * shipmentTrackingNumber, shippingCarrierCode) from
   * developer.ebay.com/api-docs/sell/fulfillment/overview.html, fetched
   * live during this pass; NOT confirmed against a literal JSON example
   * the way Amazon's/Walmart's own confirmShipment() request bodies were
   * -- that page described the fields in prose, not a rendered example.
   *
   * Single-fulfillment assumption (documented, not fixed by this task,
   * same shape as AmazonConnector.confirmShipment()'s own "single-package"
   * note): every line item on the order ships together in one
   * shipping_fulfillment call, with the SAME tracking info applied to
   * every line -- correct for the common single-package case, doesn't
   * represent a split/partial shipment. `shippingCarrierCode` is set
   * directly from `tracking.carrier` with no mapping/validation against
   * eBay's own carrier-code enum (unlike Amazon's confirmShipment(), which
   * deliberately uses the always-valid 'Other' + carrierName combination
   * documented there -- no equivalent always-valid fallback value was
   * confirmed for eBay during this pass, so this is a real, undocumented
   * risk: an arbitrary carrier string may be rejected by eBay's own enum
   * validation).
   */
  async confirmShipment(orderId: string, tracking: TrackingInfo): Promise<void> {
    const orderResponse = await this.authorizedFetch(`/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}`, {
      method: "GET",
    });
    if (!orderResponse.ok) {
      const data = (await orderResponse.json().catch(() => ({}))) as EbayApiErrorResponse;
      const message = data.errors?.map((e) => `${e.errorId}: ${e.message}`).join("; ") ?? orderResponse.statusText;
      throw new Error(`eBay getOrder failed: ${orderResponse.status} ${message}`);
    }
    const order = (await orderResponse.json()) as EbayOrder;

    const response = await this.authorizedFetch(`/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}/shipping_fulfillment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lineItems: order.lineItems.map((item) => ({ lineItemId: item.lineItemId, quantity: item.quantity })),
        shippedDate: new Date(tracking.shippedAt).toISOString(),
        shipmentTrackingNumber: tracking.trackingNumber,
        shippingCarrierCode: tracking.carrier,
      }),
    });

    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as EbayApiErrorResponse;
      const message = data.errors?.map((e) => `${e.errorId}: ${e.message}`).join("; ") ?? response.statusText;
      throw new Error(`eBay createShippingFulfillment failed: ${response.status} ${message}`);
    }
  }

  /**
   * GET /sell/account/v1/{fulfillment,payment,return}_policy (three calls,
   * `?marketplace_id=EBAY_US` each -- confirmed query param name via
   * community-fetched generated API-client docs, since the official
   * getFulfillmentPolicies reference page itself rendered thin) -- lets a
   * tenant PICK from business policies they've already created in their
   * own eBay seller account. This codebase does NOT create, edit, or
   * delete a tenant's business policies (createFulfillmentPolicy et al.
   * are real eBay Account API endpoints this connector never calls) --
   * each policy type has its own real required-field surface (handling
   * time, payment methods accepted, return window/cost, category-specific
   * overrides) that amounts to its own onboarding flow, a strictly bigger
   * scope than a merchant location's plain address (see
   * createMerchantLocation() below, which this codebase DOES build in
   * full). A tenant with no policies of a given type gets back an empty
   * array for it, not an error -- createListing() is what actually
   * enforces all three being chosen.
   *
   * Requires the `sell.account.readonly` scope added to EBAY_OAUTH_SCOPES
   * for this feature -- see that constant's own doc comment for the
   * reconnect-required caveat for any connection made before this scope
   * existed.
   */
  async fetchBusinessPolicies(): Promise<EbayBusinessPolicies> {
    const marketplaceId = "EBAY_US";
    const [fulfillment, payment, returnPolicy] = await Promise.all([
      this.authorizedFetch(`/sell/account/v1/fulfillment_policy?marketplace_id=${marketplaceId}`, { method: "GET" }),
      this.authorizedFetch(`/sell/account/v1/payment_policy?marketplace_id=${marketplaceId}`, { method: "GET" }),
      this.authorizedFetch(`/sell/account/v1/return_policy?marketplace_id=${marketplaceId}`, { method: "GET" }),
    ]);

    async function parseOrThrow(response: Response, label: string): Promise<EbayPolicyListResponse> {
      const data = (await response.json().catch(() => ({}))) as EbayPolicyListResponse & EbayApiErrorResponse;
      if (!response.ok) {
        const message = data.errors?.map((e) => `${e.errorId}: ${e.message}`).join("; ") ?? response.statusText;
        throw new Error(`eBay get${label}Policies failed: ${response.status} ${message}`);
      }
      return data;
    }

    const [fulfillmentData, paymentData, returnData] = await Promise.all([
      parseOrThrow(fulfillment, "Fulfillment"),
      parseOrThrow(payment, "Payment"),
      parseOrThrow(returnPolicy, "Return"),
    ]);

    return {
      fulfillmentPolicies: (fulfillmentData.fulfillmentPolicies ?? []).map((p) => ({ id: p.fulfillmentPolicyId, name: p.name })),
      paymentPolicies: (paymentData.paymentPolicies ?? []).map((p) => ({ id: p.paymentPolicyId, name: p.name })),
      returnPolicies: (returnData.returnPolicies ?? []).map((p) => ({ id: p.returnPolicyId, name: p.name })),
    };
  }

  /**
   * POST /sell/inventory/v1/location/{merchantLocationKey} -- confirmed
   * endpoint/response shape (204 No Content on success, no body) via
   * community-fetched generated API-client docs
   * (github.com/sapientpro/ebay-inventory-sdk-php's LocationApi.md); the
   * exact required-vs-optional field breakdown within the request body
   * wasn't confirmed the same way, so this sends every field
   * {@link EbayMerchantLocationInput} collects rather than guessing which
   * are safe to omit -- overs-supplying an address field eBay doesn't
   * strictly require is far lower-risk than omitting one it does.
   * `merchantLocationKey` (path segment, max 36 chars per eBay's own docs)
   * is caller-supplied, not generated here -- the API route calling this
   * derives one from the tenant id.
   */
  async createMerchantLocation(
    merchantLocationKey: string,
    input: EbayMerchantLocationInput,
  ): Promise<{ success: boolean; error: string | null }> {
    const response = await this.authorizedFetch(`/sell/inventory/v1/location/${encodeURIComponent(merchantLocationKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: input.name,
        locationTypes: ["WAREHOUSE"],
        location: {
          address: {
            addressLine1: input.addressLine1,
            city: input.city,
            stateOrProvince: input.stateOrProvince,
            postalCode: input.postalCode,
            country: input.country,
          },
        },
      }),
    });

    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as EbayApiErrorResponse;
      const message = data.errors?.map((e) => `${e.errorId}: ${e.message}`).join("; ") ?? response.statusText;
      return { success: false, error: `eBay createInventoryLocation failed: ${response.status} ${message}` };
    }
    return { success: true, error: null };
  }

  /**
   * The three-step eBay Inventory API flow: PUT
   * /sell/inventory/v1/inventory_item/{sku} (createOrReplaceInventoryItem,
   * a brand-new item -- see {@link buildEbayInventoryItemBody}, distinct
   * from pushInventory()'s own GET-then-merge approach against a
   * possibly-already-existing item), POST /sell/inventory/v1/offer
   * (createOffer -- see {@link buildEbayOfferBody}), then POST
   * /sell/inventory/v1/offer/{offerId}/publish/ (publishOffer, no request
   * body, path param only) -- confirmed step order and endpoint shapes
   * from developer.ebay.com's own inventory-item-to-offer.html/
   * publishing-offers.html overview pages, cross-referenced against
   * community-fetched generated API-client docs for the literal field
   * names neither official page rendered. Returns the new `listingId`
   * (confirmed field name/type via the OfferResponseWithListingId type
   * reference page) on success.
   *
   * Fails fast, before any network call, if this connector's credentials
   * are missing any of the three business policy ids or the merchant
   * location key (see {@link EbayCredentials}' own doc comment) -- a
   * tenant hasn't finished the /settings/channels eBay Selling Setup form
   * yet, and eBay's own publishOffer() would reject the offer anyway
   * ("All three policies are required to publish offers..." per
   * publishing-offers.html) but only after two prior calls already
   * succeeded, leaving an unpublished offer behind. Checking here instead
   * means a tenant sees one clear, actionable error immediately.
   *
   * Content-Language: en-US hardcoded on the inventory-item PUT, same
   * "USD-only, no per-marketplace mapping" simplification pushInventory()
   * already documents for this method's sibling.
   */
  async createListing(input: EbayListingSubmission): Promise<EbayListingResult> {
    const { fulfillmentPolicyId, paymentPolicyId, returnPolicyId, merchantLocationKey } = this.credentials;
    if (!fulfillmentPolicyId || !paymentPolicyId || !returnPolicyId || !merchantLocationKey) {
      return {
        success: false,
        listingId: null,
        error:
          "eBay business policies and/or merchant location are not configured -- set them up under " +
          "Settings -> Channels before creating a listing.",
      };
    }

    const itemResponse = await this.authorizedFetch(
      `/sell/inventory/v1/inventory_item/${encodeURIComponent(input.sellerSku)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json", "Content-Language": "en-US" },
        body: JSON.stringify(buildEbayInventoryItemBody(input)),
      },
    );
    if (!itemResponse.ok) {
      const data = (await itemResponse.json().catch(() => ({}))) as EbayApiErrorResponse;
      const message = data.errors?.map((e) => `${e.errorId}: ${e.message}`).join("; ") ?? itemResponse.statusText;
      return { success: false, listingId: null, error: `eBay createOrReplaceInventoryItem failed: ${itemResponse.status} ${message}` };
    }

    const offerResponse = await this.authorizedFetch(`/sell/inventory/v1/offer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Language": "en-US" },
      body: JSON.stringify(buildEbayOfferBody(input, { fulfillmentPolicyId, paymentPolicyId, returnPolicyId }, merchantLocationKey)),
    });
    const offerData = (await offerResponse.json().catch(() => ({}))) as { offerId?: string } & EbayApiErrorResponse;
    if (!offerResponse.ok || !offerData.offerId) {
      const message = offerData.errors?.map((e) => `${e.errorId}: ${e.message}`).join("; ") ?? offerResponse.statusText;
      return { success: false, listingId: null, error: `eBay createOffer failed: ${offerResponse.status} ${message}` };
    }

    const publishResponse = await this.authorizedFetch(
      `/sell/inventory/v1/offer/${encodeURIComponent(offerData.offerId)}/publish/`,
      { method: "POST" },
    );
    const publishData = (await publishResponse.json().catch(() => ({}))) as { listingId?: string } & EbayApiErrorResponse;
    if (!publishResponse.ok || !publishData.listingId) {
      const message = publishData.errors?.map((e) => `${e.errorId}: ${e.message}`).join("; ") ?? publishResponse.statusText;
      return { success: false, listingId: null, error: `eBay publishOffer failed: ${publishResponse.status} ${message}` };
    }

    return { success: true, listingId: publishData.listingId, error: null };
  }
}

/** Every eBay line item maps to `seller_fulfilled` -- eBay's marketplace
 *  model has no widely-available Amazon-FBA-style "fulfilled by the
 *  channel" program mapped anywhere in this codebase's FulfillmentType
 *  union ('fba'/'wfs'/'3pl' are Amazon/Walmart/3PL-specific concepts with
 *  no confirmed eBay equivalent researched this pass), same defensive-
 *  default reasoning AmazonConnector's own mapFulfillmentType() default
 *  branch documents. */
function mapFulfillmentType(): FulfillmentType {
  return "seller_fulfilled";
}

export function normalizeEbayOrderLine(item: EbayLineItem): NormalizedOrderLine {
  const quantity = item.quantity;
  const lineTotal = item.lineItemCost ? Number(item.lineItemCost.value) : 0;
  const unitPrice = quantity > 0 && Number.isFinite(lineTotal) ? (lineTotal / quantity).toFixed(2) : "0.00";

  return {
    externalLineId: item.lineItemId,
    externalSku: item.sku ?? item.legacyItemId ?? item.lineItemId,
    quantity,
    unitPrice,
    fulfillmentType: mapFulfillmentType(),
  };
}

export function normalizeEbayOrder(order: EbayOrder): NormalizedOrder {
  return {
    externalOrderId: order.orderId,
    channel: "ebay",
    // No per-region/marketplace concept surfaced anywhere on the Order
    // type by any doc page fetched this pass (unlike Amazon's
    // MarketplaceId) -- same "no per-region concept" '' default
    // WalmartConnector's own normalizeWalmartOrder() already uses.
    channelMarketplace: "",
    placedAt: order.creationDate,
    channelStatus: order.orderFulfillmentStatus,
    customer: order.buyer ?? {},
    shippingAddress: order.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo ?? {},
    lines: order.lineItems.map(normalizeEbayOrderLine),
    rawPayload: order,
  };
}
