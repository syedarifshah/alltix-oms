import type { Pool } from "pg";
import { withTenant, decryptChannelSecret } from "@alltix/db";
import { fetchWithBackoff } from "@alltix/channel-connectors";
import type {
  CarrierAuthToken,
  CarrierConnector,
  CarrierTenantCredentials,
  CreateShipmentRequest,
  CreateShipmentResult,
  RateEstimate,
  TrackingEvent,
  TrackingResult,
} from "./connector.js";

/**
 * Royal Mail connector -- carrier #1 (CLAUDE.md's new Carrier Integration
 * section, this pass). Arif's own explicit pick as the wedge carrier (the
 * 5-question AskUserQuestion round this feature started with), built
 * completely before any of the other 7 (FedEx/UPS/DHL/Parcelforce/DPD/
 * Evri/Hermes) are touched -- same "prove the pattern on one first" order
 * CLAUDE.md §4.6/§4.7/§4.8 already used for eBay/Temu/TikTok among sales
 * channels.
 *
 * Two genuinely different Royal Mail APIs are combined here, researched
 * from two different confirmed sources -- every field/endpoint below is
 * marked CONFIRMED or INFERRED, same disclosure discipline
 * TemuConnector's/TikTokConnector's own class doc comments already
 * established (CLAUDE.md §4.7/§4.8), not restated in full per-field here:
 *
 * 1. **Click & Drop API** (order creation + label generation + manifesting)
 *    -- CONFIRMED end to end from Royal Mail's own official Swagger/OpenAPI
 *    2.0 spec, fetched live this pass:
 *    https://api.parcel.royalmail.com/doc/v1/click-and-drop-api-v1.yaml.
 *    Base URL: `https://api.parcel.royalmail.com/api/v1`. Auth: a plain
 *    Bearer token in the `Authorization` header (the spec's own
 *    securityDefinitions say so explicitly -- "Enter 'Bearer' [space] and
 *    then your token"), issued via Click & Drop's own UI (Settings >
 *    Integrations), not a client_id/client_secret OAuth exchange the way
 *    Amazon/eBay/TikTok's real refresh-token flows work. Rate limit: 2
 *    calls/sec, up to 2,000 orders/request, only ONE Click & Drop API
 *    integration allowed per account (so `carrier_connections`' own
 *    `UNIQUE(tenant_id, carrier)` constraint is a correct, not just
 *    convenient, modeling choice for this carrier specifically).
 *
 *    **CONFIRMED, and worth being explicit about since it directly narrows
 *    task #59's own "live rate shopping" scope: this API has NO
 *    rate-shopping/quote endpoint at all.** Neither the official swagger
 *    spec's own path list (`/orders`, `/orders/{id}`, `/orders/{id}/full`,
 *    `/orders/{id}/label`, `/orders/status`, `/carriers`, `/manifests`,
 *    `/manifests/{id}`, `/manifests/retry/{id}`, `/returns`,
 *    `/returns/services`, `/version`) nor the official API product
 *    listing (developer.royalmail.net/api, which lists Delivery Office
 *    Finder / Local Collect / Tracking as separate products, with no
 *    pricing/rates product anywhere) has one. `/returns/services` (the one
 *    endpoint that could be mistaken for this) is scoped to Online Business
 *    Account RETURNS specifically, not general outbound rate shopping. This
 *    means {@link RoyalMailConnector.getRateEstimate} below is, correctly,
 *    a static-price-table lookup (see surcharges.ts), never a live network
 *    call for this carrier -- a real, carrier-level limitation, not a gap
 *    in this connector.
 *
 * 2. **Tracking API v2 (REST)** -- CONFIRMED base shape and endpoint paths
 *    directly from Royal Mail's own official product page
 *    (developer.royalmail.net/product/175625, fetched live this pass):
 *    `GET /{mailPieceId}/events`, `GET /summary`, `GET /{mailPieceId}/signature`,
 *    rate-limited to 25 calls/12 hours on the onboarding assessment plan.
 *    Base URL (`https://api.royalmail.net/mailpieces/v2`) and response
 *    field names (`statusCategory`/`statusDescription`, an `events` array
 *    of `eventCode`/`eventName`/`eventDateTime`/`locationName`, `summary`,
 *    `mailPieceId`/`uniqueItemId`) are INFERRED from a real, actively
 *    maintained community PHP library specifically targeting "Tracking API
 *    V2 (REST)" (github.com/elliotjreed/royal-mail-tracking) -- not from an
 *    official rendered example, since developer.royalmail.net's own
 *    product page requires a logged-in session to show request/response
 *    bodies. Cross-checked against a SECOND, independent source for the
 *    credential model specifically: the official /start onboarding page
 *    confirms Royal Mail issues "a unique client ID and client secret" for
 *    its REST APIs generally (not tracking-specific, but consistent with
 *    what the PHP library requires) via an IBM API Connect developer
 *    portal (the "ibm_apim" URL fragments on developer.royalmail.net are a
 *    direct tell). **UNCONFIRMED by any source found this pass: the exact
 *    OAuth token-exchange endpoint URL and the literal header name the
 *    resulting token travels in** -- INFERRED here as a Bearer token
 *    exchanged via client_credentials, the same shape Click & Drop's own
 *    confirmed auth uses and the most common IBM API Connect convention,
 *    but this specific piece has not been found written down anywhere and
 *    should be treated as a first draft, not a confirmed fact, until tried
 *    against a real sandbox account.
 *
 *    A SEPARATE, OLDER SOAP-based Royal Mail tracking API also exists
 *    (base `https://api.royalmail.net/tracking`, WSDL-based,
 *    application_id/username/password + client_id/client_secret --
 *    confirmed via a second, independent community library,
 *    github.com/BloomAndWild/royal_mail_api) -- deliberately NOT the one
 *    targeted here. That generation is legacy; this connector targets only
 *    the REST v2 product Royal Mail's own developer portal currently lists
 *    for new onboarding.
 *
 * **UNVERIFIED IN ITS ENTIRETY**, same status every other channel/carrier
 * connector in this codebase carried before its first live pass (CLAUDE.md
 * §4.2/§4.7/§4.8): no real Royal Mail Click & Drop API key or Tracking API
 * client_id/client_secret exists anywhere in this codebase or Arif's
 * account yet. This is a well-researched first draft against two
 * officially-sourced-where-possible API shapes, not a proven
 * implementation -- see .env.example's ROYAL_MAIL_* entries for what a real
 * verification pass would need.
 */

const CLICK_AND_DROP_BASE_URL = "https://api.parcel.royalmail.com/api/v1";
const TRACKING_API_BASE_URL = "https://api.royalmail.net/mailpieces/v2";

export interface RoyalMailCredentials {
  /** Click & Drop's own Bearer API key (Settings > Integrations in the
   *  Click & Drop UI) -- used directly, no token exchange, no expiry
   *  Royal Mail documents. Stored in carrier_connections.encrypted_access_token. */
  clickAndDropApiKey: string;
  /** Tracking API v2's own client_id/client_secret pair -- INFERRED to
   *  need an OAuth exchange (see this file's class doc comment); stored in
   *  carrier_connections.encrypted_client_id/encrypted_client_secret.
   *  Optional: a tenant can connect Click & Drop (labels/orders) without
   *  ever configuring tracking separately, same "one credential can be
   *  missing without blocking the rest" pattern channel_connections itself
   *  never actually enforces atomically either. */
  trackingClientId?: string;
  trackingClientSecret?: string;
}

interface ClickAndDropOrderResponse {
  orderIdentifier: number;
  trackingNumber?: string;
  label?: string;
  labelErrors?: unknown[];
}

interface ClickAndDropCreateOrdersResponse {
  successCount?: number;
  errorCount?: number;
  createdOrders?: ClickAndDropOrderResponse[];
  /** Deliberately untyped/unconfirmed -- no official swagger example of a
   *  REJECTED order's own response body was ever found during this
   *  connector's original research pass (only the success shape,
   *  `createdOrders`, was confirmed). Rather than guess a field name and
   *  risk silently dropping the real reason, `createShipment()`'s own
   *  error path below serializes and surfaces the ENTIRE raw response
   *  object -- whatever Royal Mail actually put in it (errors/orderErrors/
   *  failureReasons/etc., all real candidate names for this kind of API,
   *  none confirmed) reaches the tenant-visible error banner on
   *  /picklists instead of being silently discarded. Once a real rejection
   *  has been seen and its actual field name confirmed, this interface
   *  should gain that field for real, typed handling. */
  [key: string]: unknown;
}

interface TrackingEventsResponse {
  mailPieces?: {
    statusCategory?: string;
    statusDescription?: string;
    events?: Array<{ eventCode?: string; eventName?: string; eventDateTime?: string; locationName?: string | null }>;
  };
}

export class RoyalMailConnector implements CarrierConnector {
  constructor(private readonly credentials: RoyalMailCredentials) {}

  /** Click & Drop's API key has no documented expiry/refresh -- this just
   *  proves the key is well-formed enough to use, mirroring
   *  ShopifyConnector.authenticate()'s own non-expiring-token shape
   *  (CLAUDE.md §4.5). No live verification call is made here (unlike
   *  Shopify's verifyConnection()) -- Click & Drop's swagger spec's only
   *  no-auth-required endpoint is GET /version, which doesn't prove the key
   *  itself is valid, so the connect route (task #59) is where a real
   *  GET /orders call first proves a key actually works, same "reject a bad
   *  credential before persisting" precedent every other connect route
   *  already sets. */
  async authenticate(_tenantCredentials?: CarrierTenantCredentials): Promise<CarrierAuthToken> {
    if (!this.credentials.clickAndDropApiKey) {
      throw new Error("RoyalMailConnector.authenticate: missing Click & Drop API key");
    }
    return { accessToken: this.credentials.clickAndDropApiKey, expiresAt: "9999-12-31T23:59:59Z" };
  }

  private async clickAndDropRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetchWithBackoff(`${CLICK_AND_DROP_BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.credentials.clickAndDropApiKey}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Royal Mail Click & Drop API error (${response.status}): ${body}`);
    }
    // DELETE /orders/{id} (voidShipment) responds 204 No Content on the
    // confirmed swagger spec -- an empty body would throw on .json()
    // (a real bug caught by this package's own test suite, not a
    // hypothetical), so this only parses when there's actually a body to
    // parse.
    if (response.status === 204) {
      return undefined as T;
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Proves a Click & Drop API key actually works before a connect route
   *  persists it -- same "verify before persist" discipline every other
   *  connector's own connect route already follows (e.g.
   *  WalmartConnector.authenticate()'s own live token-exchange doc
   *  comment). GET /carriers (confirmed path, official swagger) is used
   *  rather than GET /version specifically because /version needs no auth
   *  at all -- it would return 200 for a bad key just as readily as a good
   *  one, proving nothing. */
  async verifyConnection(): Promise<void> {
    await this.clickAndDropRequest<unknown>("/carriers");
  }

  /**
   * POST /orders (confirmed shape, this file's own class doc comment).
   * Sends a single-order, single-package request -- Click & Drop's own
   * `items` array supports a batch of up to 2,000 orders per call, not
   * used here since this connector's only real caller (task #59's pack/
   * ship flow) creates exactly one shipment per confirmed order, the same
   * one-at-a-time granularity every other connector's own createListing()/
   * confirmShipment() methods already use.
   *
   * A REAL, DOCUMENTED SPLIT OUTCOME worth being explicit about: Royal
   * Mail's own response can report the order itself created successfully
   * while `labelErrors` is non-empty (label generation failed
   * independently) -- confirmed directly on `CreateOrderResponse`'s own
   * field list. This method treats that as a real, distinguishable partial
   * success: it returns normally with `labelBase64: null` rather than
   * throwing, since the order (and its real orderIdentifier/tracking
   * number, if assigned) still exists on Royal Mail's side and callers
   * need that even without a label -- same "a rolled-back mutation is
   * different from a degraded one" discipline this codebase applies
   * elsewhere (CLAUDE.md §4.5's Shopify per-field PII-gating example).
   */
  async createShipment(request: CreateShipmentRequest): Promise<CreateShipmentResult> {
    const body = {
      items: [
        {
          orderReference: request.orderReference,
          orderDate: request.orderDate,
          subtotal: request.subtotalGbp,
          shippingCostCharged: request.shippingCostChargedGbp,
          total: request.totalGbp,
          currencyCode: "GBP",
          recipient: {
            name: request.recipient.name,
            addressLine1: request.recipient.addressLine1,
            addressLine2: request.recipient.addressLine2,
            city: request.recipient.city,
            postalCode: request.recipient.postalCode,
            countryCode: request.recipient.countryCode,
            phone: request.recipient.phone,
            email: request.recipient.email,
          },
          postageDetails: request.serviceCode ? { serviceCode: request.serviceCode } : undefined,
          packages: request.packages.map((pkg) => ({
            weightInGrams: pkg.weightGrams,
            packageFormatIdentifier: pkg.packageFormat,
            packageContents: pkg.items.map((item) => ({
              name: item.name,
              SKU: item.sku,
              quantity: item.quantity,
              unitValue: item.unitValueGbp,
              unitWeightInGrams: item.unitWeightGrams,
            })),
          })),
        },
      ],
    };

    const result = await this.clickAndDropRequest<ClickAndDropCreateOrdersResponse>("/orders", {
      method: "POST",
      body: JSON.stringify(body),
    });

    const created = result.createdOrders?.[0];
    if (!created) {
      // Surface the ENTIRE raw response, not just errorCount -- see this
      // interface's own doc comment above on why: no confirmed field name
      // exists for a rejected order's own real reason, so the safest thing
      // to do with an unconfirmed shape is show all of it rather than
      // silently drop whatever Royal Mail actually said. A truncated
      // stringify (2000 chars, same defensive cap CLAUDE.md §19.11's own
      // last_failure_message.slice(0, 2000) already uses) keeps this from
      // blowing up the redirect's own ?error= query string on an unusually
      // large response.
      let rawDetail: string;
      try {
        rawDetail = JSON.stringify(result).slice(0, 2000);
      } catch {
        rawDetail = "(response not serializable)";
      }
      throw new Error(
        `Royal Mail Click & Drop: order creation reported ${result.errorCount ?? "an unknown number of"} error(s), no order was created -- raw response: ${rawDetail}`,
      );
    }

    return {
      carrierOrderId: String(created.orderIdentifier),
      trackingNumber: created.trackingNumber ?? null,
      labelBase64: created.label ?? null,
      raw: created,
    };
  }

  /** DELETE /orders/{orderIdentifiers} (confirmed path from the official
   *  swagger). Only meaningful before a manifest has been generated for
   *  the order -- Royal Mail's own docs (per the swagger's endpoint
   *  grouping) treat manifesting as the point of no return, not
   *  independently confirmed against a literal error-response example
   *  this pass, so a caller attempting to void an already-manifested
   *  shipment should expect this to fail loudly rather than silently
   *  no-op. */
  async voidShipment(carrierOrderId: string): Promise<void> {
    await this.clickAndDropRequest<void>(`/orders/${carrierOrderId}`, { method: "DELETE" });
  }

  private async trackingAuthHeader(): Promise<string> {
    // INFERRED, not confirmed -- see this file's class doc comment for
    // exactly what's unconfirmed here. Treated as a Bearer token exchanged
    // via the credentials directly (no separate token endpoint call
    // implemented, since none was found anywhere in this pass's research)
    // -- this is the piece most likely to need correcting against a real
    // sandbox account before this method ever works.
    if (!this.credentials.trackingClientId || !this.credentials.trackingClientSecret) {
      throw new Error("RoyalMailConnector.trackShipment: no Tracking API credentials configured for this connection");
    }
    return `Bearer ${this.credentials.trackingClientSecret}`;
  }

  /** GET /{mailPieceId}/events (confirmed path, INFERRED response shape --
   *  see this file's class doc comment). */
  async trackShipment(trackingNumber: string): Promise<TrackingResult> {
    const authHeader = await this.trackingAuthHeader();
    const response = await fetchWithBackoff(`${TRACKING_API_BASE_URL}/${trackingNumber}/events`, {
      headers: { Authorization: authHeader, Accept: "application/json" },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Royal Mail Tracking API error (${response.status}): ${body}`);
    }
    const data = (await response.json()) as TrackingEventsResponse;
    const mailPiece = data.mailPieces;
    const events: TrackingEvent[] = (mailPiece?.events ?? []).map((event) => ({
      eventCode: event.eventCode ?? "",
      eventName: event.eventName ?? "",
      eventDateTime: event.eventDateTime ?? "",
      locationName: event.locationName ?? null,
    }));
    return {
      trackingNumber,
      statusCategory: mailPiece?.statusCategory ?? "unknown",
      statusDescription: mailPiece?.statusDescription ?? "",
      events,
      raw: data,
    };
  }

  /** NOT a live call -- see this file's class doc comment and
   *  CarrierConnector.getRateEstimate's own doc comment for why: Royal
   *  Mail's Click & Drop API has no rate-shopping/quote endpoint,
   *  confirmed absent this pass. Resolves a static published-price
   *  estimate via surcharges.ts instead. */
  async getRateEstimate(request: {
    weightGrams: number;
    destinationCountryCode: string;
    shipDate: string;
  }): Promise<RateEstimate[]> {
    const { estimateRoyalMailRates } = await import("./surcharges.js");
    return estimateRoyalMailRates(request);
  }
}

/** Mirrors loadWalmartCredentialsFromChannelConnection's own shape
 *  (channel-connectors/src/walmart-connector.ts) -- most-recently-created
 *  active row, since carrier_connections' own UNIQUE(tenant_id, carrier)
 *  constraint (migration 0039) means there is at most one anyway, unlike
 *  channel_connections' four-column uniqueness. */
export async function loadRoyalMailCredentialsFromCarrierConnection(
  pool: Pool,
  tenantId: string,
): Promise<RoyalMailCredentials> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query<{
      encrypted_access_token: Buffer | null;
      encrypted_client_id: Buffer | null;
      encrypted_client_secret: Buffer | null;
    }>(
      `SELECT encrypted_access_token, encrypted_client_id, encrypted_client_secret
         FROM carrier_connections
        WHERE carrier = 'royal_mail' AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 1`,
    );

    const row = result.rows[0];
    if (!row || !row.encrypted_access_token) {
      throw new Error(`No active 'royal_mail' carrier_connections row found for tenant ${tenantId}`);
    }

    const clickAndDropApiKey = await decryptChannelSecret(client, row.encrypted_access_token);
    const trackingClientId = row.encrypted_client_id
      ? await decryptChannelSecret(client, row.encrypted_client_id)
      : undefined;
    const trackingClientSecret = row.encrypted_client_secret
      ? await decryptChannelSecret(client, row.encrypted_client_secret)
      : undefined;

    return { clickAndDropApiKey, trackingClientId, trackingClientSecret };
  });
}

export async function createRoyalMailConnectorFromCarrierConnection(
  pool: Pool,
  tenantId: string,
): Promise<RoyalMailConnector> {
  const credentials = await loadRoyalMailCredentialsFromCarrierConnection(pool, tenantId);
  return new RoyalMailConnector(credentials);
}
