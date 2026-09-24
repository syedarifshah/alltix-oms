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
 * Parcelforce (Worldwide) connector -- carrier #4 (CLAUDE.md §19's Carrier
 * Integration section). Once FedEx (carrier #3, §19.3) was complete and
 * merged, Arif was asked (AskUserQuestion) which of the remaining 4 to
 * build next -- UPS recommended, on the same "which of these has a fully
 * public, self-serve REST sandbox" reasoning that made FedEx the
 * recommendation last round -- and picked **Parcelforce** instead,
 * overriding the recommendation, the same way Evri's own pick overrode
 * FedEx's recommendation one round earlier (§19.2).
 *
 * **A structurally different research problem from all three carriers
 * built so far, in TWO ways at once, not just one**: (1) Parcelforce's own
 * shipping API is a **SOAP/XML web service, not REST/JSON** -- the first
 * non-REST protocol in this codebase's entire carrier/channel layer, and
 * (2) it is a genuinely **closed, contract-gated API**, the same category
 * as Evri (§19.2), not the openly-documented category Royal Mail (§19.1)
 * and FedEx (§19.3) fall into. Every field/endpoint below is marked
 * CONFIRMED or INFERRED, same disclosure discipline every other connector
 * in this codebase's class doc comment already establishes:
 *
 * - **The API is known as "expressLink"** -- CONFIRMED across many
 *   independent sources (developer.royalmail.net/taxonomy/term/22, titled
 *   "PFW Shipping API Live (SOAP)" -- Parcelforce Worldwide is part of
 *   Royal Mail Group, and its own shipping API is listed on the SAME
 *   developer.royalmail.net portal Royal Mail's own Tracking API v2 uses,
 *   §19.1 -- plus codelessplatforms.com's own integration-tool docs,
 *   ShipEngine's own carrier guide, and a real Google Groups thread from a
 *   developer who actually built against it). Confirmed operations
 *   (`ShipServiceSoapBinding`, from a real WSDL-derived code-generation
 *   tool, tools.chilkat.io -- a legitimate, widely-used SOAP tooling site,
 *   not a scraped or fabricated source): `createShipment`, `printLabel`,
 *   `printDocument`, `CancelShipment`, `Find`, `createManifest`,
 *   `createPrint`, `printManifest`, `CCReserve`, `returnShipment` -- ten
 *   operations, confirmed by name, on one binding.
 * - **CONFIRMED, and genuinely different from every carrier built so far:
 *   NOT a self-serve API.** A real developer's own words, found directly in
 *   the Google Groups thread above: "There is no way for someone to just
 *   sign up for them" -- credentials are issued only after contacting
 *   Parcelforce's own Customer Solutions Team directly (confirmed
 *   separately via zenstores.com's own account-setup guide: email
 *   customer.solutions@parcelforce.co.uk or call). This is Evri's own
 *   closed-access category (§19.2), not Royal Mail's/FedEx's self-serve
 *   one. **A real UAT/test environment DOES exist once an account is
 *   granted** (zenstores.com: "get your test labels generated and sent
 *   off") -- genuinely better than Evri in this one respect, since Evri's
 *   own research found no test environment mentioned anywhere.
 * - **Namespace and endpoint** -- CONFIRMED namespace,
 *   `http://www.parcelforce.net/ws/ship/v14`, and a CONFIRMED SOAP
 *   endpoint URL, `https://expresslink-uat1.neopost-id.com/ws/`, both from
 *   the Chilkat WSDL-derived code-generation tool. **A SECOND, independent
 *   confirmed test endpoint was also found**, directly in the real
 *   developer's own Google Groups post: `https://expresslink-test.parcelforce.net/ws/?wsdl`
 *   -- Parcelforce's own domain, not a third party's, so this connector
 *   targets that one as the more authoritative of the two (the Chilkat
 *   tool's WSDL may be an older or white-labeled capture; `neopost-id.com`
 *   is a mailing-solutions vendor, not Parcelforce itself). **UNCONFIRMED
 *   by anything found this pass: the real PRODUCTION endpoint URL** --
 *   every source found this pass names a test/UAT host only; a real
 *   integration pass should confirm the production host directly from
 *   Parcelforce once a real account exists (per zenstores.com, real
 *   documentation is only sent by Parcelforce after signup) rather than
 *   guessing a `-test`-stripped URL with nothing to verify it against.
 * - **Auth -- CONFIRMED, cross-confirmed by two independent sources**:
 *   credentials travel INSIDE the SOAP request body's own `Authentication`
 *   node (`UserName`/`Password`), on every single request -- not an HTTP
 *   header, not a separate token exchange. codelessplatforms.com's own
 *   docs confirm this in prose ("credentials must be included with each
 *   request made to the service... through the Authentication node of the
 *   XML request schema"), and the Chilkat WSDL-derived tool independently
 *   renders the identical structure for the one operation it could fully
 *   render (`returnShipment`: `Authentication{UserName,Password}` followed
 *   by `ShipmentNumber`, `CollectionTime{From,To}`) -- the only FULLY
 *   confirmed request shape found for any operation this pass, used here
 *   as the model for how every other operation's own Authentication node
 *   is built. **CONFIRMED separately, via ShipEngine's own real,
 *   documented required connection fields** (a credible real courier
 *   aggregator, both its "Legacy" and current integration guides list the
 *   identical field set): a **Contract Number** is ALSO required
 *   (independent of username/password), plus an optional **Department ID**
 *   (ShipEngine's own docs: "typically '1'" -- defaulted to `"1"` here
 *   rather than collected as a separate credential field, a deliberate v1
 *   narrowing, same "hardcode a sensible default rather than add a fourth
 *   credential field for a mostly-single-department seller" reasoning
 *   TikTok's own `TIKTOK_DEFAULT_WAREHOUSE_ID` narrowing already sets,
 *   CLAUDE.md §4.8).
 * - **CONFIRMED real service codes**, from ShipEngine's own documented
 *   supported list (a real integrator's own field mapping, not this
 *   codebase's guess): domestic Express9/Express10/Express24/Express48/
 *   ExpressAM/ExpressPM plus Secure/Exchange/Collection variants;
 *   international EuroEconomy/EuroPriority/GlobalBulkDirect/GlobalEconomy/
 *   Globalexpress/Globalpriority/Globalvalue/IrelandExpress -- free text
 *   here, unvalidated, same "an invalid value surfaces as a real API
 *   error" precedent every other carrier's own serviceCode field already
 *   establishes.
 * - **`createShipment` -- THE SINGLE LEAST-CONFIRMED REQUEST BODY IN THIS
 *   CONNECTOR**, same "flag it, don't hide it" precedent Evri's own
 *   `ShipmentInformation`/`Shipper`/`Destination` body carries (§19.2): no
 *   literal rendered example of this specific operation's own field names
 *   was found by ANY method tried this pass (the Chilkat tool's own
 *   dynamic operation switch did not actually change its rendered output
 *   away from `returnShipment` regardless of the `op` query parameter
 *   passed -- tried directly, twice, confirmed non-responsive). Modeled
 *   here on general UK-courier-API naming conventions (`Consignment`,
 *   `RecipientAddress`, `Parcel`/`Weight`) and on this codebase's own
 *   shared `CreateShipmentRequest` field set, the same "no better source"
 *   reasoning Temu's own `skuStockTargetList` and TikTok's own
 *   `pushInventory` bodies already carry (CLAUDE.md §4.7/§4.8). Response
 *   parsing is correspondingly defensive -- several plausible tag-name
 *   candidates tried in order (`ShipmentNumber`/`ConsignmentNumber`/
 *   `ParcelNumber` for the carrier order id, `TrackingNumber`/
 *   `BarcodeNumber` for the tracking number), with the raw response XML
 *   always preserved on {@link CreateShipmentResult.raw} so a real UAT run
 *   can reveal the actual shape without re-deriving it from scratch.
 * - **`CancelShipment` (voidShipment) -- CONFIRMED to exist as a real
 *   operation** (the WSDL's own operation list), unlike Evri, where no
 *   confirmed cancel endpoint path was found at all (§19.2) -- Parcelforce
 *   is the SECOND carrier in this codebase's layer, after Royal Mail, with
 *   a real `voidShipment` implementation. Its own request field
 *   (`ShipmentNumber`) is a REASONED inference, not a guess from nothing:
 *   `returnShipment` is the one operation whose full request shape IS
 *   confirmed, and it identifies a shipment to act on via exactly that
 *   field name -- a fair bet that `CancelShipment`, needing to identify
 *   the same kind of thing, reuses it, though this is still INFERRED, not
 *   directly confirmed for `CancelShipment` itself.
 * - **No live rate-shopping/quote operation exists** among any of the ten
 *   confirmed `ShipServiceSoapBinding` operations -- the same genuine
 *   carrier-API-level gap Royal Mail's and Evri's own research each
 *   confirmed (§19.1/§19.2). **No confirmed Parcelforce-specific surcharge
 *   or base-price data was found or researched this pass either** (unlike
 *   Royal Mail's own real, dated `carrier_surcharges` seed rows) -- same
 *   "don't fabricate a number with no confirmed source" reasoning behind
 *   {@link EvriConnector.getRateEstimate}'s own empty-list return; worth
 *   being explicit that this is NOT assumed to share Royal Mail Group's own
 *   surcharge schedule just because Parcelforce is part of the same
 *   corporate group -- that relationship was never confirmed anywhere this
 *   pass, so it isn't relied on.
 * - **`Find` (trackShipment) -- THE SINGLE LEAST-CONFIRMED METHOD ON THIS
 *   CONNECTOR, more so even than `createShipment`**: `Find` is CONFIRMED to
 *   exist as an operation NAME (the WSDL's own operation list), but nothing
 *   found this pass confirms its actual PURPOSE, request fields, or
 *   response fields -- "Find" is a plausible, but entirely unverified,
 *   guess at "this is the tracking/status-lookup operation," based only on
 *   there being no other, better-named candidate anywhere in the same
 *   ten-operation list. No official Parcelforce tracking REST API distinct
 *   from expressLink was found either (only third-party tracking-aggregator
 *   sites, not treated as a primary source here). `verifyConnection()`
 *   below also calls `Find`, for lack of any better-confirmed cheap
 *   read-only operation -- meaning a real credential-verification failure
 *   and an unrelated malformed-request failure may be indistinguishable
 *   until this is tried against a real UAT account.
 * - **Manifesting is confirmed required, not optional**: ShipEngine's own
 *   docs state plainly, "Manifests are required for Parcelforce Worldwide
 *   shipments and must be printed" -- cross-confirming that
 *   `createManifest`/`printManifest` are real, load-bearing operations,
 *   not decorative WSDL entries. **Deliberately NOT implemented this
 *   pass** -- see the closing "Deliberately not built" paragraph in
 *   CLAUDE.md §19.4; a real integration cannot skip this step, but wiring
 *   a manifest-generation flow is a genuinely separate, additive piece of
 *   work from "add a fourth carrier to the existing dispatch map."
 * - **No XML parsing library exists anywhere in this codebase** -- every
 *   carrier/channel connector built so far talks JSON. Rather than adding
 *   a new npm dependency for one carrier, this file hand-rolls a minimal,
 *   dependency-free SOAP envelope builder and a best-effort regex-based
 *   tag extractor (`xmlTag`/`xmlTagAny`) -- adequate for the flat,
 *   single-occurrence fields this connector reads, genuinely less robust
 *   than `JSON.parse()` (no handling for a repeated tag, a self-closing
 *   empty tag, or CDATA), and flagged here as a deliberate scope choice,
 *   same "thin hand-rolled client, no SDK" precedent CheckClient's own
 *   class doc comment already establishes (CLAUDE.md §14.1) -- just
 *   applied to XML instead of a missing REST SDK.
 *
 * **UNVERIFIED IN PRACTICE, same status every other carrier in this
 * codebase carried before its first live pass**: no real Parcelforce
 * expressLink username/password/contract number exists anywhere in this
 * codebase or Arif's account yet -- and, unlike Royal Mail and FedEx, this
 * is a genuinely closed API with no way to obtain even test credentials
 * without first going through Parcelforce's own Customer Solutions Team,
 * the same real-world blocker Evri's own connector carries (§19.2). This is
 * a well-researched first draft built against a real, confirmed operation
 * list and a real, confirmed auth shape, with the least-confirmed pieces
 * (createShipment's own field names, Find's entire purpose) plainly flagged
 * rather than presented as settled.
 */

// CONFIRMED via a real developer's own Google Groups post (see class doc
// comment) -- Parcelforce's own domain, treated as more authoritative than
// the Chilkat-tool-derived `expresslink-uat1.neopost-id.com` host. The real
// PRODUCTION host is UNCONFIRMED by anything found this pass -- see class
// doc comment.
const PARCELFORCE_BASE_URL = "https://expresslink-test.parcelforce.net/ws/";
const SOAP_NAMESPACE = "http://www.parcelforce.net/ws/ship/v14";
const DEFAULT_DEPARTMENT_ID = "1";

export interface ParcelforceCredentials {
  /** expressLink's own username -- travels inside the SOAP body's own
   *  Authentication node on EVERY request, not an HTTP header (CONFIRMED,
   *  cross-confirmed -- see class doc comment). Stored in
   *  carrier_connections.encrypted_client_id, same column FedEx's own
   *  clientId already established a reuse precedent for (§19.3). */
  username: string;
  password: string;
  /** Parcelforce's own contract number -- CONFIRMED required field,
   *  independent of username/password (ShipEngine's own documented
   *  connection fields). Stored in carrier_connections.external_account_id
   *  -- the SECOND carrier in this layer, after FedEx's own accountNumber
   *  (§19.3), where that column holds a genuinely independent account
   *  identifier rather than a repurposed value. */
  contractNumber: string;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Best-effort, dependency-free XML tag extraction -- see this file's class
 *  doc comment for why no real XML parser is used. Matches the first
 *  `<tagName>...</tagName>` (namespace-prefix-agnostic) pair found,
 *  ignoring attributes. Adequate for this connector's own flat,
 *  single-occurrence fields -- NOT a general XML parser: a repeated tag, a
 *  self-closing empty tag, and CDATA are all out of scope. */
function xmlTag(xml: string, tagName: string): string | null {
  const match = xml.match(new RegExp(`<(?:[\\w-]+:)?${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tagName}>`, "i"));
  const value = match?.[1]?.trim();
  return value ? value : null;
}

/** Tries several plausible tag-name candidates in order, same "read
 *  several plausible candidates" discipline EvriConnector's/
 *  FedExConnector's own response parsing already establishes for their own
 *  under-confirmed response shapes. */
function xmlTagAny(xml: string, tagNames: string[]): string | null {
  for (const tagName of tagNames) {
    const value = xmlTag(xml, tagName);
    if (value) return value;
  }
  return null;
}

export class ParcelforceConnector implements CarrierConnector {
  constructor(private readonly credentials: ParcelforceCredentials) {}

  /** No separate token endpoint exists for expressLink -- credentials
   *  travel inside the Authentication node of EVERY SOAP request body
   *  (CONFIRMED, cross-confirmed -- see class doc comment), never
   *  exchanged for a token up front. Mirrors
   *  RoyalMailConnector.authenticate()'s own non-network,
   *  non-expiring-token shape for the identical reason: there is nothing
   *  to call yet. */
  async authenticate(_tenantCredentials?: CarrierTenantCredentials): Promise<CarrierAuthToken> {
    if (!this.credentials.username || !this.credentials.password || !this.credentials.contractNumber) {
      throw new Error("ParcelforceConnector.authenticate: missing expressLink username/password/contract number");
    }
    return { accessToken: this.credentials.username, expiresAt: "9999-12-31T23:59:59Z" };
  }

  private buildEnvelope(operation: string, bodyXml: string): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns="${SOAP_NAMESPACE}">
  <soapenv:Header/>
  <soapenv:Body>
    <ns:${operation}Request>
      <ns:Authentication>
        <ns:UserName>${xmlEscape(this.credentials.username)}</ns:UserName>
        <ns:Password>${xmlEscape(this.credentials.password)}</ns:Password>
      </ns:Authentication>
      ${bodyXml}
    </ns:${operation}Request>
  </soapenv:Body>
</soapenv:Envelope>`;
  }

  /** Posts a SOAP envelope and returns the raw response XML text -- every
   *  caller in this class extracts its own fields via xmlTag/xmlTagAny
   *  rather than this method parsing into a shared shape, since no two
   *  operations' own response fields are confirmed to look alike. The
   *  `SOAPAction` header value (the bare operation name) is CONFIRMED from
   *  the Chilkat-tool-generated code's own literal header ("SOAPAction:
   *  returnShipment") -- see class doc comment. */
  private async parcelforceRequest(operation: string, bodyXml: string): Promise<string> {
    const response = await fetchWithBackoff(PARCELFORCE_BASE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: operation,
      },
      body: this.buildEnvelope(operation, bodyXml),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Parcelforce expressLink API error (${response.status}): ${text}`);
    }
    // A SOAP Fault can come back with a 200 status (server-dependent) --
    // checked for defensively since no confirmed example of Parcelforce's
    // own Fault shape was found this pass.
    const fault = xmlTagAny(text, ["faultstring", "Fault"]);
    if (fault) {
      throw new Error(`Parcelforce expressLink SOAP fault: ${fault}`);
    }
    return text;
  }

  /** Proves an expressLink username/password/contract number triple
   *  actually works before a connect route persists it -- same "verify
   *  before persist" discipline every connector in this codebase already
   *  follows. Calls `Find`, the closest thing to a safe, non-mutating
   *  lookup among the ten confirmed operation names -- but see this file's
   *  own class doc comment for why this is the single least-confirmed
   *  piece of this connector's design: Find's own request/response schema
   *  was not found anywhere this pass, so a malformed request could fail
   *  for a reason unrelated to whether the credentials themselves are
   *  valid. A real verification pass against a live UAT account should
   *  confirm or replace this. */
  async verifyConnection(): Promise<void> {
    await this.parcelforceRequest("Find", "");
  }

  /**
   * createShipment -- SEE THIS FILE'S CLASS DOC COMMENT: the single
   * least-confirmed request body in this connector. Builds a `Consignment`-
   * style SOAP body from the shared {@link CreateShipmentRequest} shape
   * (the same one RoyalMailConnector/EvriConnector/FedExConnector each
   * consume) -- weight is sent in kilograms (INFERRED unit -- UK-courier
   * convention, not confirmed by any literal example this pass, unlike
   * Royal Mail's own confirmed grams field). `DepartmentId` defaults to
   * `"1"` (ShipEngine's own documented typical default -- see class doc
   * comment) rather than being collected as a tenant credential.
   */
  async createShipment(request: CreateShipmentRequest): Promise<CreateShipmentResult> {
    const totalWeightKg = (request.packages.reduce((sum, pkg) => sum + pkg.weightGrams, 0) / 1000).toFixed(3);
    const bodyXml = `
      <ns:Consignment>
        <ns:ContractNumber>${xmlEscape(this.credentials.contractNumber)}</ns:ContractNumber>
        <ns:DepartmentId>${DEFAULT_DEPARTMENT_ID}</ns:DepartmentId>
        <ns:Reference>${xmlEscape(request.orderReference)}</ns:Reference>
        <ns:ServiceCode>${xmlEscape(request.serviceCode ?? "Express24")}</ns:ServiceCode>
        <ns:TotalWeight>${totalWeightKg}</ns:TotalWeight>
        <ns:RecipientContact>
          <ns:PersonName>${xmlEscape(request.recipient.name)}</ns:PersonName>
          <ns:Phone>${xmlEscape(request.recipient.phone ?? "")}</ns:Phone>
        </ns:RecipientContact>
        <ns:RecipientAddress>
          <ns:AddressLine1>${xmlEscape(request.recipient.addressLine1)}</ns:AddressLine1>
          <ns:AddressLine2>${xmlEscape(request.recipient.addressLine2 ?? "")}</ns:AddressLine2>
          <ns:Town>${xmlEscape(request.recipient.city)}</ns:Town>
          <ns:PostalCode>${xmlEscape(request.recipient.postalCode)}</ns:PostalCode>
          <ns:CountryCode>${xmlEscape(request.recipient.countryCode)}</ns:CountryCode>
        </ns:RecipientAddress>
        <ns:Parcels>
          ${request.packages
            .map(
              (pkg) => `<ns:Parcel><ns:Weight>${(pkg.weightGrams / 1000).toFixed(3)}</ns:Weight></ns:Parcel>`,
            )
            .join("")}
        </ns:Parcels>
      </ns:Consignment>`;

    const responseXml = await this.parcelforceRequest("createShipment", bodyXml);

    const shipmentNumber = xmlTagAny(responseXml, ["ShipmentNumber", "ConsignmentNumber", "ParcelNumber"]);
    const trackingNumber = xmlTagAny(responseXml, ["TrackingNumber", "BarcodeNumber"]) ?? shipmentNumber;
    if (!shipmentNumber && !trackingNumber) {
      throw new Error("Parcelforce expressLink createShipment: no shipment/tracking identifier found in response");
    }

    return {
      carrierOrderId: shipmentNumber ?? trackingNumber!,
      trackingNumber,
      labelBase64: xmlTagAny(responseXml, ["Label", "LabelData", "LabelImage"]),
      raw: responseXml,
    };
  }

  /** CancelShipment -- CONFIRMED to exist as a real operation (unlike
   *  Evri, where no confirmed cancel endpoint was found at all, §19.2).
   *  `ShipmentNumber` as the request field is a REASONED inference, not a
   *  guess from nothing -- see this file's class doc comment. */
  async voidShipment(carrierOrderId: string): Promise<void> {
    await this.parcelforceRequest("CancelShipment", `<ns:ShipmentNumber>${xmlEscape(carrierOrderId)}</ns:ShipmentNumber>`);
  }

  /** `Find` -- THE SINGLE LEAST-CONFIRMED METHOD ON THIS CONNECTOR. See
   *  this file's own class doc comment: `Find` is confirmed only to exist
   *  as an operation NAME, not confirmed to actually be a tracking/status
   *  lookup, nor to accept or return the fields used here. `events` is
   *  deliberately left empty rather than fabricated -- no per-event field
   *  names are confirmed or even plausibly inferred from anything found
   *  this pass, unlike Royal Mail's own confirmed events array. */
  async trackShipment(trackingNumber: string): Promise<TrackingResult> {
    const responseXml = await this.parcelforceRequest("Find", `<ns:ShipmentNumber>${xmlEscape(trackingNumber)}</ns:ShipmentNumber>`);
    return {
      trackingNumber,
      statusCategory: xmlTagAny(responseXml, ["Status", "StatusCategory", "State"]) ?? "unknown",
      statusDescription: xmlTagAny(responseXml, ["StatusDescription", "Description"]) ?? "",
      events: [],
      raw: responseXml,
    };
  }

  /** NOT a live call, same reasoning as RoyalMailConnector's/
   *  EvriConnector's own getRateEstimate() -- no live rate-shopping
   *  operation exists among any of the ten confirmed expressLink
   *  operations (see class doc comment), and no confirmed
   *  Parcelforce-specific surcharge/base-price data exists in this
   *  codebase either (unlike Royal Mail's own real, dated
   *  carrier_surcharges rows) -- deliberately returns an empty list rather
   *  than fabricating a number or assuming Parcelforce shares Royal Mail
   *  Group's own surcharge schedule, a relationship never confirmed this
   *  pass. */
  async getRateEstimate(_request: { weightGrams: number; destinationCountryCode: string; shipDate: string }): Promise<RateEstimate[]> {
    return [];
  }
}

/** Mirrors loadFedExCredentialsFromCarrierConnection's own shape
 *  (fedex-connector.ts) -- most-recently-created active row, since
 *  carrier_connections' own UNIQUE(tenant_id, carrier) constraint
 *  (migration 0039) means there is at most one per tenant anyway. */
export async function loadParcelforceCredentialsFromCarrierConnection(
  pool: Pool,
  tenantId: string,
): Promise<ParcelforceCredentials> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query<{
      encrypted_client_id: Buffer | null;
      encrypted_client_secret: Buffer | null;
      external_account_id: string | null;
    }>(
      `SELECT encrypted_client_id, encrypted_client_secret, external_account_id
         FROM carrier_connections
        WHERE carrier = 'parcelforce' AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 1`,
    );

    const row = result.rows[0];
    if (!row || !row.encrypted_client_id || !row.encrypted_client_secret || !row.external_account_id) {
      throw new Error(`No active 'parcelforce' carrier_connections row found for tenant ${tenantId}`);
    }

    const username = await decryptChannelSecret(client, row.encrypted_client_id);
    const password = await decryptChannelSecret(client, row.encrypted_client_secret);
    return { username, password, contractNumber: row.external_account_id };
  });
}

export async function createParcelforceConnectorFromCarrierConnection(pool: Pool, tenantId: string): Promise<ParcelforceConnector> {
  const credentials = await loadParcelforceCredentialsFromCarrierConnection(pool, tenantId);
  return new ParcelforceConnector(credentials);
}
