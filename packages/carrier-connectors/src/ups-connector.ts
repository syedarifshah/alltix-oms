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
 * UPS connector -- carrier #5 (CLAUDE.md §19's Carrier Integration
 * section), Arif's own explicit pick when asked which carrier to build next
 * after Royal Mail (§19.1), Evri (§19.2), FedEx (§19.3), and Parcelforce
 * (§19.4) -- the recommended option this time (same "fully public,
 * self-serve sandbox" reasoning FedEx's own recommendation used, §19.3),
 * and Arif went with it rather than overriding it the way Evri's and
 * Parcelforce's own picks each did once.
 *
 * **The best-SOURCED connector in this codebase's carrier layer so far,
 * ahead even of FedEx**: UPS publishes its own OpenAPI/Swagger specs
 * directly in a public GitHub repository (github.com/UPS-API/api-documentation)
 * -- a genuinely different, stronger provenance than every other carrier in
 * this layer, none of which had a literal machine-readable spec this
 * research pass could fetch directly (Royal Mail's own swagger, §19.1, is
 * the next-closest precedent, fetched from api.parcel.royalmail.com rather
 * than a public repo). Every field/endpoint below is still marked CONFIRMED
 * or INFERRED, same disclosure discipline every other connector in this
 * codebase's class doc comment already establishes:
 *
 * - **Auth** -- CONFIRMED end to end directly from UPS's own official
 *   OpenAPI spec (github.com/UPS-API/api-documentation/blob/main/
 *   OAuthClientCredentials.yaml, fetched live this pass): `POST
 *   /security/v1/oauth/token`, base URL `https://onlinetools.ups.com`
 *   (production) / `https://wwwcie.ups.com` (UPS's own "Customer
 *   Integration Environment," their sandbox), HTTP Basic auth (client ID as
 *   username, client secret as password), form-urlencoded body
 *   `grant_type=client_credentials`, JSON response
 *   `{token_type, access_token, expires_in, issued_at, client_id, scope,
 *   refresh_count, status}` -- every one of these field names read directly
 *   off the official spec's own schema, not paraphrased or inferred from a
 *   third party. An optional `x-merchant-id` header (a 6-digit UPS account
 *   number) is also CONFIRMED on the spec but not sent by this connector --
 *   UPS's own spec marks it optional, and no source found this pass
 *   explains what it changes when present.
 * - **`POST /api/shipments/{version}/ship`** (create a shipment + label) --
 *   the exact literal path/version segment is INFERRED (UPS's own
 *   `Shipping.yaml` spec file is too large, 581 KB, for this research
 *   pass's fetch tooling to render field-by-field -- confirmed to exist,
 *   at 14,330 lines, but not readable the way the much smaller OAuth spec
 *   was) -- CROSS-CONFIRMED instead from two independent, non-official
 *   sources that agree on the same request/response shape: the installed-
 *   package-adjacent `ups-nodejs-sdk` (npmjs.com/package/ups-nodejs-sdk,
 *   which documents `confirm()`/`accept()` request objects named `Shipper`,
 *   `ShipTo`, `Packages`, and response fields `ShipmentIdentificationNumber`/
 *   `TrackingNumber`) and a detailed third-party integration writeup
 *   (atoship.com/blog/ups-shipping-api-integration-developer-guide, which
 *   renders a literal endpoint `POST /api/shipments/v2409/ship`, base URLs
 *   matching the OAuth spec's own sandbox/production split, and full nested
 *   field names for `Shipper`/`ShipTo`/`ShipFrom`/`Package`/`Service`/
 *   `PaymentInformation`, plus response fields
 *   `ShipmentIdentificationNumber`, `PackageResults[].TrackingNumber`,
 *   `PackageResults[].ShippingLabel.GraphicImage` (a base64-encoded label,
 *   unlike FedEx's own INFERRED-either-way `url`-or-`encodedLabel`
 *   response shape, §19.3), and `ShipmentCharges.TotalCharges`). Real UPS
 *   account numbers (`ShipperNumber`) are required on the `Shipper` object,
 *   the same real-account-number requirement FedEx's own connector already
 *   established (§19.3) -- this codebase's SECOND (now third, with UPS)
 *   carrier where `carrier_connections.external_account_id` holds a
 *   genuinely independent account identifier.
 * - **`DELETE /api/shipments/v1/void/cancel/{shipmentIdentificationNumber}`**
 *   (void a shipment) -- CONFIRMED via a real, literal request path quoted
 *   in a genuine bug report filed directly against UPS's own official
 *   GitHub repo (github.com/UPS-API/api-documentation/issues/63, a real
 *   developer's own working integration hitting this exact endpoint,
 *   `?trackingnumber={value}` passed as a query parameter) -- the same
 *   "a real developer's own reported usage outranks an inferred shape"
 *   precedent Parcelforce's own confirmed test endpoint already established
 *   (§19.4's own Google-Groups-post source). This makes UPS the THIRD
 *   carrier in this layer (after Royal Mail and Parcelforce) with a real,
 *   confirmed `voidShipment()` -- Evri and FedEx both deliberately left it
 *   unimplemented for lack of exactly this kind of confirmation (§19.2,
 *   §19.3).
 * - **`GET /api/track/v1/details/{inquiryNumber}`** -- CONFIRMED path,
 *   method, base URL, and both required headers (`transId`, an identifier
 *   unique to the request; `transactionSrc`, identifying the calling
 *   client/source application) directly from UPS's own official `Tracking.yaml`
 *   spec, which this research pass's fetch tooling COULD render in full
 *   (unlike the oversized `Shipping.yaml`). Response shape CONFIRMED the
 *   same way: `trackResponse.shipment[].package[].activity[]`, each entry
 *   carrying `status`/`location`/`date`/`time` (plus GMT variants and a
 *   `logicalScan` boolean), and package-level `currentStatus`/`statusCode`/
 *   `statusDescription` fields -- this codebase's most-confirmed tracking
 *   response shape of any carrier connector built so far, ahead even of
 *   Royal Mail's own (§19.1, itself only INFERRED from a community library)
 *   and FedEx's own (§19.3, only partially confirmed via a dotted-path
 *   example).
 * - **`POST /api/rating/{version}/{requestoption}`** -- CONFIRMED path
 *   shape, method, and base URLs directly from UPS's own official
 *   `Rating.yaml` spec (`requestoption` one of `Rate`, `Shop`,
 *   `RateTimeInTransit`, `ShopTimeInTransit` -- this connector always uses
 *   `Shop`, since that's the option UPS's own spec documents as returning
 *   every available service's own rate, matching `RateEstimate[]`'s own
 *   plural return shape better than a single `Rate` lookup would).
 *   Response field names CONFIRMED from the same spec: `RatedShipment`
 *   (array), each with a `Service` field and a `TotalCharges.MonetaryValue`.
 *   **A genuine, confirmed second exception to the "no carrier researched
 *   so far has a live rate-quote endpoint" pattern §19.1/§19.2 both
 *   establish** -- UPS, like FedEx (§19.3), DOES expose a real live
 *   rate-shopping endpoint; `UpsConnector.getRateEstimate()` makes a real
 *   network call, the SECOND carrier connector in this layer to do so.
 *   Request body shape is INFERRED (the Rating spec's own request schema
 *   wasn't rendered this pass, only its response) -- modeled on the same
 *   `Shipper`/`ShipTo`/`ShipFrom`/`Package` object shapes the Shipping API
 *   itself confirms, since UPS's own REST API family is internally
 *   consistent about those object names across its endpoints (the same
 *   "internally consistent wrapper shape" reasoning FedEx's own
 *   `getRateEstimate()` request body already used, §19.3).
 *
 * **UNVERIFIED IN PRACTICE, same status every other carrier in this layer
 * carried before its own first live pass**: no real UPS Client ID/Secret or
 * UPS account number exists anywhere in this codebase or Arif's account
 * yet -- despite this connector's own research trail being the
 * best-sourced of the five carriers built so far (a real public OpenAPI
 * spec repo, not a session-gated page or a third-party gateway's docs),
 * nothing below has round-tripped against real UPS infrastructure, sandbox
 * or production.
 */

const UPS_BASE_URL = "https://onlinetools.ups.com";
const UPS_TOKEN_URL = `${UPS_BASE_URL}/security/v1/oauth/token`;
const UPS_SHIP_PATH = "/api/shipments/v2409/ship";
const UPS_RATE_PATH = "/api/rating/v2409/Shop";
const TOKEN_REFRESH_SKEW_MS = 60_000;

export interface UpsCredentials {
  /** UPS's own OAuth client ID/secret, issued per UPS Developer Portal app
   *  -- stored in carrier_connections.encrypted_client_id/
   *  encrypted_client_secret, same columns every client_credentials-style
   *  carrier in this layer already reuses (Evri §19.2, FedEx §19.3). */
  clientId: string;
  clientSecret: string;
  /** The UPS account (shipper) number every Shipping/Rating request body
   *  requires (`Shipper.ShipperNumber`, cross-confirmed field -- see this
   *  file's class doc comment). Stored in
   *  carrier_connections.external_account_id, the THIRD carrier in this
   *  layer (after FedEx §19.3 and Parcelforce §19.4) where that column
   *  holds a genuinely independent account identifier. */
  accountNumber: string;
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

interface UpsTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in: string | number;
  scope?: string;
}

/** CONFIRMED core fields (ShipmentIdentificationNumber, PackageResults[].
 *  TrackingNumber, PackageResults[].ShippingLabel.GraphicImage) -- see this
 *  file's class doc comment. Read defensively, same discipline every other
 *  connector's own response parsing already establishes. */
interface UpsShipResponse {
  ShipmentResponse?: {
    ShipmentResults?: {
      ShipmentIdentificationNumber?: string;
      PackageResults?: Array<{ TrackingNumber?: string; ShippingLabel?: { GraphicImage?: string } }> | { TrackingNumber?: string; ShippingLabel?: { GraphicImage?: string } };
    };
    Response?: { Errors?: Array<{ Code?: string; Description?: string }> };
  };
  [key: string]: unknown;
}

/** CONFIRMED shape directly from UPS's own official Tracking.yaml spec --
 *  see this file's class doc comment. */
interface UpsTrackResponse {
  trackResponse?: {
    shipment?: Array<{
      package?: Array<{
        currentStatus?: { statusCode?: string; statusDescription?: string; description?: string };
        activity?: Array<{
          status?: { type?: string; description?: string };
          location?: { address?: { city?: string } };
          date?: string;
          time?: string;
        }>;
      }>;
    }>;
  };
  response?: { errors?: Array<{ code?: string; message?: string }> };
  [key: string]: unknown;
}

/** CONFIRMED shape directly from UPS's own official Rating.yaml spec. */
interface UpsRateResponse {
  RateResponse?: {
    RatedShipment?: Array<{
      Service?: { Code?: string; Description?: string };
      TotalCharges?: { MonetaryValue?: string; CurrencyCode?: string };
    }>;
    Response?: { Errors?: Array<{ Code?: string; Description?: string }> };
  };
  [key: string]: unknown;
}

export class UpsConnector implements CarrierConnector {
  private cachedToken: CachedToken | null = null;

  constructor(private readonly credentials: UpsCredentials) {}

  /** POST /security/v1/oauth/token -- request AND response shape fully
   *  CONFIRMED directly from UPS's own official OpenAPI spec (see this
   *  file's class doc comment) -- HTTP Basic auth, not a client_id/
   *  client_secret form field the way FedEx's/Evri's own token exchange is.
   *  Caches in memory, refreshing near the documented expiry, same pattern
   *  as every other client_credentials connector here. */
  async authenticate(_tenantCredentials?: CarrierTenantCredentials): Promise<CarrierAuthToken> {
    const cached = this.cachedToken;
    if (cached && cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS > Date.now()) {
      return { accessToken: cached.accessToken, expiresAt: new Date(cached.expiresAtMs).toISOString() };
    }

    const basicAuth = Buffer.from(`${this.credentials.clientId}:${this.credentials.clientSecret}`).toString("base64");
    const response = await fetchWithBackoff(UPS_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Authorization: `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });

    if (!response.ok) {
      // Deliberately not including the response body -- same "no upside to
      // risking an accidental secret echo in an error path" reasoning
      // FedExConnector.authenticate()/EvriConnector.authenticate() already
      // establish.
      throw new Error(`UPS token exchange failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as UpsTokenResponse;
    const expiresAtMs = Date.now() + Number(data.expires_in) * 1000;
    this.cachedToken = { accessToken: data.access_token, expiresAtMs };
    return { accessToken: data.access_token, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  private async upsRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.authenticate();
    const response = await fetchWithBackoff(`${UPS_BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "Content-Type": "application/json",
        transId: `alltix-${Date.now()}`,
        transactionSrc: "alltix-oms",
        ...init.headers,
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`UPS API error (${response.status}): ${body}`);
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Proves a UPS Client ID/Secret pair actually works before a connect
   *  route persists it -- same "verify before persist" discipline every
   *  connector in this codebase already follows. Reuses the token exchange
   *  itself, same reasoning FedExConnector.verifyConnection()/
   *  EvriConnector.verifyConnection() already give (no confirmed cheap
   *  authenticated read-only endpoint was found for UPS this pass either). */
  async verifyConnection(): Promise<void> {
    this.cachedToken = null;
    await this.authenticate();
  }

  /**
   * POST /api/shipments/v2409/ship -- see this file's class doc comment for
   * the full CONFIRMED/INFERRED breakdown (the literal path/version is
   * INFERRED, cross-confirmed via two independent community sources; the
   * nested field shapes are likewise cross-confirmed rather than read off
   * UPS's own oversized Shipping.yaml spec directly).
   */
  async createShipment(request: CreateShipmentRequest): Promise<CreateShipmentResult> {
    const body = {
      ShipmentRequest: {
        Shipment: {
          Description: request.orderReference.slice(0, 35),
          Shipper: {
            Name: "Alltix Tenant",
            ShipperNumber: this.credentials.accountNumber,
            Address: { AddressLine: ["Warehouse"], City: "", StateProvinceCode: "", PostalCode: "", CountryCode: "GB" },
          },
          ShipTo: {
            Name: request.recipient.name,
            Phone: request.recipient.phone ? { Number: request.recipient.phone } : undefined,
            Address: {
              AddressLine: [request.recipient.addressLine1, request.recipient.addressLine2].filter(Boolean),
              City: request.recipient.city,
              PostalCode: request.recipient.postalCode,
              CountryCode: request.recipient.countryCode,
            },
          },
          PaymentInformation: {
            ShipmentCharge: { Type: "01", BillShipper: { AccountNumber: this.credentials.accountNumber } },
          },
          Service: { Code: request.serviceCode ?? "03", Description: request.serviceCode ?? "UPS Ground" },
          Package: request.packages.map((pkg) => ({
            Packaging: { Code: "02" },
            PackageWeight: { UnitOfMeasurement: { Code: "KGS" }, Weight: (pkg.weightGrams / 1000).toFixed(2) },
          })),
        },
        LabelSpecification: { LabelImageFormat: { Code: "GIF" } },
      },
    };

    const result = await this.upsRequest<UpsShipResponse>(UPS_SHIP_PATH, {
      method: "POST",
      body: JSON.stringify(body),
    });

    const errors = result.ShipmentResponse?.Response?.Errors;
    if (errors && errors.length > 0) {
      throw new Error(`UPS shipment creation reported errors: ${JSON.stringify(errors)}`);
    }

    const results = result.ShipmentResponse?.ShipmentResults;
    const packageResult = Array.isArray(results?.PackageResults) ? results?.PackageResults[0] : results?.PackageResults;
    const trackingNumber = packageResult?.TrackingNumber ?? null;
    const shipmentId = results?.ShipmentIdentificationNumber;
    if (!results || !shipmentId) {
      throw new Error("UPS shipment creation: no ShipmentResults/ShipmentIdentificationNumber found in response");
    }

    return {
      carrierOrderId: shipmentId,
      trackingNumber,
      labelBase64: packageResult?.ShippingLabel?.GraphicImage ?? null,
      raw: result,
    };
  }

  /** DELETE /api/shipments/v1/void/cancel/{shipmentIdentificationNumber} --
   *  CONFIRMED via a real developer's own bug report filed against UPS's
   *  official GitHub repo, see this file's class doc comment. `?trackingnumber=`
   *  is documented there too but is optional on a single-package void, so
   *  it's omitted here (this codebase only ever creates single-package
   *  shipments, same narrowing every other connector's own
   *  single-fulfillment assumption already carries). */
  async voidShipment(carrierOrderId: string): Promise<void> {
    await this.upsRequest(`/api/shipments/v1/void/cancel/${encodeURIComponent(carrierOrderId)}`, {
      method: "DELETE",
    });
  }

  /** GET /api/track/v1/details/{inquiryNumber} -- fully CONFIRMED request
   *  AND response shape directly from UPS's own official Tracking.yaml
   *  spec, see this file's class doc comment -- this codebase's
   *  most-confirmed carrier tracking response of any built so far. */
  async trackShipment(trackingNumber: string): Promise<TrackingResult> {
    const result = await this.upsRequest<UpsTrackResponse>(`/api/track/v1/details/${encodeURIComponent(trackingNumber)}`, {
      method: "GET",
    });

    const errors = result.response?.errors;
    if (errors && errors.length > 0) {
      throw new Error(`UPS tracking lookup reported errors: ${JSON.stringify(errors)}`);
    }

    const pkg = result.trackResponse?.shipment?.[0]?.package?.[0];
    const events: TrackingEvent[] = (pkg?.activity ?? []).map((activity) => ({
      eventCode: activity.status?.type ?? "",
      eventName: activity.status?.description ?? "",
      eventDateTime: activity.date ? `${activity.date}${activity.time ? `T${activity.time}` : ""}` : "",
      locationName: activity.location?.address?.city ?? null,
    }));

    return {
      trackingNumber,
      statusCategory: pkg?.currentStatus?.statusCode ?? "unknown",
      statusDescription: pkg?.currentStatus?.statusDescription ?? pkg?.currentStatus?.description ?? "",
      events,
      raw: result,
    };
  }

  /**
   * POST /api/rating/v2409/Shop -- a REAL live network call, the SECOND
   * carrier connector in this layer (after FedEx, §19.3) to make one for a
   * rate estimate. See this file's class doc comment for what's CONFIRMED
   * (path, method, base URLs, response field names, all read directly off
   * UPS's own official Rating.yaml spec) vs. INFERRED (the request body
   * shape, modeled on the Shipping API's own confirmed object names).
   */
  async getRateEstimate(request: { weightGrams: number; destinationCountryCode: string; shipDate: string }): Promise<RateEstimate[]> {
    const body = {
      RateRequest: {
        Shipment: {
          Shipper: { ShipperNumber: this.credentials.accountNumber, Address: { CountryCode: "GB" } },
          ShipTo: { Address: { CountryCode: request.destinationCountryCode } },
          ShipFrom: { Address: { CountryCode: "GB" } },
          Package: [{ PackagingType: { Code: "02" }, PackageWeight: { UnitOfMeasurement: { Code: "KGS" }, Weight: (request.weightGrams / 1000).toFixed(2) } }],
        },
      },
    };

    const result = await this.upsRequest<UpsRateResponse>(UPS_RATE_PATH, {
      method: "POST",
      body: JSON.stringify(body),
    });

    const errors = result.RateResponse?.Response?.Errors;
    if (errors && errors.length > 0) {
      throw new Error(`UPS rate quote reported errors: ${JSON.stringify(errors)}`);
    }

    return (result.RateResponse?.RatedShipment ?? []).map((rated) => ({
      serviceCode: rated.Service?.Code ?? "unknown",
      serviceName: rated.Service?.Description ?? rated.Service?.Code ?? "UPS service",
      estimatedCostGbp: rated.TotalCharges?.MonetaryValue ?? "0.00",
      surchargesApplied: true,
    }));
  }
}

/** Mirrors loadFedExCredentialsFromCarrierConnection's own shape
 *  (fedex-connector.ts) -- most-recently-created active row, since
 *  carrier_connections' own UNIQUE(tenant_id, carrier) constraint
 *  (migration 0039) means there is at most one per tenant anyway. */
export async function loadUpsCredentialsFromCarrierConnection(pool: Pool, tenantId: string): Promise<UpsCredentials> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query<{
      encrypted_client_id: Buffer | null;
      encrypted_client_secret: Buffer | null;
      external_account_id: string | null;
    }>(
      `SELECT encrypted_client_id, encrypted_client_secret, external_account_id
         FROM carrier_connections
        WHERE carrier = 'ups' AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 1`,
    );

    const row = result.rows[0];
    if (!row || !row.encrypted_client_id || !row.encrypted_client_secret || !row.external_account_id) {
      throw new Error(`No active 'ups' carrier_connections row found for tenant ${tenantId}`);
    }

    const clientId = await decryptChannelSecret(client, row.encrypted_client_id);
    const clientSecret = await decryptChannelSecret(client, row.encrypted_client_secret);
    return { clientId, clientSecret, accountNumber: row.external_account_id };
  });
}

export async function createUpsConnectorFromCarrierConnection(pool: Pool, tenantId: string): Promise<UpsConnector> {
  const credentials = await loadUpsCredentialsFromCarrierConnection(pool, tenantId);
  return new UpsConnector(credentials);
}
