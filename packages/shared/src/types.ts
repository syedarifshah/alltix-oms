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

export type InventoryReferenceType = "order" | "po" | "manual" | "return" | "transfer";

/** The disposition decision OrderService.transition() now requires when
 *  `to === 'returned'` (see its own doc comment): 'sellable' restocks
 *  exactly what the order's own 'sale' inventory_events rows say it
 *  consumed when shipped; 'damaged' flips status with no restock at all --
 *  the unit is gone, not back on the shelf. No default -- a return without
 *  an explicit disposition throws rather than silently guessing either
 *  way. */
export type ReturnDisposition = "sellable" | "damaged";

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
  /** Set by the rules engine's `route_to_warehouse` action (a decision made
   *  while the order is 'received', before allocation) -- when present,
   *  allocateOrder() allocates against this location instead of its default
   *  choice. Null means no routing rule fired for this order. */
  preferredLocationId: string | null;
  /** Set only on an order spun off by WarehouseService.packOrder's
   *  short-pick handling (migration 0023) -- points back at the real order
   *  this one's shortfall was split from. Null for every ordinarily-ingested
   *  order. */
  splitFromOrderId: string | null;
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

/** One row per rule whose *conditions matched* an event -- not just ones
 *  whose action ultimately took effect (see `applied`) -- so "why did/didn't
 *  order X route to WH-2" is answerable after the fact even when a
 *  higher-priority rule's conflicting action won instead, or the current
 *  automation_rules row has since been edited. Deliberately NOT one row per
 *  enabled rule regardless of match: at real order volume (CLAUDE.md §0) a
 *  tenant could have many enabled rules where only a couple ever match a
 *  given trigger, and "why didn't rule Y fire at all" is answerable by
 *  comparing rule Y's own `conditions` to the order directly -- it doesn't
 *  need a log, unlike "why did a matching rule's action lose." See
 *  RulesEngine.evaluate()/executeActions(). */
export interface RuleExecution {
  id: string;
  tenantId: string;
  automationRuleId: string;
  orderId: string;
  triggerEvent: string;
  /** Always true for a persisted row (see above) -- kept as an explicit
   *  column rather than implied so a future caller can't misread absence of
   *  a row as "matched: false" without checking the rule's conditions too. */
  matched: boolean;
  /** This rule's action(s) actually took effect -- false when matched but a
   *  higher-priority rule's conflicting action of the same type won instead. */
  applied: boolean;
  actions: AutomationRuleAction[];
  error: string | null;
  createdAt: string;
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

export type EmployeeStatus = "active" | "inactive";

export interface Employee {
  id: string;
  tenantId: string;
  name: string;
  role: string;
  locationId: string | null;
  hourlyRate: number | null;
  status: EmployeeStatus;
  createdAt: string;
}

/** 'clock' = live clock-in/clock-out; 'manual' = a shift keyed in after the
 *  fact (still gets real clockIn/clockOut timestamps -- see migration
 *  0028_hr_payroll_employees_and_time_entries.sql's own doc comment for why
 *  there's no separate "manual hours" shape). Kept purely as UI/audit
 *  provenance. */
export type TimeEntrySource = "clock" | "manual";

export interface TimeEntry {
  id: string;
  tenantId: string;
  employeeId: string;
  locationId: string | null;
  clockIn: string;
  /** null means still clocked in -- an open shift, not a zero-length one. */
  clockOut: string | null;
  entrySource: TimeEntrySource;
  notes: string | null;
  createdAt: string;
}

export interface AutomationRule {
  id: string;
  tenantId: string;
  name: string;
  triggerEvent: string;
  conditions: AutomationRuleCondition[];
  actions: AutomationRuleAction[];
  /** Lower number = higher priority (RulesEngine's documented convention --
   *  see evaluate()). Also the primary sort key when resolving conflicting
   *  actions of the same type across multiple matched rules. */
  priority: number;
  enabled: boolean;
  /** Tie-breaker when two matched rules share the same priority and both
   *  specify a conflicting action of the same type: the earlier-created
   *  rule wins ("the rule you made first" is an explicable story; an
   *  arbitrary id comparison isn't). See RulesEngine.evaluate(). */
  createdAt: string;
}
