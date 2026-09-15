import type { FulfillmentType } from "@alltix/shared";

// The interface every marketplace adapter implements (CLAUDE.md §4.3).
// No adapters are implemented in this package yet — Amazon/Walmart/Shopify
// are separate, later work (CLAUDE.md §8, §11.5: sandbox-first, one channel
// at a time). CLAUDE.md also warns not to trust this shape until channel #2
// (Walmart) is built against it, since a second, structurally different API
// is what forces the interface into its real form.

export type AuthToken = {
  accessToken: string;
  expiresAt: string;
  refreshToken?: string;
};

export interface NormalizedOrderLine {
  externalLineId: string;
  externalSku: string;
  quantity: number;
  unitPrice: string;
  fulfillmentType: FulfillmentType;
}

export interface NormalizedOrder {
  externalOrderId: string;
  channel: string;
  channelMarketplace: string;
  /** Null when the channel's own reported purchase date isn't usable (e.g.
   *  Amazon's SP-API sandbox canned test data embeds an implausible
   *  PurchaseDate -- see parsePurchaseDate() in amazon-connector.ts). The
   *  `orders.placed_at` column is nullable for exactly this case. */
  placedAt: string | null;
  /** The channel's native order status string (e.g. Amazon's "Unshipped").
   *  Deliberately not mapped to the internal `OrderStatus` state machine
   *  here -- that mapping is Order Management Service's job (CLAUDE.md §3),
   *  not the connector's; the connector only normalizes shape. */
  channelStatus: string;
  customer: Record<string, unknown>;
  shippingAddress: Record<string, unknown>;
  lines: NormalizedOrderLine[];
  rawPayload: unknown;
}

export interface NormalizedListing {
  productId: string;
  channel: string;
  channelMarketplace: string;
  externalSku: string;

  /** Everything below is optional and channel-specific -- only
   *  WalmartConnector.submitListing() (its Offer-Setup-by-Match /
   *  MP_ITEM_MATCH feed) needs any of it today. Grown here, on the shared
   *  type, per submitListing()'s own original doc comment ("NormalizedListing
   *  needs to grow these before this can submit anything real") -- unlike
   *  Shopify's outbound listing path, which is a deliberately separate,
   *  non-interface method (ShopifyConnector.createListing) because
   *  Shopify's synchronous productSet mutation doesn't fit this
   *  submit-then-poll shape at all. Amazon has no outbound listing path
   *  yet either way. */

  /** Money-scalar-compatible string, e.g. "19.99" -- same convention
   *  NormalizedOrderLine.unitPrice already uses. */
  price?: string;
  /** Matches an existing Walmart catalog item by its own product
   *  identifier. GTIN is the only value confirmed against a live fetched
   *  Walmart doc page's literal JSON example
   *  (developer.walmart.com/us-marketplace/docs/create-an-offer-for-an-
   *  existing-walmart-item); UPC/EAN/ISBN are the other identifier types
   *  Walmart's docs reference elsewhere but weren't confirmed against a
   *  literal payload example the same way -- treat those three as
   *  unverified until tried against a real feed. */
  productIdentifier?: { productIdType: "GTIN" | "UPC" | "EAN" | "ISBN"; productId: string };
  /** e.g. "New" -- Walmart also allows non-new conditions (Remanufactured,
   *  Pre-Owned variants) for eligible sellers, which additionally require a
   *  main image URL this isn't wired to collect; only "New" is exercised
   *  in this codebase so far. */
  condition?: string;
  /** Pounds -- confirmed unit for the US Marketplace's product package
   *  weight fields (developer.walmart.com/us-marketplace/docs/item-setup-
   *  schema-key-points). Named with the unit in the field name since
   *  Walmart's own payload field (a plain "ShippingWeight": 6.94) carries
   *  no unit of its own. */
  shippingWeightLbs?: number;
  /** Free text in the one confirmed example payload (e.g. "Large
   *  Appliances"). Whether Walmart validates this against a fixed taxonomy
   *  wasn't confirmed by any doc page fetched for this pass -- an invalid
   *  value is expected to surface as a real feed-item ingestion error via
   *  getFeedStatus(), not something pre-validated here. */
  productCategory?: string;
}

export interface SyncResult {
  success: boolean;
  externalId?: string;
  error?: string;
}

export interface TrackingInfo {
  carrier: string;
  trackingNumber: string;
  shippedAt: string;
}

export type EventHandler = (event: unknown) => void | Promise<void>;

export interface TenantCredentials {
  tenantId: string;
  [key: string]: unknown;
}

export interface ChannelConnector {
  authenticate(tenantCredentials: TenantCredentials): Promise<AuthToken>;
  pullOrders(since: Date): Promise<NormalizedOrder[]>;
  pushInventory(productId: string, quantity: number): Promise<SyncResult>;
  /**
   * Submits a listing write and returns only the channel's tracking
   * handle for it -- confirmed split (not a guess) from building the
   * Walmart connector, channel #2: Walmart's Offer-Setup-by-Match write is
   * feed-submit-then-poll with no synchronous equivalent, and the old
   * single `pushListing(): Promise<SyncResult>` had no way to represent
   * "submitted, not yet known to have succeeded or failed" -- SyncResult
   * is a terminal outcome, not a pending one. See {@link getFeedStatus}.
   */
  submitListing(listing: NormalizedListing): Promise<{ feedId: string }>;
  /** Resolves a {@link submitListing} feedId to a terminal outcome. Callers
   *  (the rate-limited job queue, CLAUDE.md §4.4) poll this rather than
   *  blocking inside submitListing() itself. */
  getFeedStatus(feedId: string): Promise<SyncResult>;
  confirmShipment(orderId: string, tracking: TrackingInfo): Promise<void>;
  /** No-op for poll-only channels (e.g. Walmart) — see CLAUDE.md §4.2/§4.3. */
  subscribeToEvents(handler: EventHandler): void;
}

/** Minimal per-tenant registry. Populated once real adapters exist. */
export class ChannelConnectorRegistry {
  private readonly connectors = new Map<string, ChannelConnector>();

  register(channel: string, connector: ChannelConnector): void {
    this.connectors.set(channel, connector);
  }

  get(channel: string): ChannelConnector {
    const connector = this.connectors.get(channel);
    if (!connector) {
      throw new Error(`No connector registered for channel: ${channel}`);
    }
    return connector;
  }
}
