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
 * Evri (formerly Hermes) connector -- carrier #2 (CLAUDE.md §19's Carrier
 * Integration section), Arif's own explicit pick when asked which carrier to
 * build next, once Royal Mail (carrier #1, §19.1) was complete and merged.
 *
 * **The single biggest difference from RoyalMailConnector, stated up front:
 * Evri itself publishes NO self-serve public API of any kind.** Confirmed
 * this pass (paul-walsh.co.uk and multiple other independent sources, none
 * of which found a developer.evri.com or equivalent) -- direct Evri API
 * integration requires an Account Manager relationship with a real minimum-
 * volume threshold, no published field-level schemas anywhere. This is a
 * structurally different research problem from Royal Mail's (readable
 * official docs, just requiring a logged-in session for some pages) --
 * closer to Temu's/TikTok's own "no readable official docs at all" problem
 * (CLAUDE.md §4.7/§4.8), solved the same way those two were: by building
 * against a credible THIRD-PARTY source instead of a nonexistent direct API,
 * same "an installed package's/a real integration writeup's source is more
 * authoritative than nothing" precedent.
 *
 * **This connector integrates via the SAPIENT / Intersoft CORE API -- a
 * real, credible, widely-used multi-carrier shipping gateway (confirmed
 * carrier list includes Evri, Royal Mail, FedEx, UPS, DHL, DPD, InPost, An
 * Post, and others, fetched live from docs.intersoftsapient.net/docs/api)
 * -- NOT a direct Evri API, because none exists publicly.** Every field/
 * endpoint below is marked CONFIRMED (fetched live from
 * docs.intersoftsapient.net -- Sapient's own official developer hub, which
 * DOES render for an unauthenticated fetch, unlike Evri's/Temu's/TikTok's
 * own JS-SPA doc sites) or INFERRED (this codebase's own best-effort
 * extrapolation), same disclosure discipline RoyalMailConnector's/
 * TemuConnector's/TikTokConnector's own class doc comments already
 * established (CLAUDE.md §4.7/§4.8/§19.1):
 *
 * - **Base URL** -- CONFIRMED: `https://api.intersoftsapient.net`, seen
 *   identically on both the `/v4/shipments/evri` and `/v4/trackings`
 *   reference pages.
 * - **Auth** -- CONFIRMED as OAuth2, `clientCredentials` flow, token URL
 *   `https://authentication.intersoftsapient.net/connect/token`
 *   (docs.intersoftsapient.net/reference/oath2's own literal security-scheme
 *   block: "Flow type: clientCredentials Token URL:
 *   https://authentication.intersoftsapient.net/connect/token"). **INFERRED,
 *   not confirmed by a literal example anywhere found this pass**: the exact
 *   request shape (HTTP Basic `client_id:client_secret` vs. both in the
 *   body) and the response field names. Modeled here on this exact same
 *   codebase's own confirmed WalmartConnector.authenticate() convention
 *   (HTTP Basic auth header, `grant_type=client_credentials` as a
 *   form-urlencoded body, `Content-Type: application/x-www-form-urlencoded`)
 *   -- the standard OAuth2 client_credentials shape and the closest
 *   confirmed sibling this codebase has, not a guess made from nothing.
 *   `access_token`/`expires_in`/`token_type` as the response field names ARE
 *   separately CONFIRMED (docs.intersoftsapient.net/docs/
 *   bearer-token-generation-1 names exactly these three).
 * - **`POST /v4/shipments/evri`** (create a shipment) -- CONFIRMED path
 *   (docs.intersoftsapient.net/reference/post_v4-shipments-evri) and
 *   CONFIRMED top-level request shape: a `ShipmentInformation` object
 *   (service code, content type, goods description, total weight/value),
 *   a `Shipper` object (address/contact/VAT/EORI), a `Destination` object
 *   (receiver/contact details), a `Packages` array (1-99 packages, each
 *   optionally carrying an `Items` array -- SKU/quantity/description/
 *   weight/HS code/country of origin, required only for dutiable
 *   shipments, max 15 distinct items/shipment), and three optional objects
 *   (`CarrierSpecifics`, `Customs`, `ReturnToSender`). **INFERRED**: the
 *   exact nested field names inside each of those objects (e.g. the literal
 *   spelling of a weight-in-grams field, an address-line field, or the
 *   service-code field) -- no literal rendered JSON example was returned by
 *   any fetch this pass, only the schema's own object/field-group
 *   descriptions. Modeled on Royal Mail's own confirmed field-naming
 *   conventions (this codebase's `CreateShipmentRequest`/`ShipmentPackage`/
 *   `ShipmentPackageItem` shared types, §19's own interface) for lack of a
 *   better source -- **the single least-confirmed request body in this
 *   entire connector**, same "flag it, don't hide it" precedent Temu's own
 *   `skuStockTargetList` and TikTok's own `pushInventory`/`confirmShipment`
 *   bodies already set (CLAUDE.md §4.7/§4.8).
 *   - **CONFIRMED, and directly load-bearing for this method's own design**:
 *     a separate guide page (docs.intersoftsapient.net/docs/
 *     shipment-creation-and-manifesting) describes THREE shipment actions --
 *     `Create` (no label, a separate Print Shipment call is needed),
 *     `Allocate` (returns a carrier tracking number but still needs a
 *     separate Print Shipment call for the label), and `Process`
 *     ("Finalises the shipment creation... A label is returned in the
 *     Create Shipment response" -- synchronous, no second call). This
 *     connector always requests `Process` (INFERRED exact field name/value
 *     for how that action is selected in the request body -- the CONCEPT of
 *     three actions and Process's own synchronous-label behavior is
 *     confirmed, the literal request field spelling is not), same
 *     "prefer the confirmed synchronous shape over an unconfirmed
 *     multi-call one" reasoning behind Amazon's Listings-Items-API choice
 *     (CLAUDE.md §4.1) and Temu's `bg.order.fulfillment.info.sync` choice
 *     (§4.7) -- so `createShipment()` here stays a single request/response
 *     round trip, matching this interface's own contract, rather than
 *     silently becoming a two-call sequence a caller wouldn't expect.
 *   - **INFERRED response shape**: the reference page's own rendered
 *     examples are named "Create status" / "Allocate status" / "Process
 *     status with PDF label format" / "Process status with PNG label
 *     format" but no literal JSON body was returned by any fetch this pass
 *     -- the response is read here defensively (a handful of plausible
 *     field-name candidates tried in order) rather than assuming one exact
 *     shape, and the raw response is always preserved on
 *     {@link CreateShipmentResult.raw} so a real sandbox run can reveal the
 *     actual shape without re-deriving it from scratch.
 * - **No live rate-shopping/quote endpoint was found for Sapient either**,
 *   same genuine carrier-API-level gap RoyalMailConnector's own research
 *   confirmed for Royal Mail (§19.1). The one adjacent feature found
 *   (docs.intersoftsapient.net/docs/api's own mention of "Hurricane
 *   Commerce... Quoted landed cost") is a customs DUTY/TAX estimate, not a
 *   shipping-cost quote -- a different thing, not a rate-shopping substitute.
 *   **Unlike Royal Mail, this codebase has NO confirmed Evri-specific
 *   surcharge or base-price data** (§19.1's own `carrier_surcharges` seed
 *   rows are Royal Mail only, confirmed live from royalmail.com/business/
 *   mail/surcharges -- no equivalent Evri source was researched or found
 *   this pass) -- see {@link EvriConnector.getRateEstimate}'s own doc
 *   comment for why this deliberately returns an empty list rather than
 *   fabricating a number, unlike Royal Mail's own illustrative-table
 *   fallback.
 * - **`POST /v4/trackings`** -- CONFIRMED path
 *   (docs.intersoftsapient.net/reference/post_v4-trackings), but a genuine,
 *   confirmed ARCHITECTURAL MISMATCH with this interface's own
 *   `trackShipment(trackingNumber)` contract, worth being explicit about
 *   rather than glossed over: Sapient's own docs describe this endpoint as
 *   "designed for registering tracking numbers from OTHER systems or
 *   different Intersoft accounts" and state it "should NOT be used for...
 *   shipments created within your own Intersoft account" -- and separately
 *   (docs.intersoftsapient.net/docs/tracking-events-and-milestones)
 *   CONFIRM that Sapient's actual intended tracking-status delivery
 *   mechanism is a configured WEBHOOK, not a polling GET-by-tracking-number
 *   endpoint -- no such GET endpoint was found anywhere in this research
 *   pass (searched directly, see this repo's own research log). This method
 *   still calls `POST /v4/trackings` rather than throwing outright, since
 *   it is the only request/response (non-webhook) endpoint this pass found
 *   that returns tracking data at all, and `CarrierConnector.trackShipment`
 *   is not an optional interface method -- but this is a genuine,
 *   UNRESOLVED risk, not a confirmed-correct usage: Sapient's own docs
 *   suggest this may be a chargeable, discouraged call for a shipment this
 *   same Sapient account already created. A real integration pass should
 *   replace this with real webhook receiving (a new inbound route, mirroring
 *   Shopify's own `/api/webhooks/shopify` pattern, CLAUDE.md §4.5) before
 *   relying on this method against real shipments.
 *
 * **UNVERIFIED IN ITS ENTIRETY**, same status Royal Mail carried before its
 * own first live pass (§19.1) and, more so than Royal Mail, no sandbox
 * request/response has ever round-tripped against Sapient's own API at all
 * -- this is a well-researched first draft against a real third-party
 * gateway's own official (if incompletely-rendered) docs, not a proven
 * implementation. No real Sapient client_id/client_secret exists anywhere in
 * this codebase or Arif's account yet.
 */

const SAPIENT_BASE_URL = "https://api.intersoftsapient.net";
const SAPIENT_TOKEN_URL = "https://authentication.intersoftsapient.net/connect/token";
const TOKEN_REFRESH_SKEW_MS = 60_000;

export interface EvriCredentials {
  /** Sapient's own OAuth2 client_credentials pair -- stored in
   *  carrier_connections.encrypted_client_id/encrypted_client_secret, the
   *  same columns Royal Mail's own tracking-API-credential half already
   *  established a precedent for reusing (§19.1). */
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
 *  tried, in order) rather than assumed to be exactly one spelling. */
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

export class EvriConnector implements CarrierConnector {
  private cachedToken: CachedToken | null = null;

  constructor(private readonly credentials: EvriCredentials) {}

  /** POST to Sapient's own confirmed OAuth2 token URL -- request shape
   *  INFERRED from this exact codebase's own WalmartConnector.authenticate()
   *  convention (HTTP Basic client_id:client_secret,
   *  grant_type=client_credentials as form-urlencoded body), response field
   *  names (access_token/expires_in/token_type) CONFIRMED -- see this file's
   *  class doc comment. Caches in memory, refreshing near expiry, same
   *  pattern as every other client_credentials connector in this codebase
   *  (Walmart, and Amazon's own LWA cache). */
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
      // Deliberately not including the response body -- same "no upside to
      // risking an accidental secret echo in an error path" reasoning
      // WalmartConnector.authenticate()/AmazonConnector.authenticate()
      // already establish.
      throw new Error(`Sapient (Evri) token exchange failed: ${response.status} ${response.statusText}`);
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
      throw new Error(`Sapient (Evri) API error (${response.status}): ${body}`);
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Proves a Sapient client_id/client_secret pair actually works before a
   *  connect route persists it -- same "verify before persist" discipline
   *  every connector in this codebase already follows
   *  (RoyalMailConnector.verifyConnection()'s own doc comment). Reuses the
   *  token exchange itself as the verification call, since no confirmed
   *  cheap authenticated read-only endpoint (Royal Mail's own GET /carriers
   *  equivalent) was found for Sapient this pass -- a successful token
   *  exchange at least proves the credential pair is real and accepted,
   *  even if it doesn't prove a specific carrier account is fully
   *  onboarded. */
  async verifyConnection(): Promise<void> {
    this.cachedToken = null;
    await this.authenticate();
  }

  /**
   * POST /v4/shipments/evri, requesting the `Process` action so the label
   * comes back synchronously in this same response -- see this file's class
   * doc comment for the full CONFIRMED/INFERRED breakdown of both the
   * request and response shapes. Builds a single-shipment, single-package
   * request from the shared {@link CreateShipmentRequest} shape (the same
   * one RoyalMailConnector.createShipment() consumes) -- this connector is
   * the second real test of that shared interface/type set, per its own
   * "don't trust this interface until carrier #2 is built against it"
   * caution (connector.ts's own header comment).
   */
  async createShipment(request: CreateShipmentRequest): Promise<CreateShipmentResult> {
    const body = {
      ShipmentInformation: {
        // INFERRED field names -- see class doc comment. "Process" is
        // CONFIRMED as the action that returns a label synchronously.
        Action: "Process",
        ServiceCode: request.serviceCode ?? null,
        ContentType: "General",
        GoodsDescription: request.packages.flatMap((pkg) => pkg.items.map((item) => item.name)).join(", ") || "Goods",
        TotalWeight: request.packages.reduce((sum, pkg) => sum + pkg.weightGrams, 0),
        TotalValue: request.subtotalGbp,
        Reference: request.orderReference,
      },
      Shipper: {
        // Populated by the caller via the tenant's own carrier connection
        // settings in a real integration -- this v1 pass has no separate
        // tenant "ship-from address" concept yet (same gap RoyalMailConnector
        // doesn't have either, since Royal Mail's own Click & Drop account
        // already carries a registered ship-from address server-side).
        // Left as an explicit placeholder object rather than omitted, so a
        // real sandbox run surfaces exactly what Sapient actually requires
        // here instead of this connector guessing a shape with nothing to
        // verify it against.
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
    };

    const result = await this.sapientRequest<SapientCreateShipmentResponse>("/v4/shipments/evri", {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (result.Errors && result.Errors.length > 0) {
      throw new Error(`Sapient (Evri) shipment creation reported errors: ${JSON.stringify(result.Errors)}`);
    }

    const carrierOrderId = String(result.ShipmentId ?? result.ShipmentNumber ?? result.Id ?? "");
    if (!carrierOrderId) {
      throw new Error("Sapient (Evri) shipment creation: no shipment id found in response");
    }

    return {
      carrierOrderId,
      trackingNumber: result.TrackingNumber ?? result.CarrierTrackingNumber ?? null,
      labelBase64: result.Label ?? result.LabelData ?? result.LabelBase64 ?? null,
      raw: result,
    };
  }

  // voidShipment is deliberately NOT implemented for Evri -- optional on
  // CarrierConnector precisely for a carrier whose cancel/recall shape isn't
  // confirmed (connector.ts's own doc comment). A "Recall shipment" concept
  // does exist in Sapient's own docs
  // (docs.intersoftsapient.net/docs/recall-shipment), but no literal
  // endpoint path was found for it this pass -- a real integration pass
  // should confirm that endpoint against a sandbox account before adding
  // this method, rather than this connector guessing a DELETE/PUT shape
  // with nothing to verify it against.

  /**
   * POST /v4/trackings -- see this file's own class doc comment for the
   * real, confirmed architectural mismatch this represents (Sapient's own
   * docs say this endpoint isn't meant for a shipment created within the
   * same account, and that real tracking delivery is webhook-based, not
   * polled). Implemented anyway, since `trackShipment` isn't optional on
   * this interface and this is the only request/response endpoint found
   * that returns tracking data -- treat this as the least-trustworthy
   * method on this connector, not a confirmed-correct integration.
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

  /** NOT a live call, same reasoning as RoyalMailConnector.getRateEstimate()
   *  -- no live rate-shopping endpoint was found for Sapient either (see
   *  this file's class doc comment). **Deliberately returns an empty list
   *  rather than Royal Mail's own illustrative-price-table fallback**: this
   *  codebase has confirmed, real, dated Royal Mail surcharge figures
   *  (carrier_surcharges, migration 0039, fetched live from
   *  royalmail.com/business/mail/surcharges) to combine with an
   *  explicitly-flagged illustrative base rate -- no equivalent Evri
   *  surcharge or base-price source was found or researched this pass.
   *  Fabricating a number with no confirmed source at all, even a flagged
   *  "illustrative" one, would cross from "best-effort estimate" into
   *  "made up" -- a distinction this codebase's own honesty discipline
   *  (CONFIRMED/INFERRED, never silently presented as fact) treats as real.
   *  A future pass adding real Evri/Sapient surcharge data to
   *  carrier_surcharges would replace this with a real lookup, mirroring
   *  estimateRoyalMailRates(). */
  async getRateEstimate(_request: { weightGrams: number; destinationCountryCode: string; shipDate: string }): Promise<RateEstimate[]> {
    return [];
  }
}

/** Mirrors loadRoyalMailCredentialsFromCarrierConnection's own shape
 *  (royal-mail-connector.ts) -- most-recently-created active row, since
 *  carrier_connections' own UNIQUE(tenant_id, carrier) constraint
 *  (migration 0039) means there is at most one per tenant anyway. */
export async function loadEvriCredentialsFromCarrierConnection(pool: Pool, tenantId: string): Promise<EvriCredentials> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query<{
      encrypted_client_id: Buffer | null;
      encrypted_client_secret: Buffer | null;
    }>(
      `SELECT encrypted_client_id, encrypted_client_secret
         FROM carrier_connections
        WHERE carrier = 'evri' AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 1`,
    );

    const row = result.rows[0];
    if (!row || !row.encrypted_client_id || !row.encrypted_client_secret) {
      throw new Error(`No active 'evri' carrier_connections row found for tenant ${tenantId}`);
    }

    const clientId = await decryptChannelSecret(client, row.encrypted_client_id);
    const clientSecret = await decryptChannelSecret(client, row.encrypted_client_secret);
    return { clientId, clientSecret };
  });
}

export async function createEvriConnectorFromCarrierConnection(pool: Pool, tenantId: string): Promise<EvriConnector> {
  const credentials = await loadEvriCredentialsFromCarrierConnection(pool, tenantId);
  return new EvriConnector(credentials);
}
