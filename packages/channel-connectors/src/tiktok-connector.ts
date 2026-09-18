import type { Pool } from "pg";
import crypto from "node:crypto";
import { withTenant, decryptChannelSecret } from "@alltix/db";
import type { FulfillmentType } from "@alltix/shared";
import type { AuthToken, NormalizedOrder, NormalizedOrderLine, SyncResult, TrackingInfo } from "./connector.js";
// Same in-process retry/backoff every other connector in this package uses.
import { fetchWithBackoff } from "./retry.js";

// TikTok Shop Open Platform -- channel #6. Arif's explicit decision (an
// AskUserQuestion pick): "Full connector, like eBay/Temu v1" -- authenticate()
// / pullOrders() / pushInventory() / confirmShipment() only. No outbound
// listing creation this pass, and (same as Temu/eBay's own original builds)
// this does NOT implement the shared ChannelConnector interface.
//
// RESEARCH TRAIL, worth reading before touching this file -- same discipline
// Temu's own header comment established (temu-connector.ts), since this
// channel turned out to have a very similar "official docs unreadable"
// problem, worked around the same way:
//   - partner.tiktokshop.com/docv2/... is a pure JavaScript SPA -- every page
//     fetched during this research pass (including literal, search-surfaced
//     pages titled "Sign your API request" and "Get Package Detail")
//     returned only navigation chrome, no substantive documentation content.
//     Same class of problem Temu's docs had, not a one-off fetch failure.
//   - PRIMARY confirmed source: a GitHub issue
//     (github.com/openlinker-project/openlinker#2882) documenting a real,
//     detailed technical integration spike into TikTok Shop's Open API --
//     base URLs, the OAuth token exchange/refresh flow, the full request
//     signing algorithm, and a broad endpoint inventory (orders, packages,
//     inventory, returns). This is the single best source found for this
//     connector, comparable in detail to eBay's own official doc pages,
//     and materially better than anything found for Temu. Dated the same
//     week as this research pass (2026-09), so current against the API's
//     own fast-moving versioned-path scheme.
//   - CROSS-CONFIRMED, not taken on one source alone: the base URLs
//     (open-api.tiktokglobalshop.com / auth.tiktok-shops.com) and the
//     app_key/access_token/shop_cipher credential model both independently
//     match a second, unrelated source -- the Go package
//     github.com/jianjungki/tiktok (pkg.go.dev's rendered documentation,
//     which -- unlike the official SPA -- is plain server-rendered HTML and
//     readable). That Go package's own literal endpoint paths
//     (`/api/fulfillment/...`, `/api/logistics/...`) were NOT used here --
//     they don't match the versioned `/{category}/{YYYYMM}/{action}` shape
//     the openlinker spike documents in detail and dates as current, so they
//     read as an older/legacy API generation, not this connector's target.
//     Two more sources (npm's `tiktok-shop-sdk`, EcomPHP's `tiktokshop-php`)
//     confirmed the credential model's *shape* (app key/secret, access
//     token, shop cipher as a genuinely distinct per-shop value with its own
//     setter) without themselves exposing readable endpoint/signing detail,
//     so they're corroborating, not primary.
//   - What is NOT confirmed by any source found this pass: literal response
//     field names for an order/line item or a package (every source gave
//     endpoint paths and the credential/signing model, none rendered an
//     actual example JSON response body) -- same gap Temu's own connector
//     carries for its response envelope, see each type below for exactly
//     what's inferred vs. confirmed. The exact relationship between an
//     "order" and a "package" (TikTok's own fulfillment unit -- an order can
//     be combined/split into one or more packages) is real and documented
//     in prose by the openlinker spike, but no endpoint to resolve an
//     orderId to its package id(s) was found rendered anywhere -- this is
//     this connector's single biggest structural risk, see confirmShipment()
//     below.
//
// Given all that, this connector carries the same heavier-than-eBay
// UNVERIFIED status Temu's own connector documents for itself -- a
// well-researched first draft, not a proven implementation. No TikTok
// credentials of any kind exist anywhere in this codebase yet (see
// .env.example's TIKTOK_* entries).

/** Confirmed from the openlinker spike (cross-confirmed by the Go package's
 *  own literal `APIBaseURL` constant). One global host -- region is carried
 *  as data on each shop object (a shop_cipher), not as a distinct hostname
 *  the way Amazon's SP-API splits NA/EU/FE. */
export const TIKTOK_API_BASE_URL = "https://open-api.tiktokglobalshop.com";

/** Confirmed the same way as {@link TIKTOK_API_BASE_URL} -- a SEPARATE host
 *  from the main API host, used only for the OAuth token exchange/refresh
 *  calls below. Sandbox availability was explicitly flagged by the spike as
 *  unconfirmed/regionally limited (UK and Indonesia only, and possibly
 *  broken above API version 202309) -- unlike every other channel in this
 *  codebase, there is no separate TIKTOK_SANDBOX_* constant here, since no
 *  reliable sandbox host was confirmed to exist at all. This connector only
 *  ever targets production, same "nothing to choose between" position
 *  Temu's own connector documents for itself. */
export const TIKTOK_AUTH_BASE_URL = "https://auth.tiktok-shops.com";

export interface TikTokCredentials {
  /** Issued to a TikTok Shop Open Platform app registration. */
  appKey: string;
  /** Never sent on the wire directly except as the HMAC key for
   *  {@link buildTikTokSignature} -- same high-value, pgcrypto-encrypted-at-
   *  rest treatment as every other connector's client secret. */
  appSecret: string;
  /** Short-lived (the spike reports ~7 days, read from the token
   *  response -- never hardcoded here) -- unlike Temu's non-expiring static
   *  token, this genuinely needs the refresh flow below. Sent on every
   *  business-API call via the `x-tts-access-token` header, per the spike's
   *  own explicit "not Authorization" callout. */
  accessToken: string;
  /** Long-lived (the spike reports ~365 days). Used by {@link
   *  TikTokConnector.authenticate} to obtain a fresh accessToken -- this
   *  connector does not persist the *rotated* access/refresh token pair
   *  back to channel_connections itself (no caller in this codebase does
   *  that kind of write-back yet for any channel); see authenticate()'s own
   *  doc comment. */
  refreshToken: string;
  /** A genuinely distinct per-shop identifier (confirmed: TikTok Shop
   *  Open Platform's own multi-shop-per-authorization model means one
   *  app_key/access_token pair can cover several shops, each with its own
   *  shop_cipher -- obtained from `/authorization/202309/shops` per the
   *  spike). Required as a query param on most business-API calls; the
   *  spike documents roughly seven endpoint families (compliance, global
   *  products, file/image uploads, brand creation, authorization, seller
   *  endpoints) that must OMIT it -- none of those families are called by
   *  this v1 connector, so every request this file makes includes it. */
  shopCipher: string;
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  }
  return value;
}

export function loadTikTokCredentialsFromEnv(): TikTokCredentials {
  return {
    appKey: readRequiredEnv("TIKTOK_APP_KEY"),
    appSecret: readRequiredEnv("TIKTOK_APP_SECRET"),
    accessToken: readRequiredEnv("TIKTOK_ACCESS_TOKEN"),
    refreshToken: readRequiredEnv("TIKTOK_REFRESH_TOKEN"),
    shopCipher: readRequiredEnv("TIKTOK_SHOP_CIPHER"),
  };
}

/**
 * Reads the most recent active 'tiktok' channel_connections row for a tenant
 * -- via {@link withTenant} so RLS scopes the lookup (CLAUDE.md §2.4). No new
 * migration needed: this connector's five-value credential set is the
 * largest of any channel in this codebase (every other channel needs at
 * most four: Amazon's clientId/secret/refreshToken plus a region string),
 * but it still fits the existing columns --
 *   lwa_client_id            = appKey
 *   encrypted_client_secret  = appSecret
 *   encrypted_access_token   = accessToken   (added by migration 0019 for Shopify)
 *   encrypted_refresh_token  = refreshToken
 *   external_account_id      = shopCipher
 * The last one is a genuinely BETTER semantic fit than every other channel's
 * own reuse of this column: Amazon/Walmart/eBay/Temu all reuse
 * external_account_id to hold their OWN client/app id (documented in each
 * connector as "no independent seller id exists to put here instead") --
 * TikTok Shop is the first channel in this codebase where a real,
 * independent per-shop identifier (shop_cipher) actually exists, so this is
 * external_account_id being used for what its name says for the first time,
 * not a repurposing.
 */
export async function loadTikTokCredentialsFromChannelConnection(pool: Pool, tenantId: string): Promise<TikTokCredentials> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query<{
      lwa_client_id: string;
      encrypted_client_secret: Buffer;
      encrypted_access_token: Buffer | null;
      encrypted_refresh_token: Buffer | null;
      external_account_id: string | null;
    }>(
      `SELECT lwa_client_id, encrypted_client_secret, encrypted_access_token, encrypted_refresh_token, external_account_id
         FROM channel_connections
        WHERE channel = 'tiktok' AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 1`,
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(`No active 'tiktok' channel_connections row found for tenant ${tenantId}`);
    }
    if (!row.encrypted_access_token || !row.encrypted_refresh_token) {
      throw new Error(`TikTok channel_connections row for tenant ${tenantId} is missing an access or refresh token`);
    }
    if (!row.external_account_id) {
      throw new Error(`TikTok channel_connections row for tenant ${tenantId} has no shop_cipher stored (external_account_id)`);
    }

    const [appSecret, accessToken, refreshToken] = await Promise.all([
      decryptChannelSecret(client, row.encrypted_client_secret),
      decryptChannelSecret(client, row.encrypted_access_token),
      decryptChannelSecret(client, row.encrypted_refresh_token),
    ]);

    return { appKey: row.lwa_client_id, appSecret, accessToken, refreshToken, shopCipher: row.external_account_id };
  });
}

export async function createTikTokConnectorFromChannelConnection(pool: Pool, tenantId: string): Promise<TikTokConnector> {
  const credentials = await loadTikTokCredentialsFromChannelConnection(pool, tenantId);
  return new TikTokConnector(credentials);
}

/** How a single query-param value is stringified before being concatenated
 *  into the signature -- same scalar-cast convention as every other
 *  connector's own signing helper in this package (see
 *  temuParamValueToString in temu-connector.ts). The spike's own algorithm
 *  description says array-valued params are SKIPPED entirely during
 *  signing (not stringified) -- {@link buildTikTokSignature} filters those
 *  out before this function is ever called on them. */
function tiktokParamValueToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * Confirmed from the openlinker spike's own step-by-step description (§
 * "Request Signing Algorithm" in that issue) -- NOT independently verified
 * against a second literal worked example the way Temu's MD5 algorithm was
 * confirmed against real installed SDK source, so this is this connector's
 * own analog of "confirmed from a credible source, not a documented
 * official fact":
 *   1. every query param except `sign` and `access_token` (this connector
 *      never puts access_token in the query string at all -- see
 *      TikTokCredentials' own doc comment -- so that exclusion is moot here,
 *      kept only because the spike names it explicitly)
 *   2. sort keys alphabetically
 *   3. concatenate as `key` immediately followed by `value`, no separators,
 *      SKIPPING any array-valued param entirely
 *   4. prepend the request PATH (e.g. "/order/202309/orders/search") --
 *      unlike Temu's/eBay's own signing, the URL path itself is part of
 *      what's signed here, not just params
 *   5. for a non-GET request with a JSON (non-multipart) body, append the
 *      raw request body string after the params
 *   6. wrap the whole thing as `appSecret + <string> + appSecret`
 *   7. HMAC-SHA256, keyed with appSecret, lowercase hex digest
 *  `sign` itself is never included in the params passed to this function.
 */
export function buildTikTokSignature(
  path: string,
  queryParams: Record<string, unknown>,
  appSecret: string,
  body?: string,
): string {
  const signableParams = Object.fromEntries(Object.entries(queryParams).filter(([, value]) => !Array.isArray(value)));

  const concatenatedParams = Object.keys(signableParams)
    .sort()
    .map((key) => `${key}${tiktokParamValueToString(signableParams[key])}`)
    .join("");

  const toSign = `${path}${concatenatedParams}${body ?? ""}`;
  return crypto.createHmac("sha256", appSecret).update(`${appSecret}${toSign}${appSecret}`, "utf8").digest("hex");
}

/** Every signed business-API request's common query params: `app_key`,
 *  `timestamp` (unix seconds), `shop_cipher` (per {@link TikTokCredentials}'
 *  own doc comment -- omitted by the small set of endpoint families this
 *  connector never calls), plus whatever operation-specific params the
 *  caller supplies, and `sign` computed and appended last. Mirrors
 *  buildTemuRequestBody's own "base params + extra + sign last" shape in
 *  temu-connector.ts. */
function buildTikTokSignedQuery(
  path: string,
  credentials: TikTokCredentials,
  extraQueryParams: Record<string, unknown> = {},
  body?: string,
): Record<string, string> {
  const base: Record<string, unknown> = {
    app_key: credentials.appKey,
    timestamp: Math.round(Date.now() / 1000),
    shop_cipher: credentials.shopCipher,
    ...extraQueryParams,
  };

  const sign = buildTikTokSignature(path, base, credentials.appSecret, body);
  const withSign: Record<string, string> = { sign };
  for (const [key, value] of Object.entries(base)) {
    if (!Array.isArray(value)) withSign[key] = tiktokParamValueToString(value);
  }
  return withSign;
}

/** TikTok's own confirmed success/failure convention, per the openlinker
 *  spike: "Success indicated by JSON response with `code === 0`, not HTTP
 *  status codes." `data` is this codebase's own guess at the payload
 *  wrapper name (unconfirmed against a literal example, same status as
 *  Temu's own `result` wrapper guess in TemuApiResponse). */
interface TikTokApiResponse<T> {
  code?: number;
  message?: string;
  data?: T;
}

interface TikTokOrderListData {
  orders?: TikTokOrder[];
  next_page_token?: string;
  total_count?: number;
  [key: string]: unknown;
}

interface TikTokOrderDetailData {
  orders?: TikTokOrder[];
  [key: string]: unknown;
}

/** UNCONFIRMED response field names, same status Temu's own TemuOrder type
 *  carries -- no source found this pass rendered a literal example order
 *  response body. Chosen for consistency with the openlinker spike's own
 *  confirmed REQUEST field names (`update_time_ge`, `create_time_ge/le`)
 *  and this API family's otherwise-consistent snake_case convention. */
export interface TikTokOrder {
  id: string;
  status?: string;
  create_time?: number;
  update_time?: number;
  line_items?: TikTokOrderLine[];
  recipient_address?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Same unconfirmed status as {@link TikTokOrder}. */
export interface TikTokOrderLine {
  id?: string;
  seller_sku?: string;
  sku_id?: string;
  product_name?: string;
  sale_price?: string | number;
  quantity?: number;
  [key: string]: unknown;
}

/** No TikTok analog of Amazon's AFN/Walmart's WFS is confirmed anywhere in
 *  this codebase's own FulfillmentType union -- same defensive default
 *  every other connector's own mapFulfillmentType() already documents. */
function mapFulfillmentType(): FulfillmentType {
  return "seller_fulfilled";
}

export function normalizeTikTokOrderLine(line: TikTokOrderLine): NormalizedOrderLine {
  const quantity = typeof line.quantity === "number" ? line.quantity : 0;
  const price = line.sale_price !== undefined ? Number(line.sale_price) : NaN;
  return {
    externalLineId: String(line.id ?? line.sku_id ?? ""),
    externalSku: String(line.seller_sku ?? line.sku_id ?? ""),
    quantity,
    unitPrice: Number.isFinite(price) ? price.toFixed(2) : "0.00",
    fulfillmentType: mapFulfillmentType(),
  };
}

export function normalizeTikTokOrder(order: TikTokOrder): NormalizedOrder {
  return {
    externalOrderId: order.id,
    channel: "tiktok",
    // No per-region marketplace concept confirmed on the Order type itself
    // -- region lives on the SHOP (shop_cipher), not the order, per the
    // spike's own "region carried as data on each shop object" note. Same
    // '' default every other connector uses for an identical gap.
    channelMarketplace: "",
    placedAt: order.create_time ? new Date(order.create_time * 1000).toISOString() : null,
    channelStatus: String(order.status ?? ""),
    customer: {},
    // recipient_address is a real, confirmed-to-exist field name (per the
    // spike's Poland-desensitization discussion, which names it directly),
    // but its own inner shape was never rendered anywhere this pass -- left
    // as the raw object rather than mapped field-by-field, same
    // conservative choice as leaving customer empty.
    shippingAddress: order.recipient_address ?? {},
    lines: (order.line_items ?? []).map(normalizeTikTokOrderLine),
    rawPayload: order,
  };
}

/** {@link TikTokConnector.pushInventory}'s compound productId, same pattern
 *  Temu's own parseTemuProductId established for an identical "the shared
 *  interface's flat (productId, quantity) signature has no room for a
 *  compound key" problem. */
export interface TikTokProductId {
  productId: string;
  skuId: string;
}

export function parseTikTokProductId(productId: string): TikTokProductId {
  const [pId, skuId] = productId.split(":");
  if (!pId || !skuId) {
    throw new Error(`TikTokConnector: productId must be "<productId>:<skuId>", got "${productId}"`);
  }
  return { productId: pId, skuId };
}

/**
 * TikTok Shop Open Platform connector -- implements authenticate(),
 * pullOrders(), pushInventory(), and confirmShipment() only (Arif's own
 * explicit "Full connector, like eBay/Temu v1" scope decision). Deliberately
 * does NOT `implements ChannelConnector` and has no submitListing()/
 * getFeedStatus()/subscribeToEvents() -- same shape as TemuConnector/
 * (the original) EbayConnector, not WalmartConnector.
 *
 * UNVERIFIED IN ITS ENTIRETY -- same status Temu's own connector carries,
 * for the same reason: no TikTok credentials of any kind exist anywhere in
 * this codebase yet (see .env.example's TIKTOK_* entries), and this file's
 * own header comment documents exactly what is/isn't confirmed and from
 * where. A well-researched first draft, not a proven implementation.
 */
export class TikTokConnector {
  private credentials: TikTokCredentials;
  private readonly baseUrl: string;

  constructor(credentials: TikTokCredentials = loadTikTokCredentialsFromEnv(), baseUrl: string = TIKTOK_API_BASE_URL) {
    this.credentials = credentials;
    this.baseUrl = baseUrl;
  }

  /** Signs and sends one business-API call. `code !== 0` (per {@link
   *  TikTokApiResponse}'s own doc comment) OR a missing `data` field is
   *  treated as failure -- same "a wrong guess about the envelope still
   *  fails safely" defensive posture temu-connector.ts's own private
   *  request() uses, for an identical reason (the envelope itself is
   *  unconfirmed). The access token travels only in the
   *  `x-tts-access-token` header, per the spike's own explicit callout --
   *  never in the signed query string. */
  private async request<T>(
    method: "GET" | "POST",
    path: string,
    options: { query?: Record<string, unknown>; body?: unknown; includeShopCipher?: boolean } = {},
  ): Promise<T> {
    const bodyString = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const extraQuery = { ...(options.query ?? {}) };

    // The handful of endpoint families TikTokCredentials' own doc comment
    // names as shop_cipher-exempt -- unused by this v1 connector today (every
    // call this file makes needs it), kept as an explicit opt-out rather
    // than omitted, since it's a real, documented part of the signing
    // contract a future caller may need.
    const credentialsForSigning = options.includeShopCipher === false ? { ...this.credentials, shopCipher: "" } : this.credentials;
    const signedQuery = buildTikTokSignedQuery(path, credentialsForSigning, extraQuery, bodyString);
    const queryToSend =
      options.includeShopCipher === false
        ? Object.fromEntries(Object.entries(signedQuery).filter(([key]) => key !== "shop_cipher"))
        : signedQuery;

    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(queryToSend)) url.searchParams.set(key, value);

    const response = await fetchWithBackoff(url.toString(), {
      method,
      headers: {
        "content-type": "application/json",
        "x-tts-access-token": this.credentials.accessToken,
      },
      ...(bodyString !== undefined ? { body: bodyString } : {}),
    });

    const data = (await response.json().catch(() => ({}))) as TikTokApiResponse<T>;

    if (!response.ok || (data.code !== undefined && data.code !== 0)) {
      const detail = [data.code, data.message].filter((v) => v !== undefined && v !== "").join(": ");
      throw new Error(`TikTok ${method} ${path} failed: ${response.status}${detail ? ` ${detail}` : ` ${response.statusText}`}`);
    }
    if (data.data === undefined) {
      throw new Error(`TikTok ${method} ${path} succeeded but returned no 'data' payload`);
    }
    return data.data;
  }

  /**
   * GET {authBaseUrl}/api/v2/token/refresh -- confirmed from the openlinker
   * spike as a genuinely non-standard call: credentials (app_key, app_secret,
   * refresh_token, grant_type=refresh_token) travel as a plain, UNSIGNED
   * query string against the separate auth host, not the signed-request
   * convention every business-API call above uses. Success is the same
   * `code === 0` convention as every other call. Returns the freshly rotated
   * access token (and updates this instance's own in-memory credentials so
   * subsequent calls on the same connector instance use it) -- this method
   * deliberately does NOT write the rotated token back to
   * channel_connections itself; no caller in this codebase persists a
   * rotated credential mid-flight for any channel yet, so a caller wanting
   * that has to do it explicitly, same as it would for any other connector.
   * `expiresAt` is derived from the response's own `expires_in` (seconds)
   * when present, falling back to the spike's own reported ~7-day figure
   * otherwise -- never hardcoded to a guessed constant the way Temu's/
   * Shopify's non-expiring tokens use a far-future placeholder, since this
   * token DOES genuinely expire.
   */
  async authenticate(): Promise<AuthToken> {
    const url = new URL(`${TIKTOK_AUTH_BASE_URL}/api/v2/token/refresh`);
    url.searchParams.set("app_key", this.credentials.appKey);
    url.searchParams.set("app_secret", this.credentials.appSecret);
    url.searchParams.set("refresh_token", this.credentials.refreshToken);
    url.searchParams.set("grant_type", "refresh_token");

    const response = await fetchWithBackoff(url.toString(), { method: "GET" });
    const data = (await response.json().catch(() => ({}))) as TikTokApiResponse<{
      access_token?: string;
      refresh_token?: string;
      access_token_expire_in?: number;
    }>;

    if (!response.ok || (data.code !== undefined && data.code !== 0) || !data.data?.access_token) {
      const detail = [data.code, data.message].filter((v) => v !== undefined && v !== "").join(": ");
      throw new Error(`TikTok token refresh failed: ${response.status}${detail ? ` ${detail}` : ` ${response.statusText}`}`);
    }

    const accessToken = data.data.access_token;
    const refreshToken = data.data.refresh_token ?? this.credentials.refreshToken;
    const expiresInSeconds = data.data.access_token_expire_in ?? 7 * 24 * 60 * 60;
    this.credentials = { ...this.credentials, accessToken, refreshToken };

    return { accessToken, refreshToken, expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString() };
  }

  /**
   * POST /order/202309/orders/search then GET /order/202309/orders?ids=... --
   * same "headers vs. a separate line-items/detail call" split every other
   * connector in this package uses, except here the SEARCH call already
   * returns full orders per the openlinker spike's own endpoint description
   * (it doesn't separately distinguish a headers-only vs. detail shape the
   * way Amazon's/Temu's own two-call split does) -- so this method's own
   * second call only exists to backfill anything the search response's
   * order objects leave out, and is skipped entirely if the search response
   * already includes line_items. `filter.update_time_ge` (unix seconds) is
   * the closest confirmed analog to every other connector's own `since`
   * cursor -- confirmed field NAME from the spike, its exact position
   * inside a `filter` request-body object is this codebase's own inferred
   * shape, unconfirmed against a literal example.
   *
   * Pagination loops on `next_page_token`, bounded by
   * TIKTOK_ORDERS_MAX_PAGES -- same defensive safety-cap pattern
   * EbayConnector.pullOrders() established (its own `next`-field loop, same
   * "checked only for truthiness, never a URL to blindly follow" caution),
   * chosen over an unbounded loop for the same reason.
   */
  async pullOrders(since: Date): Promise<NormalizedOrder[]> {
    const updateTimeGe = Math.floor(since.getTime() / 1000);
    const pageSize = 50;
    const maxPages = 250; // 250 * 50 = 12,500 orders/run -- a conservative safety cap, not an expected real ceiling.

    const orders: TikTokOrder[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const listData = await this.request<TikTokOrderListData>("POST", "/order/202309/orders/search", {
        query: { page_size: pageSize, ...(pageToken ? { page_token: pageToken } : {}) },
        body: { filter: { update_time_ge: updateTimeGe } },
      });
      const pageOrders = listData.orders ?? [];
      if (pageOrders.length === 0) break;
      orders.push(...pageOrders);

      pageToken = listData.next_page_token;
      if (!pageToken) break;
    }

    // Backfill line items for any order the search response didn't already
    // populate -- per-order, error-isolated (one bad detail lookup doesn't
    // drop the whole pull), same philosophy TemuConnector.pullOrders() and
    // syncShopifyCatalogForTenant's own per-item try/catch already
    // establish elsewhere in this codebase. Batched in groups of 50 ids per
    // call -- a commonly-cited limit for this endpoint family across
    // multiple third-party integration write-ups, NOT independently
    // confirmed against an official source this pass; treat as this
    // connector's own conservative default, not a documented fact.
    const needsDetail = orders.filter((o) => !o.line_items || o.line_items.length === 0);
    const idBatches: string[][] = [];
    for (let i = 0; i < needsDetail.length; i += 50) idBatches.push(needsDetail.slice(i, i + 50).map((o) => o.id));

    for (const batch of idBatches) {
      try {
        const detailData = await this.request<TikTokOrderDetailData>("GET", "/order/202309/orders", {
          query: { ids: batch.join(",") },
        });
        for (const detailed of detailData.orders ?? []) {
          const match = orders.find((o) => o.id === detailed.id);
          if (match) match.line_items = detailed.line_items;
        }
      } catch (err) {
        console.error(
          `TikTokConnector.pullOrders: order detail lookup failed for ids=[${batch.join(",")}], those orders will have no line items:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    return orders.map(normalizeTikTokOrder);
  }

  /**
   * POST /product/202309/products/{productId}/inventory/update -- the SINGLE
   * LEAST CONFIRMED request body in this entire connector, same "flag it,
   * don't hide it" precedent TemuConnector.pushInventory()'s own doc comment
   * sets for its skuStockTargetList. No source found this research pass
   * rendered a literal example of this endpoint's request body -- the shape
   * below (`skus: [{ id, inventory: [{ warehouse_id, quantity }] }]`) is
   * this codebase's own best-effort inference from how TikTok Shop's
   * inventory model is described elsewhere (a SKU's stock is tracked
   * per-warehouse, not as one flat number), not a documented fact.
   *
   * Same compound-productId pattern Temu's own pushInventory() established
   * (`"<productId>:<skuId>"`, {@link parseTikTokProductId}) -- and this
   * connector needs a THIRD value beyond that pair: a warehouse id, which
   * this codebase's own data model has no per-channel-warehouse-mapping
   * concept for at all (CLAUDE.md §8's own Phase 4 note on this exact gap
   * for Shopify applies here too). Rather than invent a second compound-id
   * scheme, this method reads a single, tenant-wide default warehouse id
   * from `TIKTOK_DEFAULT_WAREHOUSE_ID` -- correct only for a seller with one
   * TikTok-registered warehouse, which is this connector's own real,
   * documented narrowing for v1 (same spirit as every other connector's own
   * "MFN/DEFAULT fulfillment channel only" scope note).
   */
  async pushInventory(productId: string, quantity: number): Promise<SyncResult> {
    let parsed: TikTokProductId;
    try {
      parsed = parseTikTokProductId(productId);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    const warehouseId = process.env.TIKTOK_DEFAULT_WAREHOUSE_ID;
    if (!warehouseId) {
      return {
        success: false,
        error: "Missing required environment variable: TIKTOK_DEFAULT_WAREHOUSE_ID (see .env.example)",
      };
    }

    try {
      await this.request<unknown>("POST", `/product/202309/products/${encodeURIComponent(parsed.productId)}/inventory/update`, {
        body: { skus: [{ id: parsed.skuId, inventory: [{ warehouse_id: warehouseId, quantity }] }] },
      });
      return { success: true, externalId: productId };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * POST /fulfillment/202309/packages/{orderId}/ship -- this connector's
   * OTHER major unconfirmed piece, documented as honestly as
   * TemuConnector.confirmShipment()'s own orderSn/sub-order-sn risk:
   *
   * TikTok's own fulfillment model treats an ORDER and its PACKAGE(S) as
   * distinct objects -- the openlinker spike is explicit that an order can
   * be combined, split, or uncombined into one or more packages, and NO
   * source found this research pass rendered an endpoint to resolve an
   * orderId to its package id(s). This codebase's own
   * `ChannelConnector.confirmShipment(orderId, tracking)` shape only ever
   * has ONE whole-order id to give it (the same single-fulfillment
   * assumption every other connector's own confirmShipment() already
   * carries) -- so this method passes that orderId directly into the
   * package-ship endpoint's `{id}` path segment, on the unconfirmed
   * assumption that a simple, never-combined-or-split order's package id
   * equals its order id. This is a genuine, unresolved risk, not a resolved
   * design decision -- confirming the real order-to-package relationship is
   * real follow-up work before this method can be trusted against
   * production, exactly the same caveat Temu's own confirmShipment()
   * carries for an analogous reason.
   *
   * `shippingCarrierCode`/`shippingProviderId`: TikTok's own shipping model
   * very likely expects a specific, TikTok-registered logistics-provider id
   * (not an arbitrary free-text carrier name) -- no confirmed provider-id
   * lookup or enum was found this pass, so `tracking.carrier` is passed
   * through directly into `shipping_provider_id` with no
   * mapping/validation, same "no equivalent always-valid fallback was
   * confirmed" caveat EbayConnector.confirmShipment()'s own doc comment
   * carries for an identical gap.
   */
  async confirmShipment(orderId: string, tracking: TrackingInfo): Promise<void> {
    await this.request<unknown>("POST", `/fulfillment/202309/packages/${encodeURIComponent(orderId)}/ship`, {
      body: {
        tracking_number: tracking.trackingNumber,
        shipping_provider_id: tracking.carrier,
        shipped_time: Math.floor(new Date(tracking.shippedAt).getTime() / 1000),
      },
    });
  }
}
