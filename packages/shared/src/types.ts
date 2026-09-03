// Mirrors the schema created by packages/db/migrations (CLAUDE.md §2).
// Keep in sync with the migrations by hand — there is no code generation step.

export interface Tenant {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface User {
  id: string;
  tenantId: string;
  clerkUserId: string;
  email: string;
  createdAt: string;
  updatedAt: string;
}

export interface Product {
  id: string;
  tenantId: string;
  internalSku: string;
  name: string;
  attributes: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelListing {
  id: string;
  tenantId: string;
  productId: string;
  channel: string;
  channelMarketplace: string;
  externalId: string | null;
  externalSku: string | null;
  listingStatus: string;
  lastSyncedAt: string | null;
  rawPayload: unknown;
}

export type InventoryEventType =
  | "receipt"
  | "sale"
  | "reservation"
  | "release"
  | "adjustment"
  | "damage"
  | "transfer";

export type InventoryReferenceType = "order" | "po" | "manual" | "return";

export interface InventoryEvent {
  id: string;
  tenantId: string;
  productId: string;
  locationId: string;
  eventType: InventoryEventType;
  quantityDelta: number;
  referenceType: InventoryReferenceType | null;
  referenceId: string | null;
  idempotencyKey: string;
  createdAt: string;
}

export interface InventoryLevel {
  tenantId: string;
  productId: string;
  locationId: string;
  onHand: number;
  reserved: number;
  available: number;
  channelBuffer: Record<string, number>;
  updatedAt: string;
}

export type OrderStatus =
  | "received"
  | "validated"
  | "on_hold"
  | "allocated"
  | "backordered"
  | "picking"
  | "packed"
  | "shipped"
  | "delivered"
  | "returned"
  | "refunded"
  | "cancelled";

export interface Order {
  id: string;
  tenantId: string;
  channel: string;
  externalOrderId: string;
  status: OrderStatus;
  customer: Record<string, unknown> | null;
  shippingAddress: Record<string, unknown> | null;
  placedAt: string | null;
  rawPayload: unknown;
}

export type FulfillmentType = "seller_fulfilled" | "fba" | "wfs" | "3pl";

export interface OrderLine {
  id: string;
  tenantId: string;
  orderId: string;
  productId: string;
  quantity: number;
  unitPrice: string;
  fulfillmentType: FulfillmentType;
}

export type PicklistStatus = "open" | "assigned" | "completed" | "cancelled";

export interface Picklist {
  id: string;
  tenantId: string;
  locationId: string;
  status: PicklistStatus;
  assignedTo: string | null;
}

export type PicklistLineStatus = "pending" | "picked" | "short" | "damaged";

export interface PicklistLine {
  id: string;
  tenantId: string;
  picklistId: string;
  orderLineId: string;
  productId: string;
  quantityRequested: number;
  quantityPicked: number;
  status: PicklistLineStatus;
}

export type LocationType = "warehouse" | "3pl" | "fba" | "wfs";

export interface Location {
  id: string;
  tenantId: string;
  name: string;
  type: LocationType;
}

export interface AutomationRuleCondition {
  field: string;
  op: string;
  value: unknown;
}

export interface AutomationRuleAction {
  type: string;
  value: unknown;
}

export interface AutomationRule {
  id: string;
  tenantId: string;
  name: string;
  triggerEvent: string;
  conditions: AutomationRuleCondition[];
  actions: AutomationRuleAction[];
  priority: number;
  enabled: boolean;
}
