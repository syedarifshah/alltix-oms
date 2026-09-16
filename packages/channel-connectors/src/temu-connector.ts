import type { Pool } from "pg";
import crypto from "node:crypto";
import { withTenant, decryptChannelSecret } from "@alltix/db";
import type { FulfillmentType } from "@alltix/shared";
import type { AuthToken, NormalizedOrder, NormalizedOrderLine, SyncResult, TrackingInfo } from "./connector.js";
// Same in-process retry/backoff every other connector in this package uses
// -- see retry.ts's own doc comment (CLAUDE.md §4.4).
import { fetchWithBackoff } from "./retry.js";

// Temu Open/Partner Platform -- channel #5. Arif's explicit decision (an
// AskUserQuestion pick, not a guess): "Full connector, like eBay" -- the
// same v1 base scope eBay's connector had BEFORE its own later, separate
// createListing() addition: authenticate() / pullOrders() / pushInventory()
// / confirmShipment() only. No outbound listing creation this pass.
//
// RESEARCH TRAIL, worth reading before touching this file -- Temu's
// official docs turned out to be the LEAST accessible of any channel in
// this codebase, worse than eBay's merely-thin doc pages:
//   - partner-us.temu.com / partner-eu.temu.com / partner.temu.com are a
//     PURE JAVASCRIPT SPA -- every single page fetched during this pass
//     (including a literal "Signature Method for API request" page and a
//     literal "bg.local.goods.stock.edit" reference page, both surfaced by
//     search with real titles) returned only "You need to enable
//     JavaScript to run this app." No official Temu documentation content
//     was readable at all, for anything, this entire research pass.
//   - Pivoted to the real, installed community Python SDK `temu_api`
//     (PyPI, v0.2.1, github.com/XIE7654/temu_api) -- installed into a
//     scratch venv and its source read directly (utils/base_client.py,
//     api/{auth,order,fulfillment,logistics,product}.py). This is the
//     PRIMARY source for everything in this file that IS confirmed: the
//     base URL pattern, the signing algorithm, every request parameter
//     name declared below. Same "an installed package's real source is
//     more authoritative than a rendered doc page" precedent this
//     codebase's own Sentry integration already established.
//   - The Python SDK's own `request()` method returns `response.json()`
//     directly with NO response-envelope parsing of its own (its
//     `ApiResponse` class is vestigial -- constructed nowhere) -- meaning
//     even the installed SDK does not confirm what a response actually
//     looks like on success OR failure. Every other source tried to find
//     one (a community Go SDK, a third-party integration doc site, a
//     GitHub repo whose README named literal example-response filenames)
//     either rendered no example, truncated before showing one, or --in
//     one specific case worth flagging -- turned out to document a
//     same-named but entirely UNRELATED third-party Temu-product-scraping
//     API (idatariver.com's, not Temu's own Open Platform), which would
//     have been a wrong confirmation if used. So: the response envelope
//     (`success`/`errorCode`/`errorMsg`/`result` below) and every RESPONSE
//     field name in this file (as opposed to REQUEST field names, which
//     the installed SDK does confirm) are this codebase's best-effort
//     inference from Temu's own consistent camelCase request-naming
//     convention and common Alibaba-TOP-API-gateway-style envelope shapes
//     -- genuinely unconfirmed, not a documented fact. See each type/method
//     below for exactly what's confirmed where.
//
// Given that, this connector carries a heavier UNVERIFIED status than any
// other channel in this codebase, including eBay -- eBay's own doc pages
// were thin/templated but still rendered real request shapes and, for
// several fields, literal response examples; nothing here got that far.
// This is a well-researched first draft in the same spirit as every other
// connector's own first pass (CLAUDE.md §7: sandbox-first, never a guess
// submitted straight to production), not a proven implementation -- no
// Temu credentials of any kind exist anywhere in this codebase yet either
// (see .env.example's TEMU_* entries).

/** The one confirmed example base URL from the installed SDK's own README
 *  usage examples (US region) -- Temu's Open Platform very likely has
 *  region-specific hosts the way Amazon's SP-API does (NA/EU/FE), but no
 *  second region's literal host string was found anywhere in this research
 *  pass to confirm a pattern from. Single-host only, same "don't guess a
 *  second value from one confirmed example" discipline as this codebase's
 *  own EBAY_API_SANDBOX_BASE_URL comment. */
export const TEMU_API_PRODUCTION_BASE_URL = "https://openapi-b-us.temu.com";

export interface TemuCredentials {
  /** Issued to a Temu Open Platform application -- the closest analog to
   *  every other connector's clientId in this file's credential model. */
  appKey: string;
  /** Never sent on the wire directly -- only ever used to compute
   *  {@link buildTemuSignature}. High-value, same pgcrypto-encrypted-at-rest
   *  treatment as every other connector's client secret in this codebase. */
  appSecret: string;
  /** Used directly on every signed request (see {@link buildTemuRequestBody})
   *  -- unlike Amazon's/eBay's refresh token, nothing in the installed SDK's
   *  source exchanges this for a shorter-lived token or refreshes it; it's
   *  a long-lived credential closer in shape to Shopify's static
   *  shpat_... access token than to an OAuth refresh token, just issued as
   *  a third value alongside appKey/appSecret rather than alone. */
  accessToken: string;
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  }
  return value;
}

/** Reads the three TEMU_* keys from process.env -- no SANDBOX/PRODUCTION
 *  split the way every other channel's env-sourced credentials have, since
 *  no distinct Temu sandbox environment/host was confirmed anywhere in this
 *  research pass to split against (same "no self-serve sandbox" starting
 *  position Walmart's connector carried, just one step further -- Walmart
 *  at least had a documented sandbox HOST it simply had no account for). */
export function loadTemuCredentialsFromEnv(): TemuCredentials {
  return {
    appKey: readRequiredEnv("TEMU_APP_KEY"),
    appSecret: readRequiredEnv("TEMU_APP_SECRET"),
    accessToken: readRequiredEnv("TEMU_ACCESS_TOKEN"),
  };
}

/**
 * Reads the most recent active 'temu' channel_connections row for a tenant
 * -- via {@link withTenant} so RLS scopes the lookup to `tenantId`
 * (CLAUDE.md §2.4), same shape as every other loadXCredentialsFromChannelConnection
 * in this package. No new migration needed: Temu's three-value credential
 * (appKey/appSecret/accessToken) reuses existing columns exactly the way
 * Walmart's/eBay's own connect routes already reuse `lwa_client_id` for a
 * non-Amazon client id -- lwa_client_id holds appKey (also reused into
 * external_account_id, same "no independent seller id, so reuse the client
 * id to keep the UNIQUE constraint meaningful" pattern Walmart/eBay both
 * established), encrypted_client_secret holds appSecret, and
 * encrypted_access_token (added by migration 0019_channel_connections_shopify.sql
 * for Shopify's static token) holds accessToken -- the identical semantic
 * (a long-lived, high-value, pgcrypto-encrypted token used directly on
 * every call, never exchanged) Shopify's own row already uses that column
 * for, just under a different channel.
 */
export async function loadTemuCredentialsFromChannelConnection(pool: Pool, tenantId: string): Promise<TemuCredentials> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query<{
      lwa_client_id: string;
      encrypted_client_secret: Buffer;
      encrypted_access_token: Buffer | null;
    }>(
      `SELECT lwa_client_id, encrypted_client_secret, encrypted_access_token
         FROM channel_connections
        WHERE channel = 'temu' AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 1`,
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(`No active 'temu' channel_connections row found for tenant ${tenantId}`);
    }
    if (!row.encrypted_access_token) {
      throw new Error(`Temu channel_connections row for tenant ${tenantId} has no access token stored`);
    }

    const [appSecret, accessToken] = await Promise.all([
      decryptChannelSecret(client, row.encrypted_client_secret),
      decryptChannelSecret(client, row.encrypted_access_token),
    ]);

    return { appKey: row.lwa_client_id, appSecret, accessToken };
  });
}

/** Builds a {@link TemuConnector} from a tenant's channel_connections row --
 *  always against TEMU_API_PRODUCTION_BASE_URL, no sandbox host to choose
 *  between (see this file's header comment), same "a real tenant is
 *  connecting their real seller account" reasoning every other
 *  createXConnectorFromChannelConnection in this package already gives. */
export async function createTemuConnectorFromChannelConnection(pool: Pool, tenantId: string): Promise<TemuConnector> {
  const credentials = await loadTemuCredentialsFromChannelConnection(pool, tenantId);
  return new TemuConnector(credentials, TEMU_API_PRODUCTION_BASE_URL);
}

function temuMd5Uppercase(text: string): string {
  return crypto.createHash("md5").update(text, "utf8").digest("hex").toUpperCase();
}

/** How a single param value is stringified before being concatenated into
 *  the signature -- confirmed for scalars (the installed Python SDK just
 *  does Python's `f"{value}"`, identical to a plain string/number cast).
 *  For an array/object value, the Python SDK instead relies on Python's
 *  default `str(list)`/`str(dict)` repr (single-quoted) and then does a
 *  blanket `.replace("'", '"')` on the WHOLE concatenated string to turn it
 *  into JSON-shaped double quotes -- this codebase's runtime doesn't need
 *  that workaround at all, since `JSON.stringify` already produces the
 *  double-quoted shape the Python code is approximating. NOT independently
 *  confirmed against Temu's own signing spec either way (unfetchable, see
 *  this file's header comment) -- only against the installed SDK's own
 *  source, which itself never signs an array/object-valued param in any
 *  endpoint this connector actually calls (pushInventory's
 *  skuStockTargetList is the one exception, and that request body is
 *  already flagged as this connector's least-confirmed piece -- see
 *  {@link TemuConnector.pushInventory}). */
function temuParamValueToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * Confirmed verbatim from the installed `temu_api` Python SDK's
 * `BaseClient._get_sign()` (utils/base_client.py, read in full from the
 * real installed package): sort every param key alphabetically, concatenate
 * each as `key` immediately followed by `value` (no separator between
 * pairs, no separator between key and value), strip spaces, wrap the result
 * as `appSecret + concatenated + appSecret`, MD5, uppercase hex. `sign`
 * itself is never included in the params passed to this function -- the
 * caller ({@link buildTemuRequestBody}) computes it last and adds it after.
 *
 * This is the one piece of this connector confirmed from REAL SOURCE CODE,
 * not inference -- but still not independently confirmed against Temu's own
 * official signing documentation (that page rendered as an unfetchable JS
 * SPA both times this pass tried it, including via its own literal,
 * search-surfaced title "Signature Method for API request" -- see this
 * file's header comment). A community SDK actually used against real Temu
 * infrastructure by its own userbase is strong evidence, not proof.
 */
export function buildTemuSignature(params: Record<string, unknown>, appSecret: string): string {
  const concatenated = Object.keys(params)
    .sort()
    .map((key) => `${key}${temuParamValueToString(params[key])}`)
    .join("")
    .replace(/ /g, "");
  return temuMd5Uppercase(`${appSecret}${concatenated}${appSecret}`);
}

/** Confirmed verbatim from `BaseClient._params()` -- every request carries
 *  `type` (the specific API method being called, e.g.
 *  "bg.order.list.v2.get" -- this gateway dispatches on this single field
 *  rather than exposing a distinct URL per operation, the same
 *  Alibaba-TOP-API-style single-endpoint-plus-`type`-param design common
 *  among Chinese e-commerce open platforms), `app_key`, `access_token`,
 *  a unix-seconds `timestamp`, and a fixed `data_type: "JSON"` -- plus
 *  whatever operation-specific params the caller supplies, with any
 *  null/undefined entries filtered out first (`filter_none` in the Python
 *  SDK) so an omitted optional field is never signed as the literal string
 *  "null"/"undefined". `sign` is computed over this whole object (via
 *  {@link buildTemuSignature}) and appended last, after everything else is
 *  final. */
export function buildTemuRequestBody(
  apiType: string,
  credentials: TemuCredentials,
  extraParams: Record<string, unknown> = {},
): Record<string, unknown> {
  const filteredExtra = Object.fromEntries(Object.entries(extraParams).filter(([, value]) => value !== null && value !== undefined));

  const base: Record<string, unknown> = {
    type: apiType,
    app_key: credentials.appKey,
    access_token: credentials.accessToken,
    timestamp: Math.round(Date.now() / 1000),
    data_type: "JSON",
    ...filteredExtra,
  };

  return { ...base, sign: buildTemuSignature(base, credentials.appSecret) };
}

/** Temu's own response envelope shape is UNCONFIRMED -- see this file's
 *  header comment for the full list of sources tried and exhausted. This is
 *  this codebase's best-effort inference: a `success`/`result` pair, with
 *  `errorCode`/`errorMsg` on failure, matching the common envelope shape of
 *  Alibaba-TOP-API-style gateways this platform's single type-dispatched
 *  /openapi/router endpoint otherwise closely resembles, and the
 *  consistently camelCase field-naming convention every REQUEST field this
 *  file confirms from real SDK source already uses. Genuinely a guess, not
 *  a documented fact -- same "inferred from a consistent pattern, not a
 *  literal example" caveat EbayBusinessPolicies' own response wrapper field
 *  names carry in ebay-connector.ts, just with less to go on here. */
interface TemuApiResponse<T> {
  success?: boolean;
  errorCode?: number;
  errorMsg?: string;
  result?: T;
}

interface TemuOrderListResult {
  /** Wrapper field name for the list of order headers -- UNCONFIRMED, same
   *  status as {@link TemuApiResponse} itself; chosen for consistency with
   *  this API family's own `<noun>List` request-param naming convention
   *  (parentOrderSnList, fulfillmentTypeList -- confirmed real request
   *  field names from api/order.py). */
  orderList?: TemuOrder[];
  total?: number;
  [key: string]: unknown;
}

interface TemuOrderDetailResult {
  /** Same unconfirmed wrapper-name guess as {@link TemuOrderListResult},
   *  reused here for the per-order line-item list bg.order.detail.v2.get
   *  returns -- genuinely could be a different name; no example of either
   *  response was found to confirm or distinguish them. */
  orderList?: TemuOrderLine[];
  [key: string]: unknown;
}

/** One order header from bg.order.list.v2.get's result -- field names are
 *  this codebase's best-effort inference from that endpoint's own CONFIRMED
 *  request parameters (parentOrderSnList, regionId, parentOrderStatus,
 *  createAfter/createBefore -- all real, from api/order.py's own
 *  list_orders_v2() signature, read from the installed SDK), on the
 *  reasonable assumption a response echoes the same field names its own
 *  request filters by. NOT confirmed against any literal rendered response
 *  example -- see this file's header comment. `[key: string]: unknown`
 *  preserves everything this codebase doesn't map, same "declare only
 *  what's mapped" convention every other connector's raw-order type in this
 *  package uses. */
export interface TemuOrder {
  parentOrderSn: string;
  parentOrderStatus?: number | string;
  /** Unix seconds -- guessed from the request's own createAfter/createBefore
   *  being unix-seconds values (confirmed convention: list_orders_v2's own
   *  docstring and pullOrders()'s own use of it below). */
  createTime?: number;
  regionId?: number;
  [key: string]: unknown;
}

/** One line item from bg.order.detail.v2.get's result -- same
 *  inferred-from-request-params status as {@link TemuOrder}, with even less
 *  to infer from (detail_order_v2's own request signature only confirms
 *  `parentOrderSn`/`fulfillmentTypeList` as INPUT, nothing about the shape
 *  of individual line items in its output). `orderSn` here is a SUB-order
 *  number, distinct from the parent order's own `parentOrderSn` -- see
 *  bg.order.fulfillment.info.sync's own docstring
 *  ("订单号（子订单号）" = "order number (sub-order number)"), the one place
 *  this distinction is actually confirmed anywhere in this research pass. */
export interface TemuOrderLine {
  orderSn?: string;
  goodsId?: string | number;
  skuId?: string | number;
  quantity?: number;
  goodsName?: string;
  /** Unconfirmed field name for this line's unit price. */
  currencyPrice?: number | string;
  [key: string]: unknown;
}

/** Every Temu line maps to `seller_fulfilled` -- Temu does have its own
 *  fulfillment-model concepts (bg.order.fulfillment.info.sync's
 *  `fulfillmentType` param distinguishes "0-FBA订单"/"1-非FBA订单", i.e. an
 *  FBA-style vs. non-FBA order, echoing Amazon's own FBA terminology), but
 *  no confirmed mapping from that concept onto this codebase's own
 *  `FulfillmentType` union ('fba'/'wfs'/'3pl' are Amazon/Walmart/3PL-specific
 *  concepts with no researched Temu equivalent) was found this pass -- same
 *  defensive-default reasoning EbayConnector's own mapFulfillmentType()
 *  documents for an identical gap. */
function mapFulfillmentType(): FulfillmentType {
  return "seller_fulfilled";
}

export function normalizeTemuOrderLine(line: TemuOrderLine): NormalizedOrderLine {
  const quantity = typeof line.quantity === "number" ? line.quantity : 0;
  const price = line.currencyPrice !== undefined ? Number(line.currencyPrice) : NaN;
  return {
    externalLineId: String(line.orderSn ?? line.skuId ?? ""),
    externalSku: String(line.skuId ?? line.orderSn ?? ""),
    quantity,
    unitPrice: Number.isFinite(price) ? price.toFixed(2) : "0.00",
    fulfillmentType: mapFulfillmentType(),
  };
}

export function normalizeTemuOrder(header: TemuOrder, lines: TemuOrderLine[]): NormalizedOrder {
  return {
    externalOrderId: header.parentOrderSn,
    channel: "temu",
    // No per-region marketplace concept confirmed anywhere in this
    // research pass (regionId exists but was never confirmed to map onto
    // anything resembling Amazon's MarketplaceId) -- same '' default
    // WalmartConnector's/EbayConnector's own normalize functions already
    // use for an identical "nothing confirmed to put here" gap.
    channelMarketplace: "",
    placedAt: header.createTime ? new Date(header.createTime * 1000).toISOString() : null,
    channelStatus: String(header.parentOrderStatus ?? ""),
    customer: {},
    // Deliberately empty -- bg.order.shippinginfo.v2.get (a real, confirmed,
    // separate endpoint per api/order.py's shippinginfo_order_v2()) is a
    // THIRD call this v1 pass doesn't make, on top of the list+detail pair
    // pullOrders() already does per order (budget/scope narrowing, same
    // spirit as Amazon's own "order headers vs. a separate line-items call"
    // split CLAUDE.md §4.1 documents, just one call further for Temu).
    // extractUsShippingZip() (packages/order-service/src/index.ts) has no
    // 'temu' case in its channel switch, so a Temu order's nearest-location
    // ranking simply falls back to the pre-existing oldest-created-first
    // default -- a real, documented gap, not a crash risk.
    shippingAddress: {},
    lines: lines.map(normalizeTemuOrderLine),
    rawPayload: { header, lines },
  };
}

/** {@link TemuConnector.pushInventory}'s compound productId, split out as
 *  its own type/parser since nothing else in this file needs it. */
export interface TemuProductId {
  goodsId: string;
  skuId: string;
}

/** Splits `"<goodsId>:<skuId>"` -- see {@link TemuConnector.pushInventory}'s
 *  own doc comment for why productId is a compound string for this channel
 *  specifically, unlike every other connector's plain-SKU productId. */
export function parseTemuProductId(productId: string): TemuProductId {
  const [goodsId, skuId] = productId.split(":");
  if (!goodsId || !skuId) {
    throw new Error(`TemuConnector: productId must be "<goodsId>:<skuId>", got "${productId}"`);
  }
  return { goodsId, skuId };
}

/**
 * Temu Open Platform connector -- implements authenticate(), pullOrders(),
 * pushInventory(), and confirmShipment() only (this file's header comment:
 * Arif's explicit "Full connector, like eBay" scope decision, meaning
 * eBay's own ORIGINAL four-method v1 build, before its later, separate
 * createListing() addition). Deliberately does NOT `implements
 * ChannelConnector` and has no submitListing()/getFeedStatus()/
 * subscribeToEvents() -- same shape as AmazonConnector/EbayConnector, not
 * WalmartConnector (the one connector in this package that actually
 * implements the full shared interface, because it has real
 * submitListing()/getFeedStatus() methods to back it).
 *
 * Credentials come either from process.env (the default, via
 * {@link loadTemuCredentialsFromEnv}) or from a tenant's channel_connections
 * row (via {@link createTemuConnectorFromChannelConnection}) -- same
 * two-source pattern every other connector in this package uses.
 *
 * UNVERIFIED IN ITS ENTIRETY, more so than any other channel in this
 * codebase including eBay -- see this file's header comment for the full
 * research trail and exactly why. No Temu credentials of any kind exist
 * anywhere in this codebase yet (see .env.example's TEMU_* entries), and
 * unlike eBay this environment's network policy was never even the
 * limiting factor here -- Temu's own documentation was simply never
 * readable at all, by any method tried.
 */
export class TemuConnector {
  private readonly credentials: TemuCredentials;
  private readonly baseUrl: string;

  constructor(credentials: TemuCredentials = loadTemuCredentialsFromEnv(), baseUrl: string = TEMU_API_PRODUCTION_BASE_URL) {
    this.credentials = credentials;
    this.baseUrl = baseUrl;
  }

  /** POST {baseUrl}/openapi/router with a signed body (see
   *  {@link buildTemuRequestBody}) -- confirmed as the correct HTTP method
   *  for every endpoint this connector calls: `utils/helpers.py`'s
   *  `action(path, method="POST")` decorator defaults to POST, and none of
   *  the four endpoints this connector uses (bg.open.accesstoken.info.get,
   *  bg.order.list.v2.get, bg.order.detail.v2.get,
   *  bg.order.fulfillment.info.sync, bg.local.goods.stock.edit) override
   *  it in the installed SDK's own source -- so, unlike the Python SDK's
   *  own request() (which branches on method for GET-vs-POST), this
   *  connector only ever needs the POST/JSON-body path.
   *
   *  Response handling is necessarily defensive given the unconfirmed
   *  envelope (see {@link TemuApiResponse}'s own doc comment): treats an
   *  explicit `success: false` OR a response with no `result` field at all
   *  as a failure, so a wrong guess about the success/failure field names
   *  still fails safely (no result to work with) rather than silently
   *  returning `undefined` to a caller expecting real data. */
  private async request<T>(apiType: string, extraParams: Record<string, unknown> = {}): Promise<T> {
    const body = buildTemuRequestBody(apiType, this.credentials, extraParams);

    const response = await fetchWithBackoff(`${this.baseUrl}/openapi/router`, {
      method: "POST",
      headers: { "content-type": "application/json;charset=UTF-8" },
      body: JSON.stringify(body),
    });

    const data = (await response.json().catch(() => ({}))) as TemuApiResponse<T>;

    if (!response.ok || data.success === false) {
      const detail = [data.errorCode, data.errorMsg].filter((v) => v !== undefined && v !== "").join(": ");
      throw new Error(`Temu ${apiType} failed: ${response.status}${detail ? ` ${detail}` : ` ${response.statusText}`}`);
    }
    if (data.result === undefined) {
      throw new Error(`Temu ${apiType} succeeded but returned no 'result' payload`);
    }
    return data.result;
  }

  /**
   * bg.open.accesstoken.info.get -- per its own docstring, lets a caller
   * "view the API permissions associated with their currently authorized
   * token." The closest thing this SDK exposes to a verify-these-
   * credentials-work call, so it does double duty here: unlike Amazon's/
   * eBay's authenticate() (a real token EXCHANGE, caching a short-lived
   * result), Temu's accessToken is used directly on every signed request
   * with nothing to exchange or refresh (see {@link TemuCredentials}' own
   * doc comment) -- this method's only real job is proving the
   * appKey/appSecret/accessToken triple actually authenticates.
   * `expiresAt` is a far-future placeholder, the same one
   * ShopifyConnector.authenticate() uses for its own non-expiring static
   * token -- no expiry field was confirmed anywhere in this research pass.
   */
  async authenticate(): Promise<AuthToken> {
    await this.request<unknown>("bg.open.accesstoken.info.get");
    return { accessToken: this.credentials.accessToken, expiresAt: "9999-12-31T23:59:59.000Z" };
  }

  /**
   * Two calls per discovered order, mirroring this codebase's own Amazon
   * precedent exactly (CLAUDE.md §4.1: "Orders API: pulls order headers;
   * order line items require a separate call"): bg.order.list.v2.get for
   * headers (filtered by `createAfter`, unix seconds -- the closest
   * confirmed analog to every other connector's own `since` cursor), then
   * bg.order.detail.v2.get(parentOrderSn) per header for that order's line
   * items. pageSize is capped at 100 with NO pagination loop beyond the
   * first page -- a real, documented gap, same "not a theoretical one, a
   * real narrowing" status EbayConnector.pullOrders()'s own 200-row/
   * no-pagination gap carries; Temu's own max pageSize wasn't confirmed
   * either, 100 is this codebase's own conservative choice matching
   * common TOP-API page-size caps.
   *
   * A single order's detail call failing does NOT abort the whole pull --
   * that order is still returned, just with an empty `lines` array and a
   * logged warning, same per-item error isolation philosophy
   * syncShopifyCatalogForTenant's own per-variant try/catch already
   * establishes in packages/scheduler.
   */
  async pullOrders(since: Date): Promise<NormalizedOrder[]> {
    const createAfter = Math.floor(since.getTime() / 1000);

    const listResult = await this.request<TemuOrderListResult>("bg.order.list.v2.get", {
      pageNumber: 1,
      pageSize: 100,
      createAfter,
    });
    const headers = listResult.orderList ?? [];

    const orders: NormalizedOrder[] = [];
    for (const header of headers) {
      let lines: TemuOrderLine[] = [];
      try {
        const detail = await this.request<TemuOrderDetailResult>("bg.order.detail.v2.get", {
          parentOrderSn: header.parentOrderSn,
        });
        lines = detail.orderList ?? [];
      } catch (err) {
        console.error(
          `TemuConnector.pullOrders: bg.order.detail.v2.get failed for parentOrderSn=${header.parentOrderSn}, ` +
            `returning that order with no line items:`,
          err instanceof Error ? err.message : err,
        );
      }
      orders.push(normalizeTemuOrder(header, lines));
    }
    return orders;
  }

  /**
   * bg.local.goods.stock.edit -- structurally different from every other
   * connector's pushInventory() in this package: Temu's own confirmed
   * request fields (api/product.py, read from the installed SDK) are
   * `goodsId` (required) plus `skuStockTargetList`/`skuStockChangeList`
   * (arrays of per-SKU entries under that one parent listing), not a flat
   * single-SKU identifier the way Amazon/Walmart/eBay/Shopify all are. This
   * interface's own `pushInventory(productId, quantity)` signature has no
   * room for a compound (goodsId, skuId) key -- so, since nothing in this
   * codebase calls pushInventory() generically across channels today (every
   * existing call site is channel-specific, e.g.
   * ShopifyConnector.pushInventory() called directly with that channel's
   * own plain SKU -- confirmed by grepping every `.pushInventory(` call
   * site in this repo before writing this), `productId` here is
   * DELIBERATELY a compound string, `"<goodsId>:<skuId>"`, parsed by
   * {@link parseTemuProductId}. A Temu channel_listings row stores goodsId
   * in `external_id` and skuId in `external_sku` (§2.1's existing
   * external_id/external_sku pair -- every other channel only ever
   * populates one of the two meaningfully, Temu needs both).
   *
   * Uses `skuStockTargetList` (an ABSOLUTE target quantity) rather than
   * `skuStockChangeList` (a relative delta) -- same "the system of truth
   * pushes absolute, not relative" reasoning
   * ShopifyConnector.pushInventory()'s own doc comment gives for choosing
   * `inventorySetQuantities` over `inventoryAdjustQuantities` (CLAUDE.md
   * §4.5), the closest existing analog in this codebase.
   *
   * UNCONFIRMED, more so than this connector's other methods: the inner
   * per-entry field names for a `skuStockTargetList` item (guessed here as
   * `skuId`/`targetStockQuantity`) were not found in ANY source this
   * research pass tried -- see this file's header comment. Treat this
   * specific request body as the least-trustworthy shape in this entire
   * connector; do not extend it (e.g. to also populate `requestUniqueKey`
   * for idempotency, a real confirmed field this method currently leaves
   * unset) without first re-confirming the base shape actually works.
   */
  async pushInventory(productId: string, quantity: number): Promise<SyncResult> {
    let goodsId: string;
    let skuId: string;
    try {
      ({ goodsId, skuId } = parseTemuProductId(productId));
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    try {
      await this.request<unknown>("bg.local.goods.stock.edit", {
        goodsId,
        skuStockTargetList: [{ skuId, targetStockQuantity: quantity }],
      });
      return { success: true, externalId: productId };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * bg.order.fulfillment.info.sync -- chosen over the alternative shipment-
   * confirmation methods this API also exposes
   * (bg.logistics.shipment.v2.confirm's `sendRequestList`, or the
   * bg.order.unshipped.package.get + bg.logistics.shipped.package.confirm
   * discover-then-confirm pair) specifically because it is the only one of
   * the three that takes a flat set of top-level scalar fields with no
   * nested list at all -- every field this call sends
   * (fulfillmentType/orderSn/warehouseOperationStatus/operationTime/
   * trackingNumber) is confirmed, individually, from the installed SDK's
   * own docstring (api/fulfillment.py), unlike `sendRequestList`'s/
   * `packageSendInfoList`'s inner item shapes, which are NOT confirmed
   * anywhere. Same "prefer the confirmed synchronous shape over an
   * unconfirmed batch/list one" reasoning AmazonConnector's own choice of
   * the Listings Items API over the Feeds API for pushInventory() already
   * establishes in this codebase (CLAUDE.md §4.1).
   *
   * `fulfillmentType: 1` (non-FBA / self-fulfilled) -- every order line
   * this codebase's connectors produce maps to `seller_fulfilled` (see
   * {@link mapFulfillmentType}), so this is the correct branch of that
   * confirmed 0/1 enum, not a default guess.
   * `warehouseOperationStatus: 0` (shipped, not delivered) -- this method
   * only ever represents a shipment being CONFIRMED, matching every other
   * connector's own confirmShipment() semantics; nothing calls this at
   * delivery time.
   *
   * TWO REAL, DOCUMENTED NARROWINGS, not theoretical ones:
   *  - `tracking.carrier` is silently DISCARDED -- this endpoint's own
   *    confirmed field set has no carrier-code parameter of any kind (only
   *    trackingNumber), unlike Amazon's/eBay's confirmShipment(), which at
   *    least have a field to (mis)use for it. There is simply nowhere to
   *    put it on this specific call.
   *  - `orderSn` here is passed this connector's own `orderId` parameter
   *    (i.e. `header.parentOrderSn`, per {@link normalizeTemuOrder}) even
   *    though this endpoint's own docstring literally labels the parameter
   *    "订单号（子订单号）" -- "order number (SUB-order number)", not the
   *    parent order number. This codebase's `ChannelConnector.
   *    confirmShipment(orderId, tracking)` shape only ever has ONE
   *    whole-order id to give it (same "single-fulfillment assumption"
   *    narrowing every other connector's own confirmShipment() already
   *    documents -- one tracking number applied to the whole order, no
   *    per-line granularity) -- passing the parent order's sn where a
   *    sub-order sn may be expected is an unconfirmed, honestly-flagged
   *    risk, not a resolved design decision. Confirming which id this call
   *    actually needs is real follow-up work before this method can be
   *    trusted against production.
   */
  async confirmShipment(orderId: string, tracking: TrackingInfo): Promise<void> {
    await this.request<unknown>("bg.order.fulfillment.info.sync", {
      fulfillmentType: 1,
      orderSn: orderId,
      warehouseOperationStatus: 0,
      operationTime: Math.floor(new Date(tracking.shippedAt).getTime() / 1000),
      trackingNumber: tracking.trackingNumber,
    });
  }
}
