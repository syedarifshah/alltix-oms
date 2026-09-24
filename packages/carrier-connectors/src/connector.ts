// The interface every carrier adapter implements -- the shipping-side
// counterpart to ChannelConnector (packages/channel-connectors/src/connector.ts,
// CLAUDE.md §4.3), for a genuinely different relationship: a channel is
// where an order COMES FROM, a carrier is who an already-packed order gets
// HANDED TO. Modeled the same way CLAUDE.md §4.3 itself was modeled --
// "don't trust this interface until carrier #2 is built against it" applies
// here too, same as it did for ChannelConnector before Walmart proved it out.
// Royal Mail (this codebase's first and, as of this pass, only carrier) is
// the wedge; every method below is shaped around what its real, confirmed
// API can and cannot do -- see RoyalMailConnector's own class doc comment
// in royal-mail-connector.ts for exactly what's CONFIRMED vs INFERRED.

export type CarrierAuthToken = {
  accessToken: string;
  expiresAt: string;
};

export interface CarrierTenantCredentials {
  tenantId: string;
  [key: string]: unknown;
}

/** One line item inside a package -- customs/contents declaration, required
 *  by Royal Mail's own CreateOrderRequest shape (confirmed via the official
 *  swagger spec, api.parcel.royalmail.com/doc/v1/click-and-drop-api-v1.yaml)
 *  for international shipments and useful metadata even domestically. */
export interface ShipmentPackageItem {
  name: string;
  sku?: string;
  quantity: number;
  unitValueGbp: string;
  unitWeightGrams?: number;
}

/** One physical package within a shipment. Royal Mail's own API supports
 *  multiple packages per order (a split shipment); this codebase only ever
 *  builds a single-package request for v1, same "one order -> one package"
 *  narrowing every other connector's own confirmShipment() carries for its
 *  single-fulfillment assumption (CLAUDE.md §4.1/§4.2/§4.6's own documented
 *  limitation, applied here to package count instead of order count). */
export interface ShipmentPackage {
  weightGrams: number;
  packageFormat: string;
  items: ShipmentPackageItem[];
}

export interface CreateShipmentRequest {
  orderId: string;
  /** The internal order's own reference -- becomes Royal Mail's
   *  orderReference (max 40 chars, confirmed via the official swagger). */
  orderReference: string;
  orderDate: string;
  recipient: {
    name: string;
    addressLine1: string;
    addressLine2?: string;
    city: string;
    postalCode: string;
    countryCode: string;
    phone?: string;
    email?: string;
  };
  /** Sum of item values -- Royal Mail's own required `subtotal` field. */
  subtotalGbp: string;
  /** What the customer was actually charged for shipping -- Royal Mail's
   *  own required `shippingCostCharged` field. NOT a live quote: Royal
   *  Mail's Click & Drop API has no rate-shopping/quote endpoint at all
   *  (confirmed absent from the official swagger spec) -- this is either a
   *  flat tenant-configured amount, or resolved from a published static
   *  price table this codebase doesn't yet have, never a value this
   *  connector itself computes from a live call. */
  shippingCostChargedGbp: string;
  totalGbp: string;
  /** Royal Mail's own serviceCode (e.g. a Tracked 48 / Tracked 24 code) --
   *  free text here, not validated against a fixed enum, same "an invalid
   *  value surfaces as a real API error, not something pre-validated"
   *  precedent Walmart's productCategory/eBay's categoryId both already
   *  establish (CLAUDE.md §4.2/§4.6). */
  serviceCode?: string;
  packages: ShipmentPackage[];
}

export interface CreateShipmentResult {
  /** Royal Mail's own orderIdentifier -- what GET/DELETE /orders/{id} and
   *  GET /orders/{id}/label are keyed on. Distinct from trackingNumber,
   *  which is the customer/carrier-scan-facing value. */
  carrierOrderId: string;
  trackingNumber: string | null;
  /** Base64-encoded label PDF, when Royal Mail's own synchronous response
   *  includes it (confirmed field on CreateOrderResponse) -- null if label
   *  generation failed for this order while the order itself was still
   *  created (Royal Mail's own `labelErrors` array covers this split
   *  outcome; see RoyalMailConnector.createShipment()'s own doc comment). */
  labelBase64: string | null;
  raw: unknown;
}

export interface TrackingEvent {
  eventCode: string;
  eventName: string;
  eventDateTime: string;
  locationName: string | null;
}

export interface TrackingResult {
  trackingNumber: string;
  statusCategory: string;
  statusDescription: string;
  events: TrackingEvent[];
  raw: unknown;
}

/** A published/estimated rate, NOT a live quote -- see CarrierConnector's
 *  own {@link CarrierConnector.getRateEstimate} doc comment for why this
 *  distinction matters and is stated plainly rather than glossed over. */
export interface RateEstimate {
  serviceCode: string;
  serviceName: string;
  estimatedCostGbp: string;
  /** True when this figure already has the current peak/fuel/etc.
   *  surcharges (carrier_surcharges, migration 0039) folded in -- see
   *  surcharges.ts's own applySurcharges(). */
  surchargesApplied: boolean;
}

export interface CarrierConnector {
  authenticate(tenantCredentials: CarrierTenantCredentials): Promise<CarrierAuthToken>;
  /** Creates a real order + generates a real label with the carrier.
   *  Runs BEFORE WarehouseService.confirmShipment() -- this is what
   *  produces the real tracking number that confirmShipment()'s own
   *  TrackingInfo then carries to the order's CHANNEL. Two genuinely
   *  separate network calls to two genuinely separate systems, in that
   *  order: carrier first (get a real tracking number), channel second
   *  (tell the marketplace the order shipped, using that real number) --
   *  never the reverse, since a channel shouldn't be told about a tracking
   *  number that doesn't exist yet. */
  createShipment(request: CreateShipmentRequest): Promise<CreateShipmentResult>;
  /** Cancels a shipment before it's been manifested/collected. Not every
   *  carrier's API supports this the same way (Royal Mail: a real DELETE
   *  /orders/{id}) -- optional on the interface rather than a hard
   *  requirement, since a future carrier without a real cancel endpoint
   *  shouldn't be forced to fake one. */
  voidShipment?(carrierOrderId: string): Promise<void>;
  trackShipment(trackingNumber: string): Promise<TrackingResult>;
  /** Published-rate-card-based estimate, not a live quote -- see
   *  {@link RateEstimate}'s own doc comment. Royal Mail's Click & Drop API
   *  has no rate-shopping/quote endpoint at all (confirmed: absent from
   *  both the official swagger spec and the official API product listing,
   *  developer.royalmail.net/api) -- a genuine, confirmed limitation of the
   *  carrier itself, not a gap in this connector. This method exists so the
   *  app-layer "live rate shopping" surface (task #59) has one real
   *  implementation to call even for a carrier with no live rates API:
   *  it resolves a static, tenant/codebase-maintained price table plus
   *  carrier_surcharges (migration 0039), not a network call. A future
   *  carrier that DOES expose a real rate-quote endpoint (several of the
   *  other 7 do, per this connector's own research pass) would implement
   *  this method with a real API call instead, and callers wouldn't need
   *  to change -- same reasoning behind every other optional/narrowed
   *  method on ChannelConnector's own interface. */
  getRateEstimate(request: {
    weightGrams: number;
    destinationCountryCode: string;
    shipDate: string;
  }): Promise<RateEstimate[]>;
}
