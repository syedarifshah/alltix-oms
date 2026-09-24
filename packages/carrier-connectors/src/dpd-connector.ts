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
  TrackingResult,
} from "./connector.js";

/**
 * DPD (UK) connector -- carrier #7 of the original 7 (CLAUDE.md §19's
 * Carrier Integration section), Arif's own explicit pick ("Yes, build DPD
 * now") once DHL (carrier #6, §19.6) was complete and merged. This closes
 * out the full original carrier lineup Arif requested at the start of this
 * feature.
 *
 * **A genuinely different research situation from every prior carrier in
 * this layer, worth stating precisely rather than lumping in with either
 * Royal Mail's or Evri's own framing**: DPD UK's own DIRECT API is REAL and
 * CONFIRMED TO EXIST -- unlike Evri (§19.2), which publishes no self-serve
 * API of any kind. Three independent real integration platforms (ShipEngine,
 * EasyPost, and Octolize's WooCommerce plugin docs) all independently
 * confirm the same direct API and the same three-value credential model
 * (username/password/account number) against the same host, `api.dpd.co.uk`
 * -- and AfterShip's own DPD UK developer guide names a real, literal login
 * endpoint (`https://api.dpd.co.uk/user/?action=login`) and confirms this
 * API is delivered "via GeoPost Enterprise Service Gateway (ESG)
 * application" (GeoPost being DPDgroup's parent brand). **But its technical
 * reference for request/response field shapes is NOT publicly readable by
 * any method tried this pass**: DPD UK's own account-onboarding flow
 * (confirmed via Octolize's own docs) requires signing a contract with DPD,
 * generating a test shipment through a real integration, and mailing DPD's
 * Smethwick office a physical printed label for a staff audit BEFORE
 * receiving permanent API access -- a closed, contract-gated technical
 * reference, not merely "hasn't been read yet." developer.dpd.co.uk itself
 * was never reached; DPD's own dpd.co.uk technology page confirms API
 * access details live behind "MyDPD" account login or an Account Manager
 * relationship, not a public docs site. This is closer to Parcelforce's own
 * closed-onboarding situation (§19.4) than to Evri's "no API exists at
 * all," except DPD UK, unlike Parcelforce, has no confirmed sandbox/UAT
 * environment either (AfterShip's own guide: "there is no testing API
 * credentials for DPD UK" -- production credentials only, with the
 * assurance that an unscanned label is never actually charged).
 *
 * **Given the direct API's technical reference is unreadable, this
 * connector integrates via the SAME Sapient/Intersoft CORE API gateway
 * already built for Evri (§19.2), not the direct DPD UK API** -- DPD UK is
 * one of the gateway's own confirmed supported carriers
 * (docs.intersoftsapient.net/reference, fetched live this pass, lists
 * `POST /v4/shipments/dpduk` alongside `dpdie`/`dpdnl`/`evri`/`royal
 * mail`/etc.), and Sapient's own docs DO render for an unauthenticated
 * fetch, unlike DPD UK's own contract-gated technical reference. This is
 * the SECOND carrier on this gateway (after Evri), which strengthens
 * rather than repeats that connector's own research: the auth flow, base
 * URL, and tracking/rate-endpoint limitations below are not just "confirmed
 * for Sapient in general" but confirmed IDENTICAL and reused across two
 * independently-built carrier integrations on the same account. Every
 * field/endpoint below is marked CONFIRMED or INFERRED, same disclosure
 * discipline every other connector in this layer already establishes:
 *
 * - **Base URL / Auth** -- CONFIRMED identical to EvriConnector's own:
 *   `https://api.intersoftsapient.net`, OAuth2 `clientCredentials` flow
 *   against `https://authentication.intersoftsapient.net/connect/token`
 *   (docs.intersoftsapient.net/reference/oath2's own literal security-scheme
 *   block, response fields `access_token`/`expires_in`/`token_type`
 *   CONFIRMED via docs.intersoftsapient.net/docs/bearer-token-generation-1).
 *   Exact request shape (HTTP Basic vs. body-encoded client_id/secret) is
 *   INFERRED the same way EvriConnector's own is -- modeled on this exact
 *   codebase's confirmed WalmartConnector.authenticate() convention, not a
 *   fresh guess. One real, independent Sapient account/credential pair
 *   covers both this connector and EvriConnector -- the credential type is
 *   the same shape, but each carrier's own `carrier_connections` row is
 *   still separate (a tenant could have Evri credentials without DPD ones,
 *   or vice versa), same "one connection per (tenant, carrier)" shape every
 *   other carrier in this layer already has.
 * - **`POST /v4/shipments/dpduk`** -- CONFIRMED path
 *   (docs.intersoftsapient.net/reference/post_v4-shipments-dpduk, fetched
 *   live this pass) and CONFIRMED top-level request shape -- the SAME
 *   object family EvriConnector's own request already uses:
 *   `ShipmentInformation` (service code, content type, goods description,
 *   total weight/value), `Shipper` (address/contact/VAT/EORI), `Destination`
 *   (receiver/contact), `Packages` (array, each optionally carrying an
 *   `Items` array for dutiable shipments, max 15 distinct items), plus
 *   `CarrierSpecifics` (confirmed to exist specifically for DPD UK
 *   "enhancements and special handling instructions," a different content
 *   set from Evri's own `CarrierSpecifics` even though the object NAME is
 *   shared across the gateway), `Customs`, and `ReturnToSender`. **INFERRED,
 *   same as EvriConnector's own least-confirmed piece**: the exact nested
 *   field names inside each object -- no literal rendered JSON example was
 *   returned by any fetch this pass, only the schema's own object/field-
 *   group descriptions, and `CarrierSpecifics` itself is left entirely
 *   empty here (not guessed at all) since nothing about its DPD-UK-specific
 *   contents was confirmed beyond the word "enhancements." Uses the SAME
 *   confirmed `Process` action EvriConnector's own createShipment() uses
 *   (docs.intersoftsapient.net/docs/shipment-creation-and-manifesting
 *   confirms this action set applies gateway-wide, not per-carrier) so this
 *   stays one request/response round trip, matching this interface's own
 *   contract.
 * - **INFERRED response shape** -- read defensively, same handful of
 *   plausible candidate field names EvriConnector's own response parsing
 *   already tries, since no literal JSON example was found for this
 *   endpoint either.
 * - **`voidShipment` deliberately NOT implemented** -- same reasoning
 *   EvriConnector's own carries (§19.2): a "Cancel shipment"/"Recall
 *   shipment" concept is confirmed to exist in Sapient's own docs
 *   (docs.intersoftsapient.net/docs/view-cancelled-shipments,
 *   .../docs/recall-shipment, both fetched live this pass and confirmed to
 *   be gateway-wide features, not DPD-specific), but neither page renders a
 *   literal REST endpoint path -- both explicitly defer to "the API
 *   Reference" or "contact Intersoft Customer Operations" for the actual
 *   method/path. Left unimplemented, optional on `CarrierConnector`
 *   precisely for this case.
 * - **No live rate-shopping/quote endpoint** -- CONFIRMED absent, same
 *   gateway-wide gap EvriConnector's own research already found (no
 *   endpoint is DPD-specific here; this is a Sapient-wide limitation).
 *   **No confirmed DPD UK surcharge or base-price data exists either** --
 *   same "return an empty list rather than fabricate a number" reasoning
 *   EvriConnector.getRateEstimate() already documents, for the identical
 *   underlying reason.
 * - **`POST /v4/trackings`** -- CONFIRMED path, reused as-is from
 *   EvriConnector's own implementation (this is a gateway-wide endpoint, not
 *   carrier-specific) -- carrying the SAME confirmed architectural mismatch
 *   EvriConnector's own class doc comment already documents in full
 *   (designed for registering tracking numbers from OTHER systems, not
 *   shipments created within the same Sapient account; real tracking
 *   delivery is webhook-based). Not re-derived here -- see EvriConnector's
 *   own doc comment for the complete reasoning, which applies identically.
 *
 * **UNVERIFIED IN ITS ENTIRETY**, same status Evri's own connector carries
 * (§19.2) and for the same reason: no real Sapient client_id/client_secret
 * exists anywhere in this codebase or Arif's account yet, and this is a
 * well-researched first draft against a real third-party gateway's own
 * official (if incompletely-rendered) docs, not a proven implementation.
 */

const SAPIENT_BASE_URL = "https://api.intersoftsapient.net";
const SAPIENT_TOKEN_URL = "https://authentication.intersoftsapient.net/connect/token";
const TOKEN_REFRESH_SKEW_MS = 60_000;

export interface DpdCredentials {
  /** Sapient's own OAuth2 client_credentials pair -- stored in
   *  carrier_connections.encrypted_client_id/encrypted_client_secret, the
   *  same columns EvriConnector's own credentials already use (this is a
   *  separate `carrier_connections` row from Evri's, even though the
   *  underlying gateway account may be the same one -- see this file's
   *  class doc comment). */
  clientId: string;
  clientSecret: string;
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

interface SapientTokenResponse {
  access_token: string;
  expires_in: number;
  token_type?: string;
}

/** INFERRED response shape -- see this file's class doc comment for why.
 *  Every field is read defensively (several plausible candidate names
 *  tried, in order) rather than assumed to be exactly one spelling. Mirrors
 *  SapientCreateShipmentResponse in evri-connector.ts -- not imported from
 *  there since it's a gateway-wide, not Evri-specific, response shape, and
 *  duplicating the small interface keeps each connector file independently
 *  readable, same "one file per carrier, no shared internal-response types"
 *  precedent every other connector pair in this layer already follows. */
interface SapientCreateShipmentResponse {
  ShipmentId?: string | number;
  ShipmentNumber?: string | number;
  Id?: string | number;
  TrackingNumber?: string;
  CarrierTrackingNumber?: string;
  Label?: string;
  LabelData?: string;
  LabelBase64?: string;
  Errors?: unknown[];
  [key: string]: unknown;
}

export class DpdConnector implements CarrierConnector {
  private cachedToken: CachedToken | null = null;

  constructor(private readonly credentials: DpdCredentials) {}

  /** POST to Sapient's own confirmed OAuth2 token URL -- identical to
   *  EvriConnector.authenticate()'s own implementation (same gateway, same
   *  confirmed auth flow). See this file's class doc comment for the
   *  CONFIRMED/INFERRED breakdown. */
  async authenticate(_tenantCredentials?: CarrierTenantCredentials): Promise<CarrierAuthToken> {
    const cached = this.cachedToken;
    if (cached && cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS > Date.now()) {
      return { accessToken: cached.accessToken, expiresAt: new Date(cached.expiresAtMs).toISOString() };
    }

    const basicAuth = Buffer.from(`${this.credentials.clientId}:${this.credentials.clientSecret}`).toString("base64");
    const response = await fetchWithBackoff(SAPIENT_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });

    if (!response.ok) {
      // Deliberately not including the response body, same "no upside to
      // risking an accidental secret echo in an error path" reasoning
      // EvriConnector.authenticate() already establishes.
      throw new Error(`Sapient (DPD) token exchange failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as SapientTokenResponse;
    const expiresAtMs = Date.now() + data.expires_in * 1000;
    this.cachedToken = { accessToken: data.access_token, expiresAtMs };
    return { accessToken: data.access_token, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  private async sapientRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.authenticate();
    const response = await fetchWithBackoff(`${SAPIENT_BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...init.headers,
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Sapient (DPD) API error (${response.status}): ${body}`);
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Proves a Sapient client_id/client_secret pair actually works before a
   *  connect route persists it -- same "verify before persist" discipline
   *  every connector in this layer follows. Reuses the token exchange
   *  itself as the verification call, same reasoning
   *  EvriConnector.verifyConnection() already gives (no confirmed cheap
   *  authenticated read-only endpoint was found for Sapient). */
  async verifyConnection(): Promise<void> {
    this.cachedToken = null;
    await this.authenticate();
  }

  /**
   * POST /v4/shipments/dpduk, requesting the `Process` action so the label
   * comes back synchronously in this same response -- see this file's class
   * doc comment for the full CONFIRMED/INFERRED breakdown. Builds a
   * single-shipment, single-package request from the shared
   * {@link CreateShipmentRequest} shape, the same one every other connector
   * in this layer consumes.
   */
  async createShipment(request: CreateShipmentRequest): Promise<CreateShipmentResult> {
    const body = {
      ShipmentInformation: {
        // INFERRED field names -- see class doc comment. "Process" is
        // CONFIRMED as the action that returns a label synchronously,
        // gateway-wide (not DPD-specific).
        Action: "Process",
        ServiceCode: request.serviceCode ?? null,
        ContentType: "General",
        GoodsDescription: request.packages.flatMap((pkg) => pkg.items.map((item) => item.name)).join(", ") || "Goods",
        TotalWeight: request.packages.reduce((sum, pkg) => sum + pkg.weightGrams, 0),
        TotalValue: request.subtotalGbp,
        Reference: request.orderReference,
      },
      Shipper: {
        // Same "left as an explicit placeholder object rather than
        // omitted" reasoning EvriConnector.createShipment() already
        // documents -- this v1 pass has no separate tenant "ship-from
        // address" concept yet.
      },
      Destination: {
        Name: request.recipient.name,
        AddressLine1: request.recipient.addressLine1,
        AddressLine2: request.recipient.addressLine2 ?? null,
        City: request.recipient.city,
        PostalCode: request.recipient.postalCode,
        CountryCode: request.recipient.countryCode,
        Phone: request.recipient.phone ?? null,
        Email: request.recipient.email ?? null,
      },
      Packages: request.packages.map((pkg) => ({
        Weight: pkg.weightGrams,
        Items: pkg.items.map((item) => ({
          SKU: item.sku ?? null,
          Description: item.name,
          Quantity: item.quantity,
          Weight: item.unitWeightGrams ?? null,
        })),
      })),
      // Confirmed to exist and to carry DPD-UK-specific "enhancements and
      // special handling instructions" (docs.intersoftsapient.net/reference/
      // post_v4-shipments-dpduk), but its own contents were never confirmed
      // beyond that description -- left empty rather than guessed, same
      // "don't submit an unconfirmed shape when a safe empty default
      // exists" discipline this codebase applies elsewhere (e.g.
      // TemuConnector never guessing shippinginfo fields it doesn't call).
      CarrierSpecifics: {},
    };

    const result = await this.sapientRequest<SapientCreateShipmentResponse>("/v4/shipments/dpduk", {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (result.Errors && result.Errors.length > 0) {
      throw new Error(`Sapient (DPD) shipment creation reported errors: ${JSON.stringify(result.Errors)}`);
    }

    const carrierOrderId = String(result.ShipmentId ?? result.ShipmentNumber ?? result.Id ?? "");
    if (!carrierOrderId) {
      throw new Error("Sapient (DPD) shipment creation: no shipment id found in response");
    }

    return {
      carrierOrderId,
      trackingNumber: result.TrackingNumber ?? result.CarrierTrackingNumber ?? null,
      labelBase64: result.Label ?? result.LabelData ?? result.LabelBase64 ?? null,
      raw: result,
    };
  }

  // voidShipment is deliberately NOT implemented -- same reasoning
  // EvriConnector's own carries: a cancel/recall concept is confirmed to
  // exist on this gateway, but no literal endpoint path was found for it
  // this pass -- see this file's class doc comment.

  /**
   * POST /v4/trackings -- a gateway-wide endpoint, reused as-is from
   * EvriConnector's own implementation. Carries the SAME confirmed
   * architectural mismatch documented in full in this file's own class doc
   * comment (and, at greater length, in EvriConnector's own) -- treat this
   * as the least-trustworthy method on this connector too.
   */
  async trackShipment(trackingNumber: string): Promise<TrackingResult> {
    const result = await this.sapientRequest<{
      TrackingNumbers?: Array<{ TrackingNumber?: string; ShipmentId?: string | number; Status?: string }>;
      [key: string]: unknown;
    }>("/v4/trackings", {
      method: "POST",
      body: JSON.stringify({ TrackingNumbers: [trackingNumber] }),
    });

    const entry = result.TrackingNumbers?.find((t) => t.TrackingNumber === trackingNumber) ?? result.TrackingNumbers?.[0];

    return {
      trackingNumber,
      statusCategory: entry?.Status ?? "unknown",
      statusDescription: entry?.Status ?? "",
      events: [],
      raw: result,
    };
  }

  /** NOT a live call, same reasoning as EvriConnector.getRateEstimate() --
   *  no live rate-shopping endpoint was found for Sapient (gateway-wide,
   *  not DPD-specific), and no confirmed DPD UK surcharge or base-price
   *  data exists to estimate from either -- see this file's class doc
   *  comment. */
  async getRateEstimate(_request: { weightGrams: number; destinationCountryCode: string; shipDate: string }): Promise<RateEstimate[]> {
    return [];
  }
}

/** Mirrors loadEvriCredentialsFromCarrierConnection's own shape
 *  (evri-connector.ts) -- most-recently-created active row, since
 *  carrier_connections' own UNIQUE(tenant_id, carrier) constraint
 *  (migration 0039) means there is at most one per tenant anyway. */
export async function loadDpdCredentialsFromCarrierConnection(pool: Pool, tenantId: string): Promise<DpdCredentials> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query<{
      encrypted_client_id: Buffer | null;
      encrypted_client_secret: Buffer | null;
    }>(
      `SELECT encrypted_client_id, encrypted_client_secret
         FROM carrier_connections
        WHERE carrier = 'dpd' AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 1`,
    );

    const row = result.rows[0];
    if (!row || !row.encrypted_client_id || !row.encrypted_client_secret) {
      throw new Error(`No active 'dpd' carrier_connections row found for tenant ${tenantId}`);
    }

    const clientId = await decryptChannelSecret(client, row.encrypted_client_id);
    const clientSecret = await decryptChannelSecret(client, row.encrypted_client_secret);
    return { clientId, clientSecret };
  });
}

export async function createDpdConnectorFromCarrierConnection(pool: Pool, tenantId: string): Promise<DpdConnector> {
  const credentials = await loadDpdCredentialsFromCarrierConnection(pool, tenantId);
  return new DpdConnector(credentials);
}
