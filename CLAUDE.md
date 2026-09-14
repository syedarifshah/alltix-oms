# alltix-oms — Project Context

Multichannel ERP/OMS SaaS (Linnworks/Cin7-class platform). This file is the persistent
architectural memory for this project — read it before proposing any structural change.
Full source blueprint: `ERPOMSSaaSBlueprint.pdf` (keep in repo root or /docs).

## 0. Locked Scope Decisions

- **First customer**: small-to-mid multichannel sellers (Amazon/Walmart/eBay/Shopify), 500-50,000 orders/month.
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

**Retrofit risk at the top of the target range**: a tenant near 50,000 orders/month
(§0) can generate 100k+ `inventory_events` rows/month on its own, before
receipts/adjustments/transfers are counted. An unpartitioned, unarchived ledger table
is the same "expensive to retrofit later" category as RLS (§11, item 6) — not
implemented now, but a decision point to revisit before it becomes urgent. Monthly range
partitioning on `created_at` is the likely approach when it's needed.

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

- **Auth**: Login with Amazon (LWA) OAuth only — a Client ID, Client Secret, and
  per-seller refresh token, registered per marketplace region (NA/EU/FE). Amazon
  removed the AWS IAM/SigV4 signing requirement from SP-API in Oct 2023; no AWS
  account is needed. Confirmed working end-to-end (sandbox LWA token exchange +
  `marketplaceParticipations` call) in
  `packages/channel-connectors/src/amazon-connector.ts`.
  - **Getting that per-seller refresh token — two mutually exclusive paths,
    researched against Amazon's current docs**: a **Private** SP-API
    application (what this repo's `AMAZON_SANDBOX_*` credentials are) is
    authorized exclusively through **self-authorization** — a manual
    "Authorize app" click in Seller Central / the Solution Provider Portal
    that hands you a refresh token directly, no browser redirect or
    callback involved at all (see `scripts/seed-test-channel-connection.ts`,
    proven working repeatedly). A **Public** application instead uses the
    redirect-based **Website Authorization Workflow**: redirect to
    `https://sellercentral.amazon.com/apps/authorize/consent?application_id={id}&state={csrf-token}&version=beta`
    (`version=beta` while the app is in Draft status), Amazon calls back
    with `?state=...&selling_partner_id=...&spapi_oauth_code=...`, then
    trade `spapi_oauth_code` for a refresh token via
    `POST https://api.amazon.com/auth/o2/token`
    (`grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`,
    `client_secret`; the code expires in 5 minutes, the whole round trip
    should finish within 10). **This is not a sandbox-vs-production
    distinction** — Public/Private is a property of the application's own
    registration, identical in both environments — so a Private app can
    never use the redirect flow, in sandbox or in production, until it's
    published as Public with a registered redirect URI. Implemented (ready
    for that day) in `packages/channel-connectors/src/amazon-oauth.ts`
    (URL-building/token-exchange), `packages/web/src/lib/amazon-oauth-state.ts`
    (signed/expiring/tenant-bound CSRF `state`), and the
    `/api/channels/amazon/{connect,callback}` routes + `/settings/channels`
    page. Verified live: navigating the exact authorize URL above (with a
    placeholder `application_id`) gets a real 302 from
    `sellercentral.amazon.com` into Amazon's own sign-in flow rather than an
    outright rejection (Amazon defers `application_id` validation to the
    post-login consent screen, unreachable without a Public app + real
    seller session); the LWA token-exchange request shape is verified
    against the real endpoint in
    `scripts/amazon-oauth-token-exchange-isolation-test.ts` (rejected with a
    structured OAuth error, not a malformed-request error); state
    sign/verify is unit-tested in
    `packages/web/test/amazon-oauth-state.test.ts`. The callback's DB
    upsert (`INSERT ... ON CONFLICT (tenant_id, channel, marketplace,
    external_account_id) DO UPDATE ...`) has been exercised directly against
    real Postgres/RLS/pgcrypto. What has **not** been verified, and cannot
    be until this app is Public: an actual browser round trip through a
    real Amazon consent screen producing a real `spapi_oauth_code`.
- **Orders API**: pulls order headers; order line items require a separate call —
  budget rate limits accordingly. Confirmed working end-to-end (sandbox
  `GetOrders` + `GetOrderItems`, real quantities/SKUs mapped into normalized
  order lines) in `packages/channel-connectors/src/amazon-connector.ts`.
- **Reports API**: async, report-based — bulk FBA inventory reports, settlement data.
- **Feeds API**: async, submission-based — bulk listing/price/inventory writes.
  Still correct for bulk catalog operations, but **not** the right tool for a
  single SKU's quantity: that's the **Listings Items API**
  (`PATCH /listings/2021-08-01/items/{sellerId}/{sku}`, a JSON Patch body
  replacing `/attributes/fulfillment_availability`), which responds
  synchronously instead of requiring a poll-for-completion feed job — a
  better fit for `ChannelConnector.pushInventory`'s single-item signature.
  Only applies to merchant-fulfilled (MFN) stock; FBA (AFN) inventory isn't
  pushed this way. Confirmed working end-to-end against the sandbox (see
  `AmazonConnector.pushInventory` in the same file) — note the sandbox only
  round-trips the request shape and an HTTP success for this endpoint, it
  doesn't persist anything queryable back, unlike Orders.
- **Notifications API (event-driven, via SQS)**: subscribe to `ORDER_STATUS_CHANGE`,
  `FBA_OUTBOUND_SHIPMENT_STATUS`, `FEED_PROCESSING_FINISHED`, `ANY_OFFER_CHANGED` —
  react near-real-time instead of polling.
- **Design note**: build an internal `AmazonEventProcessor` that consumes the SQS
  queue and re-publishes normalized events onto your own internal bus — don't let
  downstream services depend on Amazon's raw notification shape.

**Unverified until production**: two pieces of Amazon integration are implemented and
confirmed to reach live SP-API infrastructure with a correct request shape, but can't
be proven to actually succeed until run against a real seller account, not sandbox
data —

- The OAuth "Connect Amazon" redirect flow (Website Authorization Workflow) — see the
  detailed writeup above in this section.
- `AmazonConnector.confirmShipment()` — the static sandbox has no matching test
  scenario for this operation on this account; see its doc comment in
  `packages/channel-connectors/src/amazon-connector.ts` for what was tried.

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
  submitListing(listing: NormalizedListing): Promise<{ feedId: string }>
  getFeedStatus(feedId: string): Promise<SyncResult>
  confirmShipment(orderId: string, tracking: TrackingInfo): Promise<void>
  subscribeToEvents(handler: EventHandler): void  // no-op for poll-only channels
}
```

Don't trust this interface until channel #2 (Walmart) is live — fitting a second,
structurally different API (feed/poll-heavy vs. event-driven) into the same shape is
what forces you to find its real form. `submitListing`/`getFeedStatus` is exactly
that: the original single `pushListing(): Promise<SyncResult>` is a confirmed
casualty of building the Walmart connector, not a speculative change — Walmart's
Offer-Setup-by-Match write is feed-submit-then-poll with no synchronous equivalent,
and `SyncResult` has no way to represent "submitted, not yet known to have
succeeded or failed."

### 4.4 Handling API rate limits (critical — causes most production incidents)

- Central **rate-limited job queue** per tenant, per marketplace, per endpoint —
  token-bucket algorithm.
- **Priority lanes**: order-status writes > inventory writes > bulk catalog syncs —
  never let a bulk job starve a time-sensitive order update.
- **Exponential backoff + circuit breaker** per channel connection — back off
  automatically on 503s rather than risking account-level suspension.
- **Idempotency keys** on every write and every event handler — both Amazon and
  Walmart will redeliver; handlers must be safe to run twice.

### 4.5 Shopify Admin API (build third — channel #3, GraphQL, verified live)

- **Auth**: a custom app's static Admin API access token (`shpat_...`) — no OAuth
  round trip, no client secret/refresh token, doesn't expire. Simplest of the three
  connectors' auth models. A **legacy** custom app (Partner-owned store, created via
  Settings → Apps → Develop apps → "Allow legacy custom app development" → "Create a
  legacy custom app") is what actually works for this — Shopify's newer Dev
  Dashboard app-creation flow is OAuth-based even with "legacy install flow" checked,
  and can't complete without a real callback server this connector-class-only pass
  doesn't build. Partners can still create true legacy custom apps on stores they own
  that haven't been transferred to a merchant (Shopify's own UI says so).
- **API shape**: GraphQL only (`POST /admin/api/{version}/graphql.json`), unlike
  Amazon/Walmart's REST. Pin an explicit dated version (`2026-07` at the time this was
  built) — never "latest."
- **Orders API**: `orders(first, after, query, sortKey: CREATED_AT)`, Relay-style
  cursor pagination, looped to completion (unlike AmazonConnector, which doesn't loop
  SP-API's NextToken — an accepted gap there, not repeated here). Confirmed working
  end-to-end in `packages/channel-connectors/src/shopify-connector.ts`.
- **Protected Customer Data**: any PII-bearing field (`customer`, `shippingAddress`,
  `billingAddress`, etc.) is gated behind a Partner-Dashboard-level approval separate
  from Admin API scopes, and for a custom app also requires the store to be on the
  Shopify/Advanced/Plus plan (not Basic) — the same shape of restriction as SP-API's
  Restricted Data Token, just gating a different field set. A query that includes such
  a field doesn't fail outright: Shopify returns the rest of the order normally and
  nulls out just that field, reporting it as a GraphQL error alongside otherwise-good
  data — treat that as a per-field warning, not a fatal failure. `customer { email }`
  was dropped from the orders query entirely (the order-level `email` scalar isn't
  similarly gated, and `normalizeShopifyOrder()` already fell back to it).
- **Inventory writes**: `inventorySetQuantities` (absolute, matching this platform's
  "system of truth" role per §1), not the relative `inventoryAdjustQuantities`. Several
  non-obvious requirements only surfaced by running against a real dev store, not
  documented clearly enough up front to get right on paper:
  - `InventoryQuantityInput` requires `changeFromQuantity` (the quantity the caller
    believes is currently persisted) — forces a read-before-write.
  - The mutation requires `@idempotent(key: $idempotencyKey)` as a directive
    *argument* in the query text itself — not a header, and not optional once a
    mutation has opted into idempotency.
  - **The actual bug that cost the most time**: a store with more than one Location
    means `locations(first: 1)` (no explicit sort) is NOT reliably "the location this
    SKU is stocked at." Two rounds of misdiagnosis (a propagation-lag theory, then an
    unreliable-singular-field theory) preceded finding this — the fix is to resolve
    the write location from the item's own existing `inventoryLevels`, falling back to
    an arbitrary location only for a genuinely new/never-stocked item. See
    `ShopifyConnector.pushInventory`'s doc comment for the full trace; worth reading
    before touching this method again.
- **Fulfillment**: `fulfillmentCreateV2` against open FulfillmentOrders needs one of
  `write_assigned_fulfillment_orders` / `write_merchant_managed_fulfillment_orders` /
  `write_third_party_fulfillment_orders` depending on who's assigned to fulfill the
  order — NOT a scope literally named `write_fulfillments`. An order whose line item
  is on a third-party-fulfilled product (e.g. Shopify's own demo "3p Fulfilled"
  product) needs the third-party scope specifically; merchant-managed is the
  default/simplest case and what a normal seller-fulfilled product needs.
- **Still not implemented**: the shared `ChannelConnector.submitListing`/
  `getFeedStatus` interface itself — `NormalizedListing` still lacks the fields
  Shopify's product-creation mutations require (title, a price, at least one variant),
  and nothing forces `createListing()` (see the new paragraph below) into that
  async-feed shape, the same reasoning `pullProductCatalog()` already used. Amazon/
  Walmart still have no outbound listing-creation path at all. `subscribeToEvents` is
  still a deliberate no-op on the connector itself — real-time webhooks are wired in as
  application/web-layer infrastructure instead, see the paragraph below.
- **Wired into the app** (migration `0019_channel_connections_shopify.sql`): a
  Shopify row in `channel_connections` reuses the same table Amazon's OAuth flow
  populates, with `lwa_client_id`/`encrypted_client_secret`/`encrypted_refresh_token`
  relaxed to nullable (Amazon-OAuth concepts a custom app's single static token has
  nothing to put in) and a new `encrypted_access_token` column for the token itself —
  long-lived and high-value like Amazon's refresh token, so it gets the same
  pgcrypto-at-rest treatment, not left plaintext the way Amazon's short-lived
  `access_token` is. `external_account_id` holds the `*.myshopify.com` domain;
  `marketplace` is always `''` (one connected store is one connection, full stop).
  Unlike Amazon, there is no OAuth redirect/consent screen at all: `/settings/channels`
  has a plain "Connect Shopify" form (shop domain + Admin API access token) that POSTs
  to `/api/channels/shopify/connect`, which calls `ShopifyConnector.verifyConnection()`
  (a live `{ shop { name } }` call) to reject a bad domain/token pair before persisting
  anything, then encrypts and upserts the row. The scheduler
  (`packages/scheduler/src/{index,cron-runner}.ts`) runs a Shopify order-sync pass in
  parallel to Amazon's own — `syncShopifyOrders`/`runShopifyOrderSyncJob`/
  `startShopifyOrderSyncScheduler`, a separate node-cron task and separate
  `scripts/shopify-order-sync-{job,scheduler}.ts` entrypoints — kept as parallel
  functions rather than a shared "any channel" abstraction since Amazon's sandbox
  lookback special-case doesn't apply to Shopify and two channels isn't enough to pay
  for the abstraction yet. The node-cron scripts are for a non-serverless host; what
  actually triggers a sync on this app's Vercel deployment is
  `GET /api/cron/shopify-order-sync` (mirrors `/api/cron/amazon-order-sync` exactly —
  same `CRON_SECRET` Bearer-token gate, same idempotency contract) plus its `crons`
  entry in `vercel.json`. `WarehouseService.confirmShipment()` dispatches to
  `createShopifyConnectorFromChannelConnection` on `order.channel === "shopify"`,
  alongside its existing Amazon branch.
- **Automatic catalog sync** (`ShopifyConnector.pullProductCatalog()`,
  `packages/scheduler`'s `syncShopifyCatalog`/`runShopifyCatalogSyncJob`, cron route
  `GET /api/cron/shopify-catalog-sync` at 4:30am — before the 5am order-sync cron, so a
  genuinely new product is more likely mapped before that day's orders reference it,
  though Hobby's ±59min per-job scheduling imprecision means this ordering is a
  best-effort default, not a guarantee): closes the gap
  `scripts/add-channel-listing.ts` is a manual, one-SKU-at-a-time stopgap for. Pulls
  every SKU'd variant in the store and upserts a `products`/`channel_listings` row per
  variant, using the exact same `internal_sku = "shopify-<sku>"` convention that script
  defaults to — so a SKU already onboarded by hand is found and updated, never
  duplicated. Baseline stock is seeded once via `InventoryService.recordInventoryEvent`
  (a real `receipt` event, never a direct `inventory_levels` write) from Shopify's own
  currently-reported quantity, summed across every Location the item has a level at
  (this codebase's own `locations` table still has no per-Shopify-location mapping —
  Phase 4 work, see §8). The idempotency key
  (`catalog-onboarding:<tenantId>:shopify:<sku>`) is **deliberately** the same prefix
  `scripts/add-channel-listing.ts` already uses, not a separate one: idempotency_key is
  UNIQUE across all of `inventory_events` regardless of which script or job wrote it, so
  a SKU a human already seeded by hand is never re-baselined (and potentially
  double-counted) by this job — every later run just keeps the catalog mapping current
  without touching inventory again, since the tenant's own ledger is the ongoing source
  of truth after the first baseline. A variant with no SKU set can't be mapped at all
  and is skipped with a warning (`pullProductCatalog`'s own doc comment) — that edge
  case stays manual. **Confirmed against a real dev store** (`npm run
  shopify:sandbox-smoke-test`) — correctly pulled every SKU'd variant with the right
  quantities and skipped this store's SKU-less demo variants with the expected warning,
  on the first live attempt (unlike `pullOrders`/`pushInventory`/`confirmShipment`, each
  of which needed multiple rounds of live debugging — see their own history above).
- **Real-time webhooks** (`ShopifyConnector.registerWebhooks()`, `POST
  /api/webhooks/shopify`): closes the "still cron-polling, once daily" gap — orders now
  sync within seconds of being placed/cancelled instead of waiting for the next
  `shopify-order-sync` cron run, which stays wired in as a same-day fallback for a
  tenant who hasn't enabled webhooks or whose one delivery got dropped. Built on the
  **per-tenant custom-app model** (not a distributed/public OAuth app) — an explicit
  choice made when this was scoped, keeping the "one custom app per merchant" shape the
  rest of this connector already uses rather than taking on an OAuth consent flow for
  one feature.
  - **Credential**: a custom app's Dev Dashboard API credentials page shows an "API
    secret key" alongside the Admin API access token — a different credential, never
    sent to Shopify on any call this connector makes, used only to verify the
    `X-Shopify-Hmac-Sha256` header on each inbound delivery (`verifyShopifyWebhookHmac`,
    already implemented/unit-tested before this pass). It's optional on the "Connect
    Shopify" form — a tenant can connect and stay cron-only forever without it — and,
    once submitted, is stored in `channel_connections.encrypted_client_secret`,
    **reusing** the column `0019_channel_connections_shopify.sql` relaxed to nullable
    for the opposite reason (a Shopify row had nothing to put there before webhooks
    existed) rather than adding a new column: a per-tenant client secret is now a
    genuinely correct value for a column literally named that. There's no way to
    validate a client secret's correctness up front the way `verifyConnection()`
    validates the access token (Shopify has no "check this secret" API) — a mistyped
    one just means every real delivery gets rejected with 401 at the route, logged,
    until corrected.
  - **Topics**: `ORDERS_CREATE`, `ORDERS_CANCELLED`, `APP_UNINSTALLED` (registered via
    `webhookSubscriptionCreate`, using the store's existing access token — registration
    itself needs no client secret). `orders/create` persists through the identical
    `OrderService.persistPulledOrders()` path the cron job uses, so it gets the same
    `(tenant_id, channel, external_order_id)` dedupe and the same routing-rule
    opportunity. `orders/cancelled` re-uses `OrderService.transition(..., 'cancelled')`
    — the same mechanism a human's own Cancel button on the order page calls — and
    treats a redelivery of an already-cancelled order as an idempotent no-op rather than
    letting the guarded `UPDATE` throw. `app/uninstalled` flips the connection to
    `disconnected`, closing the "no alerting on a dead token" gap `syncTenant`'s own
    comment in `packages/scheduler` still flags as open for Amazon.
  - **Multi-tenant credential resolution**: a webhook delivery carries no tenant id,
    only `X-Shopify-Shop-Domain` — resolving that to a tenant and its
    `encrypted_client_secret`, before RLS can scope anything, is an inherently
    cross-tenant lookup. `/api/webhooks/shopify` uses `getAdminPool()` (`DATABASE_URL`,
    bypasses RLS) for exactly that one query, the same justified, narrowly-scoped
    exception `packages/scheduler`'s tenant-enumeration queries already use — every
    subsequent read/write for the resolved tenant goes through the normal `app_user` +
    `withTenant()` path.
  - **Known gap, documented not solved**: an `orders/cancelled` delivery that arrives
    before the corresponding order has ever been created locally (out-of-order delivery,
    or a tenant enabling webhooks after an order was already placed *and* cancelled on
    Shopify) has nothing to cancel yet — logged and acknowledged, but a later
    cron/`orders/create` delivery for the same order will still insert it as a normal
    `'received'` order and allocate against it as if it were never cancelled. Closing
    this needs either re-reading Shopify's current order state instead of trusting
    delivery order, or a small "seen but not yet local" staging table — neither built.
  - **UNVERIFIED against a real store as written** (this connector's usual discipline):
    `registerWebhooks()` is transcribed from shopify.dev, not yet exercised live — the
    opt-in step in `shopify-sandbox-smoke-test.ts`
    (`SHOPIFY_SANDBOX_TEST_WEBHOOK_CALLBACK_URL`) exists for exactly that, not run yet.
- **Outbound listing creation** (`ShopifyConnector.createListing()`, `POST
  /api/channels/shopify/listings`, `/products` page): closes part of the "Not
  implemented" gap above for Shopify specifically — a tenant can now push an existing
  internal `products` row out as a brand-new Shopify product, rather than this
  connector only ever pulling listings in. Single call to `productSet(...,
  synchronous: true)`, the modern replacement for the old productCreate +
  productVariantsBulkCreate + inventorySetQuantities sequence.
  - **v1 scope, deliberately narrow**: one variant only (`"Title"`/`"Default Title"`),
    no options/variant matrix — `ShopifyListingSubmission` only carries
    `internalSku`/`title`/`price`. `status: "ACTIVE"` on the product does **not** make
    it visible on any storefront: publishing to a sales channel is a separate
    `publishablePublish` mutation needing `write_publications`, deliberately not called
    here since it's unconfirmed whether a custom app can even be granted that scope —
    the tenant does that one step by hand in their own Shopify admin. `channel_listings.
    listing_status` reflects this: rows from this flow are inserted as `'draft'`, never
    `'active'` — a semantic split from every *inbound*-discovered listing (catalog sync,
    `add-channel-listing.ts`), which use `'active'` to mean "confirmed already live on
    the channel."
  - **Price storage**: new nullable `channel_listings.list_price` column (migration
    `0020_channel_listings_list_price.sql`) — deliberately not on `products`, since
    §2.1's product master is channel-agnostic on purpose and a multichannel seller
    commonly prices the same product differently per channel.
  - **Starting stock**: not part of `createListing()` itself — the route
    (`/api/channels/shopify/listings`) makes a best-effort follow-up call to the
    existing `pushInventory()` after a successful create, seeding the new listing with
    this tenant's current `SUM(inventory_levels.available)` rather than leaving it at
    Shopify's default of zero. This is `pushInventory()`'s first real caller — it was
    previously flagged in this file as built but never wired into any trigger.
  - **Duplicate-create guard**: `productSet` with no `identifier` always creates a new
    product — it doesn't upsert by SKU the way a *pulled-in* listing's
    `(tenant_id, channel, channel_marketplace, external_id)` UNIQUE constraint makes
    naturally idempotent. The route checks for an existing `channel_listings` row for
    `(tenant_id, product_id, channel='shopify')` before calling Shopify at all, and has
    a distinct `shopify_listing_created_but_not_recorded:<productGid>` error path if the
    Shopify-side create succeeds but the local DB insert fails afterward, so a retry
    from `/products` doesn't blindly create a second Shopify product for the same
    internal product.
  - **Confirmed against a real dev store**: `createListing()` succeeded end-to-end from
    the `/products` UI against a real custom app -- `productSet` accepted the
    single-variant `productOptions`/`optionValues` shape (the part flagged as riskiest
    pre-verification) on the first attempt once the app actually had `write_products`
    granted. One real-world gotcha worth recording: adding a scope to a custom app and
    saving it does **not** retroactively grant that scope to an *already-issued* Admin
    API access token -- the existing token silently keeps failing with
    `ACCESS_DENIED`/`productSet failed` until the tenant reinstalls the custom app (or
    otherwise gets Shopify to reissue the token) and reconnects with the new one. This
    app has no way to detect or explain that distinction itself; a tenant who adds
    `write_products` after already connecting will hit this exact confusing error and
    need to reconnect with a fresh token.

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
| Load testing | Simulate a top-of-range tenant's (§0: 50,000 orders/month, ~1,700 orders/day average) peak-day burst at roughly 5-10x that average daily rate (~8,500-17,000 orders in a day), sustained for several hours, against the allocation path specifically — this is where systems fail first |

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
  - Open question for Arif: given the widened volume ceiling (§0: up to 50,000
    orders/month), whether the CDC-fed reporting store is worth moving earlier than
    Phase 4 — not a change to the phase order itself, just worth deciding deliberately
    rather than by default.
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
