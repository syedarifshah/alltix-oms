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
  placedAt: string;
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
  pushListing(listing: NormalizedListing): Promise<SyncResult>;
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
