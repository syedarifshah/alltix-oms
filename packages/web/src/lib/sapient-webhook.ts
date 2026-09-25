/**
 * Pure parsing for the Sapient/Intersoft CORE API tracking webhook payload
 * (CLAUDE.md §19.9) -- the receiver route's own actual HTTP/DB work lives in
 * src/app/api/webhooks/sapient/route.ts; this file is deliberately just the
 * decision logic, extracted so it's unit-testable without a real request or
 * a real Postgres, same "extract the pure decision, test it directly"
 * precedent channel-flags.ts's own filterKnownChannels already sets.
 *
 * THE SINGLE LEAST-CONFIRMED PIECE OF THIS ENTIRE FEATURE, flagged plainly
 * rather than hidden, same "flag it, don't hide it" discipline this
 * codebase's every other least-confirmed request/response shape already
 * follows (Temu's skuStockTargetList, Evri's/Parcelforce's/DHL's own request
 * bodies): Sapient's own "Tracking Webhook Push Payload Example" reference
 * page (docs.intersoftsapient.net/reference/post_v4-trackings-pushpayloadexample)
 * CONFIRMS the mechanism (a real POST to a configured callback URL, carrying
 * "the payload SAPIENT posts to the customer" when tracking information is
 * received from a carrier) but renders its actual example JSON body via a
 * client-side widget this research pass's fetch tooling could not extract
 * text from -- repeated attempts (direct fetch, a request for raw
 * <pre>/<code> blocks) both returned only the page's surrounding prose, not
 * the JSON itself. What WAS independently confirmed and IS used to shape
 * this parser:
 *   - CONFIRMED real milestone names (docs.intersoftsapient.net/docs/
 *     tracking-events-and-milestones): "IT'S ON ITS WAY", "IN TRANSIT",
 *     "IN CUSTOMS", "OUT FOR DELIVERY", "DELIVERY ATTEMPT FAILED",
 *     "PART DELIVERED", "READY FOR COLLECTION", "DELIVERED", "COLLECTED",
 *     "UNDELIVERABLE", "TRANSIT DELAY" -- these are real values this
 *     app can expect to SEE in a milestone field, not evidence of the
 *     field's own name.
 *   - CONFIRMED a real, extensive tracking event CODE vocabulary exists on
 *     that same page (PSRE, PSAN, PSCO, PSDE, CAMD, CSBK, PSCS, PINT, PPID,
 *     PRID, PSDD, IOWS, BCUI, BHBC, BRBC, POFD, FDAF, FNCO, FCAR, FANK,
 *     FRNK, FRAA, FINA, FUTA, DPAR, DRFC, DELV, DTSP, DPOB, DDMG, DTNB,
 *     DTNS, DNSV, DNSO, DRCO, RTNS, RUND, RNCO, UDTS, IDES, ICAN, FUDS,
 *     IDIP, IFME, ISMI, PRET, ICLR, IARR, IRCO, INVD, ISOH, PSDP, CAAT,
 *     CAFI, CAFP, CAFN, CAFA, CAFO, CSPP, CSPI, CSPN, CSPO, CCAN, CNAT) --
 *     again, real VALUES a code field can hold, not confirmation of the
 *     field's own name.
 *   - CONFIRMED a real, structured retry/suspension policy exists (8
 *     attempts, 5 minutes up to 72 hours apart, docs.intersoftsapient.net/
 *     docs/webhook-suspension) -- the receiver route's own idempotency
 *     handling exists because of this confirmed fact, not a guess.
 *   - CONFIRMED, by its total absence from every page fetched this pass
 *     (the overview page, the setup guide, the suspension-policy page, and a
 *     dedicated web search for "signature OR HMAC OR shared secret"): no
 *     documented signature/HMAC verification mechanism for this webhook was
 *     found anywhere. Unlike Shopify's own HMAC-verified webhook
 *     (CLAUDE.md §4.5, verifyShopifyWebhookHmac), this receiver cannot
 *     cryptographically prove a delivery is genuinely from Sapient --
 *     SAPIENT_WEBHOOK_SHARED_SECRET (the receiver route's own query-token
 *     check) is this codebase's OWN app-layer mitigation, not something
 *     Sapient's own docs describe or verify on their end.
 *
 * Given no confirmed field-name shape, this parser is deliberately
 * PascalCase-first (Sapient's own confirmed REST convention elsewhere --
 * TrackingNumbers/TrackingNumber/ShipmentId/Status, all confirmed on
 * EvriConnector's own POST /v4/trackings response) with camelCase and a
 * short list of plausible synonyms tried as fallbacks, read across the
 * payload's own top level AND one level of nesting under a few candidate
 * wrapper keys (some webhook systems nest the actual event under a
 * "Tracking"/"Event"/"Data"-style key; unconfirmed for Sapient specifically,
 * kept as a defensive fallback rather than assumed). A field this parser
 * doesn't recognize comes back null on that event -- never guessed, never
 * defaulted to something that looks plausible -- and the receiver route
 * separately keeps the complete raw body regardless, so nothing is ever
 * lost even when this parser can't make sense of it.
 */

export interface ParsedSapientTrackingEvent {
  trackingNumber: string | null;
  shipmentId: string | null;
  eventCode: string | null;
  milestone: string | null;
  description: string | null;
  location: string | null;
  /** ISO 8601 string, or null if no candidate field was present/parseable. */
  occurredAt: string | null;
}

const WRAPPER_KEYS = ["Tracking", "TrackingEvent", "Event", "Data", "trackingEvent", "event", "data"];
const EVENT_LIST_KEYS = ["Events", "events", "TrackingEvents", "trackingEvents", "Items", "items"];

const TRACKING_NUMBER_KEYS = [
  "TrackingNumber",
  "trackingNumber",
  "ConsignmentNumber",
  "consignmentNumber",
  "ParcelNumber",
  "parcelNumber",
];
const SHIPMENT_ID_KEYS = ["ShipmentId", "shipmentId", "ShipmentNumber", "shipmentNumber", "ShipmentIdentifier", "shipmentIdentifier"];
const EVENT_CODE_KEYS = ["EventCode", "eventCode", "Code", "code", "StatusCode", "statusCode"];
const MILESTONE_KEYS = ["Milestone", "milestone", "MilestoneName", "milestoneName"];
const DESCRIPTION_KEYS = [
  "Description",
  "description",
  "EventDescription",
  "eventDescription",
  "Status",
  "status",
  "StatusDescription",
  "statusDescription",
];
const LOCATION_KEYS = ["Location", "location", "EventLocation", "eventLocation", "DepotName", "depotName"];
const OCCURRED_AT_KEYS = [
  "EventDateTime",
  "eventDateTime",
  "Timestamp",
  "timestamp",
  "OccurredAt",
  "occurredAt",
  "EventDate",
  "eventDate",
  "Date",
  "date",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every scope this parser will search, in priority order: the event object
 *  itself first, then one level of nesting under each candidate wrapper key
 *  that's actually present. A field found in an earlier scope always wins
 *  over the same field name in a later one. */
function candidateScopes(event: Record<string, unknown>): Record<string, unknown>[] {
  const scopes: Record<string, unknown>[] = [event];
  for (const key of WRAPPER_KEYS) {
    const nested = event[key];
    if (isPlainObject(nested)) {
      scopes.push(nested);
    }
  }
  return scopes;
}

function firstStringAcross(scopes: Record<string, unknown>[], keys: string[]): string | null {
  for (const scope of scopes) {
    for (const key of keys) {
      const value = scope[key];
      if (typeof value === "string" && value.trim() !== "") {
        return value.trim();
      }
      if (typeof value === "number" && Number.isFinite(value)) {
        return String(value);
      }
    }
  }
  return null;
}

/** Returns a real ISO 8601 string only when the candidate value actually
 *  parses as a date -- an unparseable value is null, not the original raw
 *  string, since occurredAt is meant to feed a TIMESTAMPTZ column and a
 *  malformed value there is worse than a missing one. */
function firstDateAcross(scopes: Record<string, unknown>[], keys: string[]): string | null {
  const raw = firstStringAcross(scopes, keys);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseSingleSapientTrackingEvent(event: unknown): ParsedSapientTrackingEvent {
  const obj = isPlainObject(event) ? event : {};
  const scopes = candidateScopes(obj);
  return {
    trackingNumber: firstStringAcross(scopes, TRACKING_NUMBER_KEYS),
    shipmentId: firstStringAcross(scopes, SHIPMENT_ID_KEYS),
    eventCode: firstStringAcross(scopes, EVENT_CODE_KEYS),
    milestone: firstStringAcross(scopes, MILESTONE_KEYS),
    description: firstStringAcross(scopes, DESCRIPTION_KEYS),
    location: firstStringAcross(scopes, LOCATION_KEYS),
    occurredAt: firstDateAcross(scopes, OCCURRED_AT_KEYS),
  };
}

/**
 * Top-level entry point. Handles three shapes uniformly, since neither is
 * confirmed for Sapient specifically and guessing wrong would silently drop
 * real deliveries: a bare JSON array of events, a single event object with
 * one of EVENT_LIST_KEYS holding an array, or a single event object on its
 * own. Always returns an array (possibly of length 1) so the receiver route
 * never has to branch on shape itself.
 */
export function parseSapientTrackingWebhookPayload(body: unknown): ParsedSapientTrackingEvent[] {
  if (Array.isArray(body)) {
    return body.map(parseSingleSapientTrackingEvent);
  }
  if (isPlainObject(body)) {
    for (const key of EVENT_LIST_KEYS) {
      const list = body[key];
      if (Array.isArray(list) && list.length > 0) {
        return list.map(parseSingleSapientTrackingEvent);
      }
    }
    return [parseSingleSapientTrackingEvent(body)];
  }
  return [];
}

/**
 * Best-effort, not a confirmed Sapient event id -- no such field was found
 * anywhere this research pass (see this file's own header comment). Built
 * from whatever this parser DID extract, so the same underlying event
 * redelivered by Sapient's own confirmed retry policy produces the same key
 * and collides harmlessly against shipment_tracking_events.idempotency_key's
 * UNIQUE constraint (migration 0041) instead of double-counting. A
 * completely unparseable event (every candidate field null) still gets a
 * key -- "unknown" segments included -- rather than being unrepresentable,
 * though in practice it would only ever collide with another equally
 * unparseable event for the same shipment, which is an acceptable outcome
 * (not a real event either way).
 */
export function buildSapientTrackingIdempotencyKey(shipmentId: string, event: ParsedSapientTrackingEvent): string {
  const marker = event.eventCode ?? event.milestone ?? event.description ?? "unknown-event";
  const at = event.occurredAt ?? "no-timestamp";
  return `sapient-tracking:${shipmentId}:${marker}:${at}`;
}
