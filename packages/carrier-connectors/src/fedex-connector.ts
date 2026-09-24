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
 * FedEx connector -- carrier #3 (CLAUDE.md §19's Carrier Integration
 * section), Arif's own explicit pick when asked which carrier to build
 * next after Royal Mail (§19.1) and Evri (§19.2), recommended and chosen
 * specifically because FedEx has a fully public, self-serve developer
 * sandbox (developer.fedex.com) -- the strongest documentation foundation
 * of the three carriers built so far, closer to Royal Mail's own
 * official-swagger-spec experience than Evri's third-party-gateway
 * workaround (Evri itself publishes no API at all -- §19.2's own class doc
 * comment).
 *
 * **Genuinely the best-sourced connector in this codebase's carrier layer
 * so far** -- developer.fedex.com's own docs pages render cleanly for an
 * unauthenticated fetch (unlike Royal Mail's session-gated pages, unlike
 * Evri's/Temu's/TikTok's unreadable JS-SPA doc sites), and a literal,
 * rendered OAuth example was found directly on FedEx's own page. Every
 * field/endpoint below is still marked CONFIRMED or INFERRED, same
 * disclosure discipline every other connector in this codebase's class doc
 * comment already establishes:
 *
 * - **Auth** -- CONFIRMED end to end, including a literal rendered example,
 *   from FedEx's own official page
 *   (developer.fedex.com/api/en-us/catalog/authorization/docs.html):
 *   `POST https://apis.fedex.com/oauth/token` (sandbox:
 *   `https://apis-sandbox.fedex.com/oauth/token`, CONFIRMED separately via a
 *   real, independent third-party integration writeup --
 *   ecomplugins.com/blog/how-to-use-3rd-party-fedex-account-shipping-label-via-fedex-rest-api-oauth-2-0),
 *   form-urlencoded body `grant_type=client_credentials&client_id=...&client_secret=...`,
 *   JSON response `{access_token, token_type, expires_in, scope}` -- FedEx's
 *   own docs page renders this exact example verbatim. `client_id`/
 *   `client_secret` are FedEx's own "Project API Key"/"Project API Secret
 *   Key," issued per developer-portal "project" (roughly the same shape as
 *   every other client_credentials connector in this codebase -- Walmart,
 *   Evri/Sapient -- just with FedEx's own naming).
 * - **`POST /ship/v1/shipments`** (create a shipment + label) -- CONFIRMED
 *   path (base URL `https://apis.fedex.com`, sandbox
 *   `https://apis-sandbox.fedex.com`, both cross-confirmed across FedEx's
 *   own docs page and the ecomplugins.com integration writeup above, which
 *   also renders a real literal example request body). Top-level request
 *   shape CONFIRMED from two independent sources: FedEx's own docs page
 *   names `accountNumber`, `pickupType`, `serviceType`, `packagingType`,
 *   `shipper`, `recipients`, `shippingPaymentType`, `payerInformation`,
 *   `packages` (with per-package weight), `labelSpecification`, all wrapped
 *   in a `requestedShipment` object; the ecomplugins.com writeup's own
 *   literal example shows the payment field nested as
 *   `shippingChargesPayment: { paymentType: "THIRD_PARTY" }` and
 *   `labelSpecification: { imageType: "PDF", labelStockType: "PAPER_4X6" }`
 *   verbatim, plus `requestedPackageLineItems` for package weight/dimensions
 *   -- **a real, worth-flagging discrepancy between the two sources' own
 *   field-naming for the payment object** (`shippingPaymentType` vs.
 *   `shippingChargesPayment.paymentType`), most likely the first being a
 *   paraphrase by the docs page's own summarized prose rather than a second,
 *   genuinely different API shape -- this connector uses the literal,
 *   example-confirmed `shippingChargesPayment.paymentType` shape. Whether
 *   the destination field is `recipients` (an array, per FedEx's own docs
 *   page) or a singular `recipient` (per the ecomplugins.com literal
 *   example) is a second, similarly unresolved discrepancy -- **INFERRED**
 *   here as `recipients: [...]` (an array of one), matching the OFFICIAL
 *   page's own naming, since a plural array is also the shape every other
 *   multi-piece-capable API in this codebase's own carrier layer uses.
 * - **CONFIRMED response shape** (github.com/WhatArmy/FedexRest, a real
 *   FedEx REST API wrapper's own documented response fields, cross-checked
 *   against the concept FedEx's own docs page separately confirms --
 *   "the successful response will provide the tracking number and label
 *   information"): `masterTrackingNumber`/`trackingNumber` for the tracking
 *   number, a `packageDocuments` array with a `url` field for the label.
 *   **INFERRED**: whether a base64-encoded label (`encodedLabel`, the
 *   common alternative shape several other carriers in this codebase use --
 *   Royal Mail's own confirmed `label` field, §19.1) is ALSO present
 *   alongside or instead of the `url` field -- no source found this pass
 *   confirms this either way; this connector reads both a `url`-style and
 *   an `encodedLabel`-style field defensively, same "read several plausible
 *   candidates" discipline EvriConnector.createShipment() already
 *   establishes (§19.2) for its own less-confirmed response shape.
 * - **`POST /track/v1/trackingnumbers`** -- CONFIRMED path and CONFIRMED
 *   literal request-body shape (mixedanalytics.com's own real
 *   Google-Sheets-integration writeup, which renders the endpoint and a
 *   sample payload verbatim): `{"trackingInfo": [{"trackingNumberInfo":
 *   {"trackingNumber": "..."}}]}`. Response field paths partially CONFIRMED
 *   from FedEx's own docs page's own literal dotted-path example,
 *   `trackResults.scanEvents.delayDetail.status` -- confirming `trackResults`
 *   (an array) and a nested `scanEvents` array exist as named. **INFERRED**:
 *   the exact field names for a scan event's own code/description/location/
 *   timestamp (no literal per-event JSON example was found this pass) --
 *   modeled on Royal Mail's own confirmed Tracking API v2 event shape for
 *   lack of a better source, same "no better source" precedent this
 *   codebase's own least-confirmed fields already carry (Temu's
 *   `skuStockTargetList`, Evri's request body, §4.7/§19.2).
 * - **`POST /rate/v1/rates/quotes`** -- CONFIRMED path (mixedanalytics.com)
 *   and CONFIRMED response field names (github.com/WhatArmy/FedexRest's own
 *   literal example: `transactionId`, `rateReplyDetails` array with
 *   `serviceType`/`serviceName`, `ratedShipmentDetails` array with
 *   `totalNetCharge`). **This is a genuine, confirmed difference from
 *   Royal Mail and Evri, worth stating plainly: FedEx DOES expose a real
 *   live rate-shopping endpoint** -- neither Royal Mail's Click & Drop API
 *   (§19.1) nor anything found for Sapient/Evri (§19.2) has one.
 *   `EvriConnector`/`RoyalMailConnector.getRateEstimate()` are therefore
 *   necessarily non-network lookups; `FedExConnector.getRateEstimate()` is
 *   this codebase's FIRST carrier connector to make a real live network
 *   call for a rate estimate. Request body shape is **INFERRED** (no
 *   literal request example was found this pass, only the response) --
 *   modeled on the same `requestedShipment`-style wrapper the Ship API
 *   itself confirms, since FedEx's own REST API family is internally
 *   consistent about that wrapper shape across its endpoints.
 * - **`voidShipment` deliberately NOT implemented** -- a FedEx shipment
 *   cancellation endpoint almost certainly exists (every major carrier API
 *   researched so far has one in some form), but no literal, confirmed
 *   endpoint path was found anywhere in this research pass -- optional on
 *   the interface precisely for this reason, same "don't guess a
 *   DELETE/PUT shape with nothing to verify it against" discipline
 *   EvriConnector's own class doc comment already applies (§19.2).
 *
 * **UNVERIFIED IN PRACTICE, same status Royal Mail and Evri carried before
 * their own first live pass**: no real FedEx Project API Key/Secret or
 * account number exists anywhere in this codebase or Arif's account yet --
 * despite being the best-DOCUMENTED connector in this codebase's carrier
 * layer, it has round-tripped against nothing real, same as the other two.
 */

const FEDEX_BASE_URL = "https://apis.fedex.com";
const FEDEX_TOKEN_URL = `${FEDEX_BASE_URL}/oauth/token`;
const TOKEN_REFRESH_SKEW_MS = 60_000;

export interface FedExCredentials {
  /** FedEx's own "Project API Key"/"Project API Secret Key" -- stored in
   *  carrier_connections.encrypted_client_id/encrypted_client_secret, same
   *  columns Evri's own Sapient client_id/client_secret pair already
   *  established a reuse precedent for (§19.2). */
  clientId: string;
  clientSecret: string;
  /** The FedEx account number every Ship/Rate request body requires
   *  (`accountNumber`, confirmed field -- see this file's class doc
   *  comment). Stored in carrier_connections.external_account_id -- the
   *  FIRST carrier in this codebase's carrier layer where that column
   *  holds a genuinely real, independent account identifier rather than
   *  "nothing to reuse" (Royal Mail's/Evri's own connect routes both
   *  documented having nothing real to put there). */
  accountNumber: string;
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

interface FedExTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in: number;
  scope?: string;
}

/** CONFIRMED core fields (masterTrackingNumber/trackingNumber,
 *  packageDocuments[].url), INFERRED encodedLabel fallback -- see this
 *  file's class doc comment. Read defensively across a few candidate
 *  shapes, same discipline EvriConnector's own response parsing already
 *  establishes. */
interface FedExShipResponse {
  output?: {
    transactionShipments?: Array<{
      masterTrackingNumber?: string;
      pieceResponses?: Array<{
        trackingNumber?: string;
        packageDocuments?: Array<{ url?: string; encodedLabel?: string }>;
      }>;
    }>;
  };
  errors?: Array<{ message?: string; code?: string }>;
  [key: string]: unknown;
}

interface FedExTrackResponse {
  output?: {
    completeTrackResults?: Array<{
      trackResults?: Array<{
        latestStatusDetail?: { code?: string; description?: string };
        scanEvents?: Array<{ eventType?: string; eventDescription?: string; date?: string; scanLocation?: { city?: string } }>;
      }>;
    }>;
  };
  errors?: Array<{ message?: string; code?: string }>;
  [key: string]: unknown;
}

interface FedExRateResponse {
  output?: {
    rateReplyDetails?: Array<{
      serviceType?: string;
      serviceName?: string;
      ratedShipmentDetails?: Array<{ totalNetCharge?: { amount?: number; currency?: string }; currency?: string; totalNetFedExCharge?: number }>;
    }>;
  };
  errors?: Array<{ message?: string; code?: string }>;
  [key: string]: unknown;
}

export class FedExConnector implements CarrierConnector {
  private cachedToken: CachedToken | null = null;

  constructor(private readonly credentials: FedExCredentials) {}

  /** POST /oauth/token -- request AND response shape fully CONFIRMED with a
   *  literal rendered example on FedEx's own docs page (see this file's
   *  class doc comment) -- the most-confirmed auth flow of any carrier
   *  connector in this codebase so far. Caches in memory, refreshing near
   *  the documented one-hour expiry, same pattern as every other
   *  client_credentials connector here (Walmart §4.2, Evri §19.2). */
  async authenticate(_tenantCredentials?: CarrierTenantCredentials): Promise<CarrierAuthToken> {
    const cached = this.cachedToken;
    if (cached && cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS > Date.now()) {
      return { accessToken: cached.accessToken, expiresAt: new Date(cached.expiresAtMs).toISOString() };
    }

    const response = await fetchWithBackoff(FEDEX_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
      }),
    });

    if (!response.ok) {
      // Deliberately not including the response body -- same "no upside to
      // risking an accidental secret echo in an error path" reasoning
      // WalmartConnector.authenticate()/EvriConnector.authenticate() already
      // establish.
      throw new Error(`FedEx token exchange failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as FedExTokenResponse;
    const expiresAtMs = Date.now() + data.expires_in * 1000;
    this.cachedToken = { accessToken: data.access_token, expiresAtMs };
    return { accessToken: data.access_token, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  private async fedexRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.authenticate();
    const response = await fetchWithBackoff(`${FEDEX_BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "Content-Type": "application/json",
        "X-locale": "en_US",
        ...init.headers,
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`FedEx API error (${response.status}): ${body}`);
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Proves a FedEx Project API Key/Secret pair actually works before a
   *  connect route persists it -- same "verify before persist" discipline
   *  every connector in this codebase already follows. Reuses the token
   *  exchange itself, same reasoning EvriConnector.verifyConnection()
   *  already gives (no confirmed cheap authenticated read-only endpoint was
   *  found for FedEx this pass either). */
  async verifyConnection(): Promise<void> {
    this.cachedToken = null;
    await this.authenticate();
  }

  /**
   * POST /ship/v1/shipments -- see this file's class doc comment for the
   * full CONFIRMED/INFERRED breakdown of both the request and response
   * shapes, including the two real, flagged discrepancies found between
   * FedEx's own docs page and a third-party integration writeup.
   */
  async createShipment(request: CreateShipmentRequest): Promise<CreateShipmentResult> {
    const body = {
      // The `{ value: ... }` wrapper around accountNumber is INFERRED --
      // CONFIRMED that a top-level `accountNumber` field is required
      // (FedEx's own docs page), the object-wrapping shape itself is a
      // common FedEx REST convention, not confirmed by a literal example
      // this pass.
      accountNumber: { value: this.credentials.accountNumber },
      requestedShipment: {
        shipper: {},
        recipients: [
          {
            contact: { personName: request.recipient.name, phoneNumber: request.recipient.phone ?? "" },
            address: {
              streetLines: [request.recipient.addressLine1, request.recipient.addressLine2].filter(Boolean),
              city: request.recipient.city,
              postalCode: request.recipient.postalCode,
              countryCode: request.recipient.countryCode,
            },
          },
        ],
        pickupType: "USE_SCHEDULED_PICKUP",
        serviceType: request.serviceCode ?? "FEDEX_GROUND",
        packagingType: "YOUR_PACKAGING",
        shippingChargesPayment: { paymentType: "SENDER" },
        labelSpecification: { imageType: "PDF", labelStockType: "PAPER_4X6" },
        requestedPackageLineItems: request.packages.map((pkg) => ({
          weight: { units: "KG", value: pkg.weightGrams / 1000 },
        })),
      },
    };

    const result = await this.fedexRequest<FedExShipResponse>("/ship/v1/shipments", {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (result.errors && result.errors.length > 0) {
      throw new Error(`FedEx shipment creation reported errors: ${JSON.stringify(result.errors)}`);
    }

    const shipment = result.output?.transactionShipments?.[0];
    const piece = shipment?.pieceResponses?.[0];
    const trackingNumber = piece?.trackingNumber ?? shipment?.masterTrackingNumber ?? null;
    if (!shipment || !trackingNumber) {
      throw new Error("FedEx shipment creation: no transactionShipments/trackingNumber found in response");
    }
    const document = piece?.packageDocuments?.[0];

    return {
      carrierOrderId: shipment.masterTrackingNumber ?? trackingNumber,
      trackingNumber,
      labelBase64: document?.encodedLabel ?? document?.url ?? null,
      raw: result,
    };
  }

  // voidShipment is deliberately NOT implemented for FedEx -- optional on
  // CarrierConnector precisely because no confirmed cancel-shipment
  // endpoint path was found this pass (this file's own class doc comment).

  /** POST /track/v1/trackingnumbers -- confirmed literal request shape,
   *  see this file's own class doc comment for exactly what's confirmed
   *  vs. inferred on the response side. */
  async trackShipment(trackingNumber: string): Promise<TrackingResult> {
    const result = await this.fedexRequest<FedExTrackResponse>("/track/v1/trackingnumbers", {
      method: "POST",
      body: JSON.stringify({ trackingInfo: [{ trackingNumberInfo: { trackingNumber } }] }),
    });

    if (result.errors && result.errors.length > 0) {
      throw new Error(`FedEx tracking lookup reported errors: ${JSON.stringify(result.errors)}`);
    }

    const trackResult = result.output?.completeTrackResults?.[0]?.trackResults?.[0];
    const events: TrackingEvent[] = (trackResult?.scanEvents ?? []).map((event) => ({
      eventCode: event.eventType ?? "",
      eventName: event.eventDescription ?? "",
      eventDateTime: event.date ?? "",
      locationName: event.scanLocation?.city ?? null,
    }));

    return {
      trackingNumber,
      statusCategory: trackResult?.latestStatusDetail?.code ?? "unknown",
      statusDescription: trackResult?.latestStatusDetail?.description ?? "",
      events,
      raw: result,
    };
  }

  /**
   * POST /rate/v1/rates/quotes -- a REAL live network call, unlike
   * RoyalMailConnector's/EvriConnector's own getRateEstimate() -- see this
   * file's class doc comment for why FedEx is a genuine, confirmed
   * exception to the "no carrier researched so far has a live rate-quote
   * endpoint" pattern §19.1/§19.2 both establish. Request body shape is
   * INFERRED (no literal request example found this pass, only the
   * response) -- modeled on the same requestedShipment wrapper the Ship
   * API itself confirms.
   */
  async getRateEstimate(request: { weightGrams: number; destinationCountryCode: string; shipDate: string }): Promise<RateEstimate[]> {
    const body = {
      accountNumber: { value: this.credentials.accountNumber },
      requestedShipment: {
        shipper: {},
        recipient: { address: { countryCode: request.destinationCountryCode } },
        pickupType: "USE_SCHEDULED_PICKUP",
        rateRequestType: ["LIST", "ACCOUNT"],
        requestedPackageLineItems: [{ weight: { units: "KG", value: request.weightGrams / 1000 } }],
      },
    };

    const result = await this.fedexRequest<FedExRateResponse>("/rate/v1/rates/quotes", {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (result.errors && result.errors.length > 0) {
      throw new Error(`FedEx rate quote reported errors: ${JSON.stringify(result.errors)}`);
    }

    return (result.output?.rateReplyDetails ?? []).map((detail) => {
      const rated = detail.ratedShipmentDetails?.[0];
      const amount = rated?.totalNetCharge?.amount ?? rated?.totalNetFedExCharge ?? 0;
      return {
        serviceCode: detail.serviceType ?? "unknown",
        serviceName: detail.serviceName ?? detail.serviceType ?? "FedEx service",
        estimatedCostGbp: amount.toFixed(2),
        surchargesApplied: true,
      };
    });
  }
}

/** Mirrors loadEvriCredentialsFromCarrierConnection's own shape
 *  (evri-connector.ts) -- most-recently-created active row, since
 *  carrier_connections' own UNIQUE(tenant_id, carrier) constraint
 *  (migration 0039) means there is at most one per tenant anyway. */
export async function loadFedExCredentialsFromCarrierConnection(pool: Pool, tenantId: string): Promise<FedExCredentials> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query<{
      encrypted_client_id: Buffer | null;
      encrypted_client_secret: Buffer | null;
      external_account_id: string | null;
    }>(
      `SELECT encrypted_client_id, encrypted_client_secret, external_account_id
         FROM carrier_connections
        WHERE carrier = 'fedex' AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 1`,
    );

    const row = result.rows[0];
    if (!row || !row.encrypted_client_id || !row.encrypted_client_secret || !row.external_account_id) {
      throw new Error(`No active 'fedex' carrier_connections row found for tenant ${tenantId}`);
    }

    const clientId = await decryptChannelSecret(client, row.encrypted_client_id);
    const clientSecret = await decryptChannelSecret(client, row.encrypted_client_secret);
    return { clientId, clientSecret, accountNumber: row.external_account_id };
  });
}

export async function createFedExConnectorFromCarrierConnection(pool: Pool, tenantId: string): Promise<FedExConnector> {
  const credentials = await loadFedExCredentialsFromCarrierConnection(pool, tenantId);
  return new FedExConnector(credentials);
}
