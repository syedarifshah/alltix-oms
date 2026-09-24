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
 * DHL connector -- carrier #6 (CLAUDE.md §19's Carrier Integration
 * section), Arif's own explicit pick when asked which carrier to build
 * next after Royal Mail (§19.1), Evri (§19.2), FedEx (§19.3), Parcelforce
 * (§19.4), and UPS (§19.5).
 *
 * **DHL Express's own "MyDHL API" is a genuinely public, self-serve REST
 * API** (developer.dhl.com/api-reference/dhl-express-mydhl-api), the same
 * general shape as FedEx's/UPS's own self-serve developer portals, not a
 * closed/contract-gated one like Evri's or Parcelforce's own. **A real,
 * confirmed structural parallel to Royal Mail (§19.1), not FedEx/UPS**:
 * DHL, like Royal Mail, splits shipping/rating from tracking across TWO
 * genuinely separate DHL APIs with two DIFFERENT auth models and two
 * different hosts -- MyDHL API (Basic auth, `express.api.dhl.com`) for
 * shipments/rates, and DHL's own group-wide "Unified Tracking API" (a
 * `DHL-API-Key` subscription-key header, `api-eu.dhl.com`) for tracking.
 * Every field/endpoint below is marked CONFIRMED or INFERRED, same
 * disclosure discipline every other connector in this codebase's class doc
 * comment already establishes:
 *
 * - **Auth (MyDHL API)** -- CONFIRMED as HTTP Basic auth (no token
 *   exchange, unlike UPS's/FedEx's/Evri's own client_credentials flows --
 *   the credential pair travels directly on the `Authorization` header of
 *   every request, closer in shape to Royal Mail's own static Bearer-key
 *   model than to any OAuth-based connector in this layer) directly from
 *   DHL's own official docs page (developer.dhl.com/api-reference/
 *   dhl-express-mydhl-api, fetched live this pass: "the Authorization
 *   header ... set as ... BasicAuth"), CROSS-CONFIRMED by two independent
 *   real, open-source client libraries that both hard-code the identical
 *   base URLs (github.com/booni3/dhl-express-rest,
 *   github.com/sonnenglas/mydhl-php-sdk): test
 *   `https://express.api.dhl.com/mydhlapi/test`, production
 *   `https://express.api.dhl.com/mydhlapi`. `booni3`'s own package also
 *   confirms a required `x-version` header (its own pin: `3.3.1`) -- this
 *   connector sends `3.3.2`, the current version DHL's own docs page
 *   states as of this research pass.
 * - **`POST /shipments`** -- CONFIRMED path from both `booni3` and
 *   `sonnenglas`. **A genuine, three-way request-shape discrepancy across
 *   three independent community sources, worth flagging rather than
 *   silently picking one**: `booni3`'s PHP package uses flat top-level
 *   `shipper`/`receiver` Address objects and `shipperAccountNumber`;
 *   `sonnenglas`'s PHP SDK uses flat `shipperAddress`/`shipperContact`/
 *   `receiverAddress`/`receiverContact` plus an `accounts` array; a THIRD
 *   source -- `github.com/myorb/dhl-express-js`, whose own request/response
 *   TypeScript type names (`SupermodelIoLogisticsExpressCreateShipmentRequest`/
 *   `...Response`) read as generated directly from DHL's own official
 *   OpenAPI schema's own namespace, a stronger provenance signal than a
 *   hand-written SDK -- uses a NESTED shape instead:
 *   `customerDetails: { shipperDetails: { postalAddress, contactInformation
 *   }, receiverDetails: { ... } }`, `content: { isCustomsDeclarable,
 *   description, packages, incoterm, unitOfMeasurement }`, plus `accounts`,
 *   `productCode`, `plannedShippingDateAndTime`, `pickup: { isRequested }`.
 *   This connector uses the THIRD (nested) shape, on the "codegen-derived
 *   type names outrank a hand-written SDK's own naming choices" reasoning
 *   above -- **INFERRED, not independently confirmed against a literal
 *   rendered example**, this connector's single least-confirmed request
 *   body, same "flag it, don't hide it" precedent every other connector's
 *   own least-confirmed field already sets (Temu's `skuStockTargetList`,
 *   Evri's/Parcelforce's own request bodies, §4.7/§19.2/§19.4).
 *   `productCode: "N"` (DHL Express Worldwide) is CONFIRMED as a real,
 *   literal example value from `sonnenglas`'s own code sample.
 * - **CONFIRMED response field**: `shipmentTrackingNumber` (`sonnenglas`'s
 *   own literal `$response->shipmentTrackingNumber` /
 *   `$response->trackingNumber` -- both PHP SDKs independently expose this
 *   same concept under slightly different property names, cross-confirming
 *   that the underlying API field carries the shipment's own tracking
 *   number, not a separate carrier-order id the way Royal Mail's/FedEx's/
 *   UPS's own responses each carry). A base64-encoded label document is
 *   CONFIRMED to exist (`sonnenglas`'s own `getLabelPdf()`,
 *   `booni3`'s own `labelData()`) but the exact top-level JSON field/array
 *   shape wrapping it is **INFERRED** (`documents[].content`, a plausible
 *   shape given every source describes it as an array of documents, not a
 *   single field, since a shipment can return a label plus other
 *   paperwork) -- read defensively across a couple of candidate shapes,
 *   same discipline `EvriConnector`'s/`FedExConnector`'s own less-confirmed
 *   response parsing already establishes.
 * - **`voidShipment` deliberately NOT implemented -- confirmed as a real
 *   carrier-level limitation, not just an unconfirmed shape (a stronger,
 *   more specific finding than Evri's/FedEx's own "nothing found" gaps,
 *   §19.2/§19.3)**: a real, published community integration package
 *   (packagist.org/packages/tcgunel/omniship-dhl-express) documents this
 *   directly -- "DHL Express does not provide a label-voiding endpoint.
 *   The cancel operation cancels the associated pickup request," not the
 *   shipment/label itself. Implementing a `voidShipment()` that only
 *   cancels a pickup, while a caller reasonably expects it to void the
 *   shipment, would be actively misleading rather than merely incomplete
 *   -- left unimplemented, optional on `CarrierConnector` precisely for
 *   a case like this one.
 * - **Tracking is a SEPARATE DHL API, not part of MyDHL API at all** --
 *   CONFIRMED directly from DHL's own official "Shipment Tracking -
 *   Unified" docs page (developer.dhl.com/api-reference/shipment-tracking,
 *   fetched live, including a literal rendered curl example): `GET
 *   https://api-eu.dhl.com/track/shipments?trackingNumber={number}`,
 *   header `DHL-API-Key` (a subscription/Consumer Key from a SEPARATE
 *   developer.dhl.com app registration, not the MyDHL API's own Basic-auth
 *   credential pair). Response field names CONFIRMED (`status`,
 *   `statusCode`, `description`, `timestamp`, `location`) but the exact
 *   nesting (a `shipments[]` array, each with its own `events[]`, is the
 *   common DHL-documented convention but wasn't independently re-confirmed
 *   this pass) is **INFERRED**, read defensively. Same "one carrier, two
 *   genuinely separate credential sets" shape Royal Mail's own Click &
 *   Drop / Tracking API v2 split already established (§19.1) -- this
 *   connector's own `trackingApiKey` is optional, same "a tenant can skip
 *   live tracking without blocking labels" precedent
 *   `RoyalMailCredentials.trackingClientId`/`trackingClientSecret` already
 *   set, and `trackShipment()` throws a clear, explicit error rather than
 *   guessing when it's missing (mirroring
 *   `RoyalMailConnector.trackShipment()`'s own guard exactly).
 * - **`POST /rates`** -- CONFIRMED path (`sonnenglas`'s own literal
 *   endpoint list). Request body reuses the same nested `customerDetails`/
 *   `accounts`/`plannedShippingDateAndTime`/`unitOfMeasurement` shape
 *   `createShipment()` uses, on the same "DHL's own REST API family is
 *   internally consistent about its own object names" reasoning FedEx's/
 *   UPS's own `getRateEstimate()` request bodies already use (§19.3/§19.5).
 *   **Response shape is this connector's SECOND-least-confirmed piece**:
 *   no source found this pass rendered a literal example -- DHL's own docs
 *   page only describes the operation in prose ("will return DHL EXPRESS
 *   product capabilities (products, value added services and estimated
 *   delivery time) and your DHL EXPRESS Account rates"), confirming a
 *   `products` array exists conceptually but not its exact field names;
 *   `productName`/`productCode`/`totalPrice` are **INFERRED**, read
 *   defensively across a couple of candidate price-field shapes. This is
 *   the THIRD carrier connector in this layer (after FedEx §19.3 and UPS
 *   §19.5) to make a real live network call for a rate estimate, not a
 *   static table or an empty list.
 *
 * **UNVERIFIED IN PRACTICE, same status every other carrier in this layer
 * carried before its own first live pass**: no real DHL Express API
 * key/secret, account number, or Unified Tracking API key exists anywhere
 * in this codebase or Arif's account yet.
 */

const MYDHL_BASE_URL = "https://express.api.dhl.com/mydhlapi";
const DHL_API_VERSION = "3.3.2";
const TRACKING_BASE_URL = "https://api-eu.dhl.com";

export interface DhlCredentials {
  /** DHL Express MyDHL API's own username-equivalent half of its Basic-auth
   *  pair -- stored in carrier_connections.encrypted_client_id, same column
   *  every other client_id-shaped credential in this layer already reuses. */
  apiKey: string;
  /** The password-equivalent half -- carrier_connections.encrypted_client_secret. */
  apiSecret: string;
  /** DHL Express Shipper Account Number, required in every Shipping/Rating
   *  request's `accounts` array (confirmed field -- see this file's class
   *  doc comment). Stored in carrier_connections.external_account_id, the
   *  FOURTH carrier in this layer (after FedEx §19.3, Parcelforce §19.4,
   *  UPS §19.5) where that column holds a genuinely independent account
   *  identifier. */
  accountNumber: string;
  /** The Unified Tracking API's own DHL-API-Key -- a SEPARATE credential
   *  from apiKey/apiSecret above, issued by a different developer.dhl.com
   *  app registration (see this file's class doc comment). Optional, same
   *  "a tenant can skip live tracking without blocking labels" precedent
   *  RoyalMailCredentials.trackingClientId/trackingClientSecret already
   *  set (§19.1). Stored in carrier_connections.encrypted_refresh_token --
   *  the FIRST carrier connector in this layer to use that column, and NOT
   *  a literal OAuth refresh token (DHL's tracking key never expires/
   *  refreshes the way an OAuth refresh token does) -- a deliberate reuse
   *  of an otherwise-unused column for a second, independent secret, same
   *  "reuse the column that roughly fits, document what it actually holds"
   *  precedent Shopify's own encrypted_client_secret reuse (for a webhook
   *  secret, CLAUDE.md §4.5) and TikTok's own external_account_id reuse
   *  (for shop_cipher, §4.8) both already establish. */
  trackingApiKey?: string;
}

function basicAuthHeader(apiKey: string, apiSecret: string): string {
  return `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;
}

/** CONFIRMED core field (shipmentTrackingNumber). INFERRED label
 *  wrapper (documents[].content) -- see this file's class doc comment.
 *  Read defensively, same discipline every other less-confirmed connector
 *  response in this layer already establishes. */
interface DhlShipmentResponse {
  shipmentTrackingNumber?: string;
  trackingNumber?: string;
  documents?: Array<{ typeCode?: string; content?: string; imageFormat?: string }>;
  detail?: string;
  title?: string;
  additionalDetails?: string[];
  [key: string]: unknown;
}

/** CONFIRMED field names (status/statusCode/description/timestamp/
 *  location), INFERRED nesting -- see this file's class doc comment. */
interface DhlTrackingResponse {
  shipments?: Array<{
    status?: { status?: string; statusCode?: string; description?: string; timestamp?: string };
    events?: Array<{ status?: string; statusCode?: string; description?: string; timestamp?: string; location?: { address?: { addressLocality?: string } } }>;
  }>;
  detail?: string;
  [key: string]: unknown;
}

/** No confirmed literal example -- both `products` and each entry's own
 *  price/name/code fields are INFERRED, see this file's class doc comment. */
interface DhlRateResponse {
  products?: Array<{
    productName?: string;
    productCode?: string;
    totalPrice?: Array<{ price?: number; priceCurrency?: string }> | { price?: number; priceCurrency?: string };
  }>;
  detail?: string;
  [key: string]: unknown;
}

export class DhlConnector implements CarrierConnector {
  constructor(private readonly credentials: DhlCredentials) {}

  /** No token exchange -- MyDHL API's own credential model is a static
   *  Basic-auth pair applied directly to every request (see this file's
   *  class doc comment), not a client_credentials flow. Mirrors
   *  ParcelforceConnector.authenticate()'s own "no network call, return the
   *  credential itself as a placeholder token" shape (§19.4), for the same
   *  underlying reason: nothing to exchange. */
  async authenticate(_tenantCredentials?: CarrierTenantCredentials): Promise<CarrierAuthToken> {
    if (!this.credentials.apiKey || !this.credentials.apiSecret || !this.credentials.accountNumber) {
      throw new Error("DhlConnector.authenticate: apiKey, apiSecret, and accountNumber are all required");
    }
    return { accessToken: this.credentials.apiKey, expiresAt: "9999-12-31T23:59:59Z" };
  }

  private async mydhlRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    await this.authenticate();
    const response = await fetchWithBackoff(`${MYDHL_BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: basicAuthHeader(this.credentials.apiKey, this.credentials.apiSecret),
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-version": DHL_API_VERSION,
        ...init.headers,
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`DHL API error (${response.status}): ${body}`);
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private buildMinimalRateBody(weightGrams: number, destinationCountryCode: string) {
    return {
      customerDetails: {
        shipperDetails: { postalAddress: { countryCode: "GB" } },
        receiverDetails: { postalAddress: { countryCode: destinationCountryCode } },
      },
      accounts: [{ typeCode: "shipper", number: this.credentials.accountNumber }],
      plannedShippingDateAndTime: new Date().toISOString(),
      unitOfMeasurement: "metric",
      isCustomsDeclarable: destinationCountryCode !== "GB",
      packages: [{ weight: Math.max(weightGrams / 1000, 0.1) }],
    };
  }

  /** No confirmed cheap authenticated read-only endpoint exists for MyDHL
   *  API (same gap EvriConnector's/FedExConnector's own verifyConnection()
   *  already flag, §19.2/§19.3) -- proxies via a minimal live POST /rates
   *  call, the lightest documented endpoint this pass found, and treats
   *  only a 401/403 as a rejected credential pair (any other status --
   *  even a 400 from an incomplete/placeholder body -- means DHL evaluated
   *  the credentials before rejecting the request shape). This assumption
   *  (401/403 fires before body validation) is standard REST API practice
   *  but wasn't independently proven against real DHL infrastructure this
   *  pass -- flagged here as this method's own least-confirmed piece. */
  async verifyConnection(): Promise<void> {
    await this.authenticate();
    const response = await fetchWithBackoff(`${MYDHL_BASE_URL}/rates`, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(this.credentials.apiKey, this.credentials.apiSecret),
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-version": DHL_API_VERSION,
      },
      body: JSON.stringify(this.buildMinimalRateBody(1000, "GB")),
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error(`DHL credentials rejected: ${response.status} ${response.statusText}`);
    }
  }

  /**
   * POST /shipments -- see this file's class doc comment for the full
   * CONFIRMED/INFERRED breakdown, including the three-way request-shape
   * discrepancy across independent community sources this connector had
   * to resolve.
   */
  async createShipment(request: CreateShipmentRequest): Promise<CreateShipmentResult> {
    const body = {
      plannedShippingDateAndTime: request.orderDate,
      pickup: { isRequested: false },
      productCode: request.serviceCode ?? "N",
      accounts: [{ typeCode: "shipper", number: this.credentials.accountNumber }],
      customerDetails: {
        shipperDetails: {
          postalAddress: { countryCode: "GB" },
          contactInformation: {},
        },
        receiverDetails: {
          postalAddress: {
            addressLine1: request.recipient.addressLine1,
            addressLine2: request.recipient.addressLine2,
            cityName: request.recipient.city,
            postalCode: request.recipient.postalCode,
            countryCode: request.recipient.countryCode,
          },
          contactInformation: {
            fullName: request.recipient.name,
            phone: request.recipient.phone,
            email: request.recipient.email,
          },
        },
      },
      content: {
        isCustomsDeclarable: request.recipient.countryCode !== "GB",
        description: request.orderReference.slice(0, 90),
        incoterm: "DAP",
        unitOfMeasurement: "metric",
        packages: request.packages.map((pkg) => ({ weight: Math.max(pkg.weightGrams / 1000, 0.1) })),
      },
    };

    const result = await this.mydhlRequest<DhlShipmentResponse>("/shipments", {
      method: "POST",
      body: JSON.stringify(body),
    });

    const trackingNumber = result.shipmentTrackingNumber ?? result.trackingNumber ?? null;
    if (!trackingNumber) {
      throw new Error(`DHL shipment creation: no shipmentTrackingNumber found in response (${JSON.stringify(result)})`);
    }
    const document = result.documents?.find((d) => (d.typeCode ?? "").toLowerCase().includes("label")) ?? result.documents?.[0];

    return {
      carrierOrderId: trackingNumber,
      trackingNumber,
      labelBase64: document?.content ?? null,
      raw: result,
    };
  }

  // voidShipment is deliberately NOT implemented -- CONFIRMED that DHL
  // Express's MyDHL API has no true label-void endpoint at all (a "cancel"
  // operation only cancels the associated pickup request, not the
  // shipment/label itself) -- see this file's class doc comment.

  /** GET https://api-eu.dhl.com/track/shipments -- DHL's own SEPARATE
   *  Unified Tracking API, a different credential (trackingApiKey) from
   *  everything else this connector calls -- see this file's class doc
   *  comment. Throws a clear, explicit error when trackingApiKey isn't
   *  configured, mirroring RoyalMailConnector.trackShipment()'s own guard
   *  exactly (§19.1). */
  async trackShipment(trackingNumber: string): Promise<TrackingResult> {
    if (!this.credentials.trackingApiKey) {
      throw new Error("DhlConnector.trackShipment: no Unified Tracking API key configured for this connection");
    }

    const response = await fetchWithBackoff(
      `${TRACKING_BASE_URL}/track/shipments?trackingNumber=${encodeURIComponent(trackingNumber)}`,
      {
        method: "GET",
        headers: { "DHL-API-Key": this.credentials.trackingApiKey, Accept: "application/json" },
      },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`DHL Tracking API error (${response.status}): ${body}`);
    }
    const result = (await response.json()) as DhlTrackingResponse;

    const shipment = result.shipments?.[0];
    const events: TrackingEvent[] = (shipment?.events ?? []).map((event) => ({
      eventCode: event.statusCode ?? "",
      eventName: event.description ?? event.status ?? "",
      eventDateTime: event.timestamp ?? "",
      locationName: event.location?.address?.addressLocality ?? null,
    }));

    return {
      trackingNumber,
      statusCategory: shipment?.status?.statusCode ?? "unknown",
      statusDescription: shipment?.status?.description ?? shipment?.status?.status ?? "",
      events,
      raw: result,
    };
  }

  /**
   * POST /rates -- a REAL live network call, the THIRD carrier connector in
   * this layer (after FedEx §19.3 and UPS §19.5) to make one for a rate
   * estimate. See this file's class doc comment for what's CONFIRMED (path,
   * the request body's shared shape with createShipment()) vs. INFERRED
   * (the response's own field names -- this method's own least-confirmed
   * piece, no literal example found anywhere this pass).
   */
  async getRateEstimate(request: { weightGrams: number; destinationCountryCode: string; shipDate: string }): Promise<RateEstimate[]> {
    const result = await this.mydhlRequest<DhlRateResponse>("/rates", {
      method: "POST",
      body: JSON.stringify(this.buildMinimalRateBody(request.weightGrams, request.destinationCountryCode)),
    });

    return (result.products ?? []).map((product) => {
      const totalPrice = Array.isArray(product.totalPrice) ? product.totalPrice[0] : product.totalPrice;
      return {
        serviceCode: product.productCode ?? "unknown",
        serviceName: product.productName ?? product.productCode ?? "DHL service",
        estimatedCostGbp: (totalPrice?.price ?? 0).toFixed(2),
        surchargesApplied: true,
      };
    });
  }
}

/** Mirrors loadFedExCredentialsFromCarrierConnection's own shape
 *  (fedex-connector.ts) -- most-recently-created active row, since
 *  carrier_connections' own UNIQUE(tenant_id, carrier) constraint
 *  (migration 0039) means there is at most one per tenant anyway. */
export async function loadDhlCredentialsFromCarrierConnection(pool: Pool, tenantId: string): Promise<DhlCredentials> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query<{
      encrypted_client_id: Buffer | null;
      encrypted_client_secret: Buffer | null;
      external_account_id: string | null;
      encrypted_refresh_token: Buffer | null;
    }>(
      `SELECT encrypted_client_id, encrypted_client_secret, external_account_id, encrypted_refresh_token
         FROM carrier_connections
        WHERE carrier = 'dhl' AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 1`,
    );

    const row = result.rows[0];
    if (!row || !row.encrypted_client_id || !row.encrypted_client_secret || !row.external_account_id) {
      throw new Error(`No active 'dhl' carrier_connections row found for tenant ${tenantId}`);
    }

    const apiKey = await decryptChannelSecret(client, row.encrypted_client_id);
    const apiSecret = await decryptChannelSecret(client, row.encrypted_client_secret);
    const trackingApiKey = row.encrypted_refresh_token
      ? await decryptChannelSecret(client, row.encrypted_refresh_token)
      : undefined;
    return { apiKey, apiSecret, accountNumber: row.external_account_id, trackingApiKey };
  });
}

export async function createDhlConnectorFromCarrierConnection(pool: Pool, tenantId: string): Promise<DhlConnector> {
  const credentials = await loadDhlCredentialsFromCarrierConnection(pool, tenantId);
  return new DhlConnector(credentials);
}
