# alltix-oms — Project Context

Multichannel ERP/OMS SaaS (Linnworks/Cin7-class platform). This file is the persistent
architectural memory for this project — read it before proposing any structural change.
Full source blueprint: `ERPOMSSaaSBlueprint.pdf` (keep in repo root or /docs).

## 0. Locked Scope Decisions

- **First customer**: small-to-mid multichannel sellers (Amazon/Walmart/eBay/Shopify), 50-5,000 orders/month.
- **Wedge feature**: real-time inventory sync + rules-based order automation.
- **Build type**: OMS/IMS-only (Linnworks model) for v1. NOT manufacturing/BOM (Cin7 model) — that roughly doubles data-model complexity and is a v2+ vertical.
- **Deployment**: multi-tenant SaaS, cloud-hosted, single codebase.
- **MVP definition (ship this, nothing more)**: Amazon + Walmart + Shopify connectors → unified inventory ledger → order pull/normalize → basic pick/pack workflow → one automation rule type (order routing) → billing.

Do not expand this scope without an explicit decision — every module below assumes it.

## 1. System Architecture

Start as a **modular monolith** with clean internal service boundaries (not literal
microservices). Split into real services only when a specific module's scale/team size
demands it.

```
API Gateway / BFF (auth, rate limiting, tenant routing)
        |
   Web App (Next.js)  |  Public REST API
        |
   Core Application Modules
   [Inventory Service] [Order Mgmt] [Warehouse/Fulfillment] [Rules/Automation]
        |
   Event Bus (Kafka / SNS+SQS)
        |
   Channel Connector Layer
   [Amazon Adapter] [Walmart Adapter] [Shopify Adapter] [eBay... Adapter]
        |
   Rate-Limited Job Queue (BullMQ/SQS)  |  Reporting/DW (read-optimized, via CDC)
```

### Module responsibilities

- **Channel Connector Layer** — one adapter per marketplace. Normalizes inbound data
  to internal schema, translates outbound writes to each API's native shape. This is
  ~60-70% of total engineering effort over the product's life — every marketplace API
  changes constantly.
- **Inventory Service** — owns the stock ledger (event-sourced, never a raw mutable
  quantity), computes available-to-sell (ATS), publishes `inventory.changed` events.
- **Order Management Service** — normalizes orders from all channels into one shape,
  owns the order state machine, publishes `order.received`, `order.allocated`,
  `order.shipped`, etc.
- **Warehouse/Fulfillment Service** — picklists, packing, kitting/bundling, carrier
  label generation, shipment confirmation back to channels.
- **Rules/Automation Engine** — evaluates stored condition→action definitions against
  incoming events; this is the retention-driving feature. Build it early, not as a
  "v2 feature."
- **Reporting/Analytics** — separate read-optimized store (columnar DB or data
  warehouse) fed by Change Data Capture (CDC) or the event stream, so heavy reports
  never contend with transactional writes.
- **Billing/Subscription** — usage metering (orders processed, SKUs, users) +
  Stripe/Chargebee integration for tiered SaaS pricing.

## 2. Data Model (Core Schemas)

### 2.1 Product / SKU master

```sql
products (
  id UUID PK,
  tenant_id UUID,
  internal_sku TEXT UNIQUE,
  name TEXT,
  attributes JSONB,        -- flexible per-category attributes
  created_at, updated_at
)

channel_listings (
  id UUID PK,
  tenant_id UUID,
  product_id UUID FK -> products,
  channel TEXT,                  -- 'amazon', 'walmart', 'shopify'
  channel_marketplace TEXT,      -- 'US', 'CA', 'EU-DE' etc.
  external_id TEXT,              -- ASIN, Walmart Item ID, Shopify variant ID
  external_sku TEXT,
  listing_status TEXT,
  last_synced_at TIMESTAMPTZ,
  raw_payload JSONB              -- last-seen raw channel data, for debugging/replay
)
```

### 2.2 Inventory ledger (event-sourced — the most important table in the system)

```sql
inventory_events (
  id UUID PK,
  tenant_id UUID,
  product_id UUID FK,
  location_id UUID FK -> locations,
  event_type TEXT,        -- 'receipt','sale','reservation','release','adjustment','damage','transfer'
  quantity_delta INT,     -- signed
  reference_type TEXT,    -- 'order','po','manual','return'
  reference_id UUID,
  idempotency_key TEXT UNIQUE,  -- prevents double-processing on retries/redelivery
  created_at TIMESTAMPTZ
)

-- Materialized/derived, refreshed on every event or via periodic rollup:
inventory_levels (
  product_id UUID,
  location_id UUID,
  on_hand INT,
  reserved INT,
  available INT GENERATED ALWAYS AS (on_hand - reserved) STORED,
  channel_buffer JSONB,   -- per-channel safety-stock buffer, e.g. {"amazon": 2}
  PRIMARY KEY (product_id, location_id)
)
```

**Rule: never let a channel adapter write directly to `inventory_levels`.** Every stock
change — marketplace order, PO receipt, or manual count — goes through
`inventory_events` first. This gives a full audit trail and makes oversell bugs
debuggable instead of mysterious.

### 2.3 Orders

```sql
orders (
  id UUID PK,
  tenant_id UUID,
  channel TEXT,
  external_order_id TEXT,
  status TEXT,               -- state machine, see §3
  customer JSONB,
  shipping_address JSONB,
  placed_at TIMESTAMPTZ,
  raw_payload JSONB,         -- untouched original channel payload
  UNIQUE (tenant_id, channel, external_order_id)
)

order_lines (
  id UUID PK,
  order_id UUID FK,
  product_id UUID FK,
  quantity INT,
  unit_price NUMERIC,
  fulfillment_type TEXT   -- 'seller_fulfilled','fba','wfs','3pl'
)
```

### 2.4 Locations & rules

```sql
locations ( id, tenant_id, name, type )  -- 'warehouse','3pl','fba','wfs'

automation_rules (
  id UUID PK,
  tenant_id UUID,
  name TEXT,
  trigger_event TEXT,     -- 'order.received'
  conditions JSONB,       -- [{field:'channel', op:'eq', value:'amazon'}, ...]
  actions JSONB,          -- [{type:'route_to_warehouse', value:'WH-2'}, ...]
  priority INT,
  enabled BOOLEAN
)
```

**Multi-tenancy**: every table carries `tenant_id`, enforced via **Postgres
Row-Level Security (RLS)** so a query bug can never leak one tenant's data into
another's response. Get this right on day one — expensive to retrofit later.

## 3. Order Lifecycle State Machine

```
received → validated → allocated → picking → packed → shipped → delivered
              |             |                              |
           on_hold     backordered                    returned/refunded
                            |
                        cancelled
```

- **Allocation** is the moment inventory moves from `available` to `reserved` in the
  ledger — must be atomic (single DB transaction or a distributed lock) to prevent two
  orders allocating the last unit simultaneously.
- **Cancellation after allocation** must emit a `release` inventory event, not just
  delete the reservation — the ledger should show *why* stock came back.
- Every transition publishes an event (`order.allocated`, `order.shipped`) that the
  Rules Engine and Reporting layer subscribe to independently — the order service
  itself doesn't know or care who's listening.

## 4. Marketplace Integration Layer

### 4.1 Amazon SP-API (build this first — best documented, largest market)

- **Auth**: OAuth + IAM role/policy per seller account, registered per marketplace
  region (NA/EU/FE).
- **Orders API**: pulls order headers; order line items require a separate call —
  budget rate limits accordingly.
- **Reports API**: async, report-based — bulk FBA inventory reports, settlement data.
- **Feeds API**: async, submission-based — bulk listing/price/inventory writes.
- **Notifications API (event-driven, via SQS)**: subscribe to `ORDER_STATUS_CHANGE`,
  `FBA_OUTBOUND_SHIPMENT_STATUS`, `FEED_PROCESSING_FINISHED`, `ANY_OFFER_CHANGED` —
  react near-real-time instead of polling.
- **Design note**: build an internal `AmazonEventProcessor` that consumes the SQS
  queue and re-publishes normalized events onto your own internal bus — don't let
  downstream services depend on Amazon's raw notification shape.

### 4.2 Walmart Marketplace API (build second — structurally different, feed/poll-heavy)

- **Auth**: OAuth 2.0, token-based, refreshed per session.
- **Items API**: "Offer Setup by Match" for existing catalog items, "Full Item Setup"
  for new.
- **Feeds API**: bulk operations — submit a feed file, get a `feedId`, poll
  `GET /v3/feeds/{feedId}` until `PROCESSED`, then inspect item-level `ingestionErrors`.
- **Inventory API**: real-time single-item stock updates.
- **Orders API**: retrieve/acknowledge/ship/cancel/refund; each order line carries a
  `fulfillmentOption` (`seller_fulfilled` vs WFS).
- **Required header**: `WM_QOS.CORRELATION_ID` (a GUID generated per call) — mandatory
  for support escalations, build it into the HTTP client wrapper globally, not per-call.

### 4.3 Connector abstraction (the interface every adapter implements)

```typescript
interface ChannelConnector {
  authenticate(tenantCredentials): Promise<AuthToken>
  pullOrders(since: Timestamp): Promise<NormalizedOrder[]>
  pushInventory(productId: string, quantity: number): Promise<SyncResult>
  pushListing(listing: NormalizedListing): Promise<SyncResult>
  confirmShipment(orderId: string, tracking: TrackingInfo): Promise<void>
  subscribeToEvents(handler: EventHandler): void  // no-op for poll-only channels
}
```

Don't trust this interface until channel #2 (Walmart) is live — fitting a second,
structurally different API (feed/poll-heavy vs. event-driven) into the same shape is
what forces you to find its real form.

### 4.4 Handling API rate limits (critical — causes most production incidents)

- Central **rate-limited job queue** per tenant, per marketplace, per endpoint —
  token-bucket algorithm.
- **Priority lanes**: order-status writes > inventory writes > bulk catalog syncs —
  never let a bulk job starve a time-sensitive order update.
- **Exponential backoff + circuit breaker** per channel connection — back off
  automatically on 503s rather than risking account-level suspension.
- **Idempotency keys** on every write and every event handler — both Amazon and
  Walmart will redeliver; handlers must be safe to run twice.

## 5. Technology Stack

| Layer | Choice | Why |
|---|---|---|
| Backend language | Node.js/TypeScript (connectors) + optionally Go for inventory/order core at scale | Huge marketplace SDK ecosystem in Node; Go for perf/type-safety if needed |
| Primary DB | PostgreSQL | Strong consistency for inventory ledger; RLS for multi-tenancy; JSONB for flexible channel payloads |
| Secondary store | Redis | ATS lookups (read-hot), distributed locks during allocation, job queue backing |
| Event bus | Kafka (scale) or AWS SNS+SQS (faster to stand up) | Decouples modules; replay capability for debugging |
| Job queue | BullMQ (Node) | Rate-limited, retryable, priority-lane job processing |
| Search/catalog | Elasticsearch or Postgres full-text (early on) | Flexible querying across varying per-channel listing shapes |
| Reporting/DW | ClickHouse or BigQuery, fed via CDC (Debezium) | Keeps analytics off the transactional path |
| Frontend | Next.js + React, Tailwind | Commodity choice, fast to build on |
| Infra | AWS (ECS/Fargate → EKS as you scale), Terraform | Fargate skips K8s ops until actually needed |
| Auth | Auth0/Clerk (buy, don't build) | Not your differentiator |
| Billing | Stripe Billing | Usage-based metering (orders processed, SKU count, seats) |
| Observability | Datadog or Grafana+Prometheus, Sentry | You *will* need to debug "why did SKU X oversell at 3am" |

## 6. Security & Compliance

- **PCI scope**: never touch raw card data — payments always flow through
  Stripe/marketplace-native checkout; only store tokens/references.
- **OAuth credential storage**: encrypt all marketplace API tokens at rest
  (KMS-backed), rotate on schedule, scope IAM roles to least privilege.
- **Tenant isolation**: RLS at the DB layer (§2.4) + application-layer tenant checks
  as defense-in-depth, never rely on one alone.
- **SOC 2**: not needed for MVP, but architect logging/access-control from day one —
  retrofitting audit trails later is expensive.
- **Webhook verification**: validate signatures on every inbound webhook (Amazon SNS
  message signing, Shopify HMAC, etc.) — don't trust unsigned payloads.
- **Rate-limit/DDoS protection** on the public API — a buggy customer integration
  script can otherwise take the platform down.

## 7. Testing Strategy

| Layer | Approach |
|---|---|
| Connector adapters | Build/test exclusively against each marketplace's **sandbox** before touching production seller data |
| Inventory ledger | Property-based/fuzz testing for concurrent allocation — simulate N simultaneous order-allocation requests against 1 unit of stock, assert exactly one succeeds |
| Rules engine | Golden-file tests: fixed event input → expected action output, covering every condition/action combination |
| Contract tests | Record real (sanitized) marketplace API responses as fixtures; replay in CI so a marketplace schema change breaks the build loudly, not silently in production |
| Load testing | Simulate peak-season order bursts (Black Friday-scale) against the allocation path specifically — this is where systems fail first |

## 8. Build Roadmap & Phasing

- **Phase 1 — Foundation (Months 1-3)**: core data model, tenant/auth, single-channel
  (Amazon) order pull + inventory push, basic inventory ledger with ATS + buffer stock.
- **Phase 2 — Prove the abstraction (Months 3-5)**: add Walmart as channel #2 (forces
  correct connector abstraction). Order state machine + warehouse picklist generation.
  Basic billing/subscription.
- **Phase 3 — The retention feature (Months 5-7)**: rules/automation engine (order
  routing at minimum). Add Shopify as channel #3 to validate the abstraction holds for
  a structurally different API type.
- **Phase 4 — Operational maturity (Months 7-9)**: reporting/analytics on separate
  read store. Multi-warehouse/3PL support. Returns handling. Rate-limit hardening,
  circuit breakers, observability dashboards.
- **Phase 5 — Scale features (Months 9-12+)**: eBay/TikTok Shop/additional channels.
  Stock forecasting. B2B portal (if pursuing Cin7-style ERP breadth). SOC 2 prep if
  targeting mid-market.

## 9. Deployment & DevOps

- **CI/CD**: GitHub Actions or GitLab CI — lint → unit tests → contract tests against
  recorded marketplace fixtures → deploy to staging → smoke test → promote to prod.
- **Environments**: dev → staging (with marketplace sandbox credentials) → production.
- **Blue/green or canary deploys** for the order/inventory services specifically —
  the one place downtime-induced oversells cannot be afforded.
- **Database migrations**: versioned, backward-compatible (expand/contract pattern) so
  deploys never require simultaneous app+schema cutover.
- **Feature flags** (LaunchDarkly or open-source alt) for gradually rolling out new
  channel connectors per tenant.
- **Disaster recovery**: point-in-time DB recovery (Postgres WAL), event bus replay
  capability to reconstruct inventory state after an incident rather than trusting a
  single mutable snapshot.

## 10. Team & Realistic Timeline

Realistic MVP timeline with a team of 3-4: 6-9 months to a genuinely usable
single/dual-channel product; 12+ months before feature parity approaches what
Linnworks/Cin7 offer today. **Don't aim for parity — aim for a sharper wedge** (better
automation UX, a niche vertical, or pricing transparency they don't offer) and expand
from there.

## 11. Where Homegrown Builds Fail — Read Before Any Shortcut

1. Treating channel sync as instant instead of eventually consistent — no buffer
   stock, no UX built around lag.
2. No conflict-resolution strategy for simultaneous allocation → oversells under load.
3. Ignoring rate limits until a peak sales event throttles/suspends the account.
4. Building the rules/automation engine as a "v2 feature" — it's actually the
   retention driver, build it early.
5. No sandbox-first connector development — debugging against live seller data is how
   accounts get suspended.
6. Skipping RLS/tenant isolation early — expensive to retrofit once real customer data
   is commingled.

## 12. Known Follow-ups

- **Clerk `createRouteMatcher` deprecation** — `packages/web/src/proxy.ts` uses
  `createRouteMatcher` from `@clerk/nextjs/server`, which Clerk has marked deprecated
  in favor of resource-based auth checks (auth checks moved into each page/layout/route
  instead of centralized path matching in Proxy). Revisit before upgrading to Clerk's
  next major version, since this will presumably be removed.
- **Test process cleanup must stay PID-scoped** — when a test spawns a child process
  (e.g. `next dev` for `packages/web/test/tenant-isolation.e2e.test.ts`), teardown must
  kill only that specific PID (and its process tree, e.g. `taskkill /T` on Windows for
  the `next-server` grandchild spawned under a shelled `npx`). Never use a broad
  `taskkill /IM node.exe` or `pkill node` — it can kill unrelated Node processes on the
  same machine (other dev servers, editor extensions, etc.), not just the one the test
  started.

---

*This document reflects standard, well-documented patterns for multichannel OMS/IMS
platforms plus the publicly documented behavior of the Amazon SP-API and Walmart
Marketplace API — not the proprietary internals of any specific vendor.*
