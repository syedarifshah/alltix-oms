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
  - Status as of this writing: all three connectors now have full application-layer
    wiring (Settings UI connect form, per-channel scheduler/cron sync, warehouse
    shipment-confirmation dispatch) — see §4.1/§4.2/§4.5's own "Wired into the app"
    sections. Amazon and Shopify are confirmed working against real (sandbox/dev-store)
    infrastructure; Walmart's wiring is complete and typechecked but UNVERIFIED IN ITS
    ENTIRETY pending a real Walmart seller/Solution Provider account (no self-serve
    sandbox exists to substitute — see §4.2). Everything else in this MVP definition
    (ledger, order pull/normalize, pick/pack, order-routing rules, billing) is built.

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
  reference_type TEXT,    -- 'order','po','manual','return','transfer'
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

**Multi-location transfers — built** (`packages/inventory-service/src/index.ts`'s
`InventoryService.transferStock()`, migration
`0022_inventory_events_transfer_reference_type.sql`): moves `on_hand` between two
locations for the same product, atomically
(a `SELECT ... FOR UPDATE` lock + re-check of *available* — not raw on_hand — at the
source, same discipline as `OrderService.allocateOrder`'s own oversell-prevention),
recording two paired `inventory_events` rows (`event_type = 'transfer'`,
`reference_type = 'transfer'`, sharing one generated `reference_id` so both legs of a
transfer can be found together). Deliberately never touches `reserved` — stock a
specific order is already counting on at a location has to be released/re-routed
first, not silently moved out from under it. Reachable today from `/inventory`'s
"Transfer stock" form (`POST /api/inventory/transfer`); `recordInventoryEvent` still
throws outright on `eventType: 'transfer'` (it has no two-location signature) and
points callers at this method instead.

**Shipment sale-consumption — built, closing a real gap** (`packages/warehouse-service/src/index.ts`'s
exported `recordShipmentSaleEvents`, called from `WarehouseService.confirmShipment` once
the channel confirms and before the local `packed` → `shipped` flip): until this existed,
a normal, fully-picked, successfully-shipped order never actually consumed inventory.
`packOrder`'s own ledger correction only ever fires for a *short* line (proven by an
existing, still-correct test: "a full pick makes no ledger correction") — a fully-picked
line left `on_hand` untouched and `reserved` permanently stuck at the allocated amount
forever, both silently drifting further from reality with every order that shipped
normally. The `sale` `event_type` was always defined in `InventoryService`'s own
`eventType` table (`on_hand += delta` AND `reserved += delta` together) but nothing in
the real order lifecycle ever called it until now. One `sale` event per order_line,
at the location the reservation event says it was actually reserved/picked from,
quantity = the line's current (possibly short-pick-reduced) quantity — idempotent via
`order-sale:<orderId>:<orderLineId>`.

**Returns handling — built** (`OrderService.returnOrder`, dispatched from
`OrderService.transition` when `to === 'returned'`): the "restocking is a separate manual
step" language this section used to have is gone — a return now requires an explicit
`disposition` (`'sellable' | 'damaged'`, `packages/shared/src/types.ts`'s
`ReturnDisposition`) with no default, since guessing either way would be wrong for some
real return. `'sellable'` restocks exactly what the order's own `sale` events (above) say
it consumed — read back off the ledger, not recomputed from `order_lines` — as a
`receipt` event with `reference_type = 'return'` (an `InventoryReferenceType` that
existed in the schema from the start but was never actually written anywhere until now).
`'damaged'` flips status with no restock. Surfaced on `/orders/[id]` as a dedicated
return form (`POST /api/orders/[id]/return`, separate from the generic `/transition`
route the same way `/cancel` is) rather than a plain button, since the disposition choice
can't be expressed as a fixed `to` value.

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
- **Short-pick handling — built** (`packages/warehouse-service/src/index.ts`'s
  `WarehouseService.packOrder`, migration `0023_orders_split_from_order_id.sql`):
  resolved the OPEN PRODUCT DECISION this section used to flag. Arif's call:
  split into a partial shipment + backorder, not silently ship-what-was-picked
  or hold the whole order. When a picklist line comes up short, the ledger
  correction (`adjustment`/`damage` inventory_events, unchanged from before) still
  happens, but the shortfall no longer just vanishes into it: the original
  order_line is reduced to what was actually picked (or, if nothing at all was
  picked, re-parented wholesale onto the new order — `order_lines.quantity`'s
  `CHECK (quantity > 0)` rules out reducing it to zero in place, and
  `picklist_lines.order_line_id` is a NOT NULL FK with no `ON DELETE` behavior, so
  the row can never just be deleted once it's been picked against), and a
  brand-new order is inserted directly at `backordered` — linked back via
  `orders.split_from_order_id` — carrying the missing quantity. From there it's
  an entirely ordinary backordered order: the existing `backordered` →
  `allocated` manual retry picks it up once stock is back. If a short pick leaves
  the *original* order with nothing left to ship (every line picked to zero), that
  order is cancelled outright instead of packed as an empty shipment — see
  `packOrder`'s own doc comment for why that's a raw guarded status flip rather
  than a call to `OrderService.cancelOrder()` (the ledger correction above already
  fully released that order's reservation; a second release pass would
  double-release). `/orders/[id]` surfaces the link in both directions.

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
- **Outbound listing creation — built, narrower than Shopify's/Walmart's**
  (`AmazonConnector.createListing()`, `buildCreateListingRequestBody()`,
  `POST /api/channels/amazon/listings`, `/products` page): a tenant can attach a new
  seller offer to an EXISTING Amazon catalog item, identified by ASIN, using
  `PUT /listings/2021-08-01/items/{sellerId}/{sku}` with `requirements:
  "LISTING_OFFER_ONLY"` + `productType: "PRODUCT"`. Not a full new-item listing —
  that needs `requirements: "LISTING"` plus a category-specific attribute schema
  fetched from Amazon's separate **Product Type Definitions API**, which is
  **not built** (bigger scope, deliberately deferred; see the decision behind this
  narrowing below). Genuinely synchronous (the outcome comes back in the same PUT
  response, like `pushInventory()`'s PATCH above), so this is a separate,
  connector-specific method — not `ChannelConnector.submitListing()`/
  `getFeedStatus()`, the async pair that exists for Walmart's real feed submission —
  same reasoning `ShopifyConnector.createListing()` already established. The new
  `channel_listings` row lands as `listing_status = 'active'` immediately (no
  `'pending'` state — unlike Walmart, there's nothing to poll for).
  - **v1 scope, deliberately narrow, same spirit as Shopify's/Walmart's own
    narrowing**: offer-only/ASIN-required (no brand-new-item path), condition fixed
    to `"new_new"` server-side. Amazon's barcode-based matching alternative
    (`externally_assigned_product_identifier`, the closer analog to Walmart's
    GTIN-matching flow) was deliberately **not implemented** — only described in
    prose during research, never confirmed against a literal example payload, and
    this codebase's standing rule is not to submit an unconfirmed shape to a real
    marketplace write.
  - **UNVERIFIED, more so than anything else in this connector**: no live call has
    been made against this exact PUT + `requirements=LISTING_OFFER_ONLY`
    combination. This sandbox environment's outbound network policy blocks
    `api.amazon.com` entirely (confirmed directly — a token-exchange `curl` to
    `api.amazon.com` was rejected at the proxy level, independent of credentials
    or code), on top of this connector's pre-existing "not run beyond the original
    onboarding sandbox pass" status for everything else in this file. The request
    shape itself was cross-confirmed from multiple independent real-world
    `github.com/amzn/selling-partner-api-models` community examples (not a single
    source) rather than official docs, since `developer-docs.amazon.com` could not
    be fetched during this research pass (redirects to a domain outside this
    session's fetchable provenance set).

**Unverified until production**: three pieces of Amazon integration are implemented
and confirmed to reach live SP-API infrastructure with a correct request shape (or,
for `createListing()`, cross-confirmed from real community examples), but can't be
proven to actually succeed until run against a real seller account —

- The OAuth "Connect Amazon" redirect flow (Website Authorization Workflow) — see the
  detailed writeup above in this section.
- `AmazonConnector.confirmShipment()` — the static sandbox has no matching test
  scenario for this operation on this account; see its doc comment in
  `packages/channel-connectors/src/amazon-connector.ts` for what was tried.
- `AmazonConnector.createListing()` — this environment's network policy blocks
  `api.amazon.com` outright, so not even a sandbox call has been possible; see the
  bullet above.

### 4.2 Walmart Marketplace API (build second — structurally different, feed/poll-heavy)

- **Auth**: not a refresh-token OAuth flow like Amazon's — `client_credentials` grant
  (`POST /v3/token`, HTTP Basic `client_id:client_secret`, `grant_type=client_credentials`),
  a short-lived (900s) access token cached in memory and refreshed near expiry, same
  shape as `AmazonConnector.authenticate()`'s own caching. No consent screen, no
  redirect/callback pair — a Client ID + Client Secret issued directly to the seller/
  Solution Provider account is the entire credential, same "paste two values into a
  form" simplicity as Shopify's static token, just short-lived instead of non-expiring.
  Implemented in `packages/channel-connectors/src/walmart-connector.ts`.
- **Items API**: "Offer Setup by Match" for existing catalog items, "Full Item Setup"
  for new.
- **Feeds API**: bulk operations — submit a feed file, get a `feedId`, poll
  `GET /v3/feeds/{feedId}` until `PROCESSED`, then inspect item-level `ingestionErrors`.
  This is also the *only* path `WalmartConnector.submitListing()` has for Offer Setup by
  Match (no synchronous equivalent the way Shopify's `productSet` mutation is) — see
  §4.3's note on why this forced `ChannelConnector.submitListing`/`getFeedStatus` to
  split out of a single `pushListing()` in the first place.
- **Outbound listing creation — built** (`WalmartConnector.submitListing()`,
  `buildMpItemMatchFeedPayload()`, `POST /api/channels/walmart/listings`,
  `POST /api/channels/walmart/listings/[id]/check-status`, `/products` page): a tenant
  can now submit an Offer Setup by Match (`MP_ITEM_MATCH`) feed matching an internal
  product to an EXISTING Walmart catalog item by GTIN — genuinely different from
  Shopify's `createListing()`, which makes a brand-new item. `NormalizedListing` grew
  the optional, channel-specific fields the match-feed payload needs (`price`,
  `productIdentifier`, `condition`, `shippingWeightLbs`, `productCategory` — see its own
  doc comment); `submitListing()` validates all of them are present (naming exactly
  what's missing, same as before) before building and posting the real feed body.
  - **v1 scope, deliberately narrow, same spirit as Shopify's single-variant-only
    scope**: GTIN only (no UPC/EAN/ISBN picker in the form yet, though the type allows
    them), `condition` fixed to `"New"` server-side (non-new conditions additionally
    need a main image URL this form doesn't collect).
  - **Genuinely asynchronous, unlike Shopify's flow**: `submitListing()` only proves
    Walmart *accepted* the feed for processing, not that the item was actually matched
    or ingested — the new `channel_listings` row lands as `listing_status = 'pending'`
    (a third state alongside Shopify's `'draft'`/`'active'`), and a manual "Check
    status" button on `/products` calls the new check-status route, which calls
    `getFeedStatus()` and resolves the row to `'active'` or `'error'` (with Walmart's
    own error message stored in `raw_payload`). Deliberately manual rather than an
    automatic poller — CLAUDE.md §4.4's rate-limited job queue is the right home for
    that eventually, but this is `getFeedStatus()`'s first real caller of any kind, and
    an unverified background-polling implementation isn't more trustworthy than an
    honest manual button until this has run against a real feed.
  - **No new migration**: `channel_listings.raw_payload` (already existed) stores
    `{feedId, submittedAt}` at submission and gets `{lastCheckedAt, error}` merged in on
    check — same "last-seen raw channel data, for debugging/replay" column CLAUDE.md
    §2.1 already documents, just repurposed for a pending outcome instead of a pulled
    listing's raw payload. `external_id`/`external_sku` are both set to the internal
    SKU submitted (Walmart's own numeric item id isn't obtainable from this flow — same
    "Walmart only knows its own SKU here" reasoning `pushInventory()` already
    documents), which is also what gives the row's uniqueness real teeth (Walmart
    itself doesn't allow duplicate-SKU offer submissions either).
  - **UNVERIFIED, same as the rest of this connector**: the `MP_ITEM_MATCH` feed
    envelope/field shapes were confirmed against a live fetch of
    developer.walmart.com's own doc page and literal JSON example (GTIN as
    `productIdType`, plain numeric `price`/`ShippingWeight` with no nested unit or
    currency object, pounds implied for `ShippingWeight`) — not against a real feed
    submission, since no Walmart sandbox/production credentials exist in this codebase.
    `UPC`/`EAN`/`ISBN` as `productIdType` values, and whether `productCategory` is
    validated against a fixed taxonomy, were not confirmed the same way and should be
    treated as unverified until tried for real.
- **Inventory API**: real-time single-item stock updates (`PUT /v3/inventory?sku=...`).
  Implemented as `WalmartConnector.pushInventory()` — like Amazon's Listings Items API,
  the interface's `productId` parameter must actually be the channel's own SKU
  (`channel_listings.external_sku`), not the internal `products.id`; the caller resolves
  that mapping before calling in.
- **Orders API**: `GET /v3/orders`, called once per ship-node type
  (`SellerFulfilled`/`WFSFulfilled`/`3PLFulfilled` — there's no "all fulfillment types"
  wildcard) and merged; acknowledge (`POST .../acknowledge`) then ship
  (`POST .../shipping`) as two sequential calls inside one `confirmShipment()`, since the
  interface has no reason to expose that two-step Walmart-specific sequence to callers.
  `TrackingInfo`'s single {carrier, trackingNumber, shippedAt} is applied to every line
  of a multi-line order — correct for the common single-package case, but can't
  represent a split/partial shipment; `TrackingInfo` would need a per-line shape to fix
  that properly.
- **Required header**: `WM_QOS.CORRELATION_ID` (a GUID generated per call) — mandatory
  for support escalations, built into `WalmartConnector`'s private `request()` wrapper
  globally (also sets `WM_SEC.ACCESS_TOKEN`, `WM_SVC.NAME`, and `WM_SANDBOX` when talking
  to the sandbox host), not per-call-site.

**UNVERIFIED IN ITS ENTIRETY**: unlike Amazon (proven against its SP-API sandbox) and
Shopify (proven against a real dev store), there is no self-serve Walmart sandbox to
register for — every request shape above is transcribed from developer.walmart.com, not
exercised against a live endpoint. Pure request/response mapping logic (`WalmartConnector`'s
own `normalizeWalmartOrder`/`normalizeWalmartOrderLine`/`mapShipNodeTypeToFulfillmentType`)
is unit-tested (`packages/channel-connectors/test/walmart-connector.test.ts`) — everything
past that boundary (`authenticate`, `pullOrders`, `pushInventory`, `submitListing`/
`getFeedStatus`, `confirmShipment`) stays a well-researched first draft until run against
real credentials, not a proven implementation, the same status Amazon carried before its
sandbox pass. `scripts/walmart-sandbox-smoke-test.ts` exists so that day is "run one
command," not "write a smoke test from scratch" — see `.env.example`'s `WALMART_SANDBOX_*`
entries for what it needs.

- **Wired into the app** (no new migration — reuses `channel_connections.lwa_client_id`/
  `encrypted_client_secret`, both already relaxed to nullable by migration `0019` for
  Shopify's sake, so a third channel's differently-shaped credential fits without a
  schema change): a Walmart row stores the tenant's own `clientId` in both
  `lwa_client_id` and `external_account_id` (no independent Walmart seller id this
  connector's calls need — reusing `clientId` keeps the table's
  `(tenant_id, channel, marketplace, external_account_id)` UNIQUE constraint meaningful,
  same as Amazon's), `encrypted_client_secret` holds the pgcrypto-encrypted secret, and
  `marketplace` is always `''` (same "no per-region concept" reasoning as Shopify's own
  row). Like Shopify, no OAuth redirect: `/settings/channels` has a plain "Connect
  Walmart" form (Client ID + Client secret, both required every submission — no
  "leave blank to keep the existing secret" the way Shopify's optional webhook field
  allows) that POSTs to `/api/channels/walmart/connect`, which calls
  `WalmartConnector.authenticate()` live (a real `client_credentials` token exchange) to
  reject a bad pair before persisting anything, then encrypts and upserts the row —
  always against `WALMART_PRODUCTION_BASE_URL`, never this repo's internal sandbox host,
  since a real tenant is connecting their real seller account.
  `createWalmartConnectorFromChannelConnection(pool, tenantId)` mirrors
  `createShopifyConnectorFromChannelConnection` exactly for resolving a tenant's stored
  credentials back into a live connector. The scheduler
  (`packages/scheduler/src/{index,cron-runner}.ts`) runs a Walmart order-sync pass in
  parallel to Amazon's and Shopify's — `syncWalmartOrders`/`runWalmartOrderSyncJob`/
  `startWalmartOrderSyncScheduler`, a separate node-cron task and separate
  `scripts/walmart-order-sync-{job,scheduler}.ts` entrypoints, kept parallel rather than
  merged for the same "not enough shared shape yet, three channels each want their own
  distinguishable log event" reasoning `syncShopifyOrders`'s own doc comment gives. What
  actually triggers a sync on this app's Vercel deployment is
  `GET /api/cron/walmart-order-sync` (mirrors the other two cron routes exactly — same
  `CRON_SECRET` Bearer-token gate, same idempotency contract) plus its `crons` entry in
  `vercel.json` (`30 5 * * *`, staggered 30 minutes after Shopify's own order-sync cron).
  `WarehouseService.confirmShipment()` dispatches to
  `createWalmartConnectorFromChannelConnection` on `order.channel === "walmart"`,
  alongside its existing Amazon and Shopify branches. No automatic catalog sync exists
  for Walmart yet (unlike Shopify's `syncShopifyCatalog`) — onboarding a Walmart SKU
  today still means `scripts/add-channel-listing.ts` by hand.

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

Channel #4 (eBay, §4.6) does NOT implement this interface — not even partially the way
Amazon/Shopify do (both still implement `authenticate`/`pullOrders`/`pushInventory`/
`confirmShipment` for real, just not `submitListing`/`getFeedStatus`). `EbayConnector`
now DOES have a listing-creation method (`createListing()`, §4.6's own "Outbound
listing creation" paragraph) — same synchronous-write reasoning as Amazon's/Shopify's
own `createListing()`, so it's a separate connector-specific method too, not the shared
`submitListing`/`getFeedStatus` pair.

### 4.4 Handling API rate limits (critical — causes most production incidents)

- Central **rate-limited job queue** per tenant, per marketplace, per endpoint —
  token-bucket algorithm.
- **Priority lanes**: order-status writes > inventory writes > bulk catalog syncs —
  never let a bulk job starve a time-sensitive order update.
- **Exponential backoff + circuit breaker per channel connection — built**, but
  deliberately NOT the literal BullMQ+Redis token-bucket queue the top bullet above
  still names as the aspirational v2+ shape. This app runs on Vercel Hobby with no
  persistent process and no Redis anywhere in the stack (confirmed by grep before
  building this) — a central job queue would mean standing up brand-new paid infra
  for a single self-testing tenant, for a problem this codebase hasn't hit yet at
  real scale. What's built instead is the two-tier split that actually fits a
  stateless serverless function:
  - **In-process** (`packages/channel-connectors/src/retry.ts`'s `fetchWithBackoff`,
    a drop-in `fetch()` replacement wired into every outbound call Amazon's six call
    sites, Walmart's `request()`, and Shopify's `graphql()` make): full-jitter
    exponential backoff (AWS's recommended formula) across up to 4 attempts total,
    honoring a response's `Retry-After` header when it exceeds the computed delay.
    Deliberately capped short (max ~4s of backoff) — a Vercel function has its own
    tight execution-time budget (10s on Hobby), so sleeping out a long real-world
    rate-limit window inside one invocation risks the function itself timing out
    before ever reaching the give-up path. Still-retryable after every attempt
    throws `RateLimitExhaustedError` (carrying the last status and any
    `Retry-After`, in ms) instead of handing back a bad response — every other
    outcome (success, or a non-retryable status like 400/403) is byte-for-byte
    identical to plain `fetch()`, so no connector's own response handling changed.
  - **Cross-run** (`migrations/0024_channel_connections_rate_limited_until.sql`,
    `packages/scheduler/src/index.ts`'s `recordRateLimitTrip()`/
    `RATE_LIMIT_COOLDOWN_MS`): when a `syncXTenant()`/`syncShopifyCatalogForTenant()`
    catch block sees a `RateLimitExhaustedError`, it stamps
    `channel_connections.rate_limited_until` at least 15 minutes out (or the
    marketplace's own longer `Retry-After`, if given) — a fixed cooldown, not
    exponential, since the cadence this sits inside (a cron tick, not a tight retry
    loop) is already coarse enough that exponential backoff has nothing to bite on.
    Every discovery query (`syncAmazonOrders`/`syncShopifyOrders`/
    `syncWalmartOrders`/`syncShopifyCatalog`) now filters
    `rate_limited_until IS NULL OR rate_limited_until <= now()`, so a throttled
    connection sits out entirely instead of being retried into the same throttle on
    the next tick. Deliberately independent of `consecutive_failures`/`status =
    'error'` (see below) — being rate-limited isn't evidence the connection itself
    is dead, so it never risks flipping a healthy tenant to `error`.
    `recordSyncSuccess()` clears `rate_limited_until` on a demonstrated success
    rather than making the tenant wait out a cooldown that's already been proven
    unnecessary. Same `[ALERT]`-tagged log-based alerting as the failure-tracking
    below, plus a Sentry event (§13; no email/Slack infra exists beyond that).
    Tested against a real local Postgres in
    `packages/channel-connectors/test/retry.test.ts` (in-process backoff, injectable
    `sleep`, no real timers) and `packages/scheduler/test/rate-limit-cooldown.test.ts`
    (the DB write and the discovery-query filtering).
- **Idempotency keys** on every write and every event handler — both Amazon and
  Walmart will redeliver; handlers must be safe to run twice.
- **Cross-run sync failure tracking/alerting — built** (`migrations/
  0021_channel_connections_failure_tracking.sql`, `packages/scheduler/src/index.ts`'s
  `recordSyncFailure()`/`recordSyncSuccess()`): `channel_connections` now carries
  `consecutive_failures`/`last_failure_at`/`last_failure_message`. Every failed
  order-sync run for Amazon/Shopify/Walmart increments the counter and stamps the
  timestamp/message; a successful run resets the counter to 0 (but deliberately
  leaves the last-failure timestamp/message in place — a resolved incident stays
  visible in `/settings/channels` rather than being erased). Three consecutive
  failures flips `status` from `active` to `error` in the same statement, which
  also self-removes that connection from every sync job's `WHERE status = 'active'`
  discovery query — a dead connection stops being retried on every cron tick
  instead of failing forever with only a log line each time. A single
  `[ALERT]`-tagged `console.error` fires exactly once, on the run that crosses the
  threshold — log-based, and (as of §13) also a Sentry event via `captureAlert()`;
  no email/Slack/notification infra exists beyond that. Recovery is manual today: the tenant
  reconnects via `/settings/channels`, which re-verifies live before writing
  `status = 'active'` again; nothing auto-retries an `error` row. Deliberately NOT
  wired into `syncShopifyCatalogForTenant` — catalog sync and order sync are
  different operations sharing one `channel_connections` row, and a catalog-only
  failure (e.g. a GraphQL schema quirk) shouldn't be able to flip a tenant to
  `error` and cut off order sync, which may be working fine; that gap stays open,
  flagged in that function's own comment.

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
- **Still not implemented for Shopify specifically**: the shared `ChannelConnector.
  submitListing`/`getFeedStatus` interface itself — `NormalizedListing` still lacks the
  fields Shopify's product-creation mutations require (title, at least one variant),
  and nothing forces `createListing()` (see the new paragraph below) into that
  async-feed shape, the same reasoning `pullProductCatalog()` already used. That's a
  deliberate, permanent split, not a gap: Shopify's `productSet` mutation is
  synchronous and doesn't fit submit-then-poll at all. Walmart's own outbound path
  (below, in §4.2) DOES now implement the shared interface for real — see that
  section's "Outbound listing creation" paragraph. Amazon also has an outbound
  listing-creation path now (`AmazonConnector.createListing()`, §4.1's own "Outbound
  listing creation" paragraph) but, like Shopify's, it's a separate non-interface
  method too, not the shared interface — its underlying write is synchronous, same
  reasoning as Shopify's. `subscribeToEvents` is still a deliberate no-op on the
  connector itself — real-time webhooks are wired in as
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
  - **Out-of-order `orders/cancelled` gap — built, narrowed not fully closed**
    (migration `0025_early_channel_cancellations.sql`): an `orders/cancelled` delivery
    that arrives before the corresponding order has ever been created locally
    (out-of-order delivery, or a tenant enabling webhooks after an order was already
    placed *and* cancelled on Shopify) used to just be logged and dropped, letting a
    later cron/`orders/create` delivery insert the order as normal and allocate real
    stock against it as if it were never cancelled. Now stages the cancellation in
    `early_channel_cancellations` (keyed like `orders`' own `(tenant_id, channel,
    external_order_id)` uniqueness), and `OrderService.persistPulledOrders()` — the
    shared insert path both the webhook's `orders/create` handler and the cron pull go
    through — deletes-and-consumes the matching row the instant it inserts that order
    for the first time, landing it straight in `'cancelled'` instead of walking it
    through validate/allocate. Closes the common sequential-arrival case (either
    order); a genuine race between two *concurrent* deliveries is still possible and
    isn't what this closes — documented in both call sites' own doc comments.
  - **Confirmed against a real dev store**: registration succeeded 3/3 topics from the
    `/settings/channels` "Connect Shopify" flow, and the full round trip was proven — a
    genuinely new order placed after registration reached `POST /api/webhooks/shopify`
    and appeared in `/orders` within seconds, no cron involved. One real incident this
    surfaced along the way: an order for a product with no `channel_listings` mapping
    (a store demo product that had never been onboarded) correctly failed loudly and
    rolled back rather than silently persisting a broken order — expected behavior per
    `insertOrderLines`'s own doc comment, not a webhook-specific bug, but the first time
    it was actually hit in practice. Still unverified: whether a *repeat* registration
    for an already-subscribed topic+uri is a no-op or a rejected `userError` — the live
    test above only ever registered once per tenant.
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

### 4.6 eBay Sell APIs (channel #4 — built once the connector abstraction had proven itself)

- **Why now**: CLAUDE.md §8 Phase 5's roadmap lists eBay/TikTok Shop/additional channels
  as later "scale features," but by the time this was picked up, the connector
  abstraction had already been proven against three structurally different APIs
  (Shopify's synchronous/event-driven shape, Walmart's feed/poll-heavy shape, Amazon's
  SP-API-sandbox-and-Listings-Items shape) — a natural next expansion rather than
  something that needed to wait for the rest of Phase 5.
- **Auth**: a real OAuth Authorization Code Grant + long-lived refresh token — the
  closest of the three existing channels to Amazon's own shape, not Walmart's
  `client_credentials` pair (no user consent, no refresh token at all). Confirmed
  request/response shapes (`POST /identity/v1/oauth2/token`, HTTP Basic
  `client_id:client_secret`, `grant_type=authorization_code` or `refresh_token`, and the
  literal example JSON response) from developer.ebay.com's own doc page, fetched live.
  The authorize-redirect URL (`GET https://auth.ebay.com/oauth2/authorize` or
  `auth.sandbox.ebay.com`, params `client_id`/`redirect_uri`/`response_type=code`/
  `scope`/`state`) is confirmed the same way. The callback's own query params
  (`code`/`state` on success) are standard OAuth2 (RFC 6749 §4.1.2), NOT confirmed
  against a literal official eBay example the way everything else in this auth flow is
  — every official doc page fetched described the token exchange without ever showing
  the actual redirect URL eBay sends back; see `ebay-oauth.ts`'s own header comment.
  Implemented in `packages/channel-connectors/src/ebay-oauth.ts`
  (`buildEbayAuthorizeUrl`/`parseEbayOAuthCallback`/`exchangeEbayAuthorizationCode`,
  mirroring `amazon-oauth.ts`'s shape) and `ebay-connector.ts`'s own `authenticate()`
  (refresh-token exchange, mirroring `AmazonConnector.authenticate()`'s caching).
- **Fulfillment API**: `GET /sell/fulfillment/v1/order` pulls orders,
  `filter=creationdate:[<since>..]` for the since-cursor (confirmed literal filter
  syntax from developers.ebay.com's discovering-unfulfilled-orders.html static guide),
  `limit=200` with **no pagination beyond the first page** — a real, documented gap
  (the response's own `next`/`href` fields aren't followed), not a theoretical one.
  `lineItemCost` is the line's **total**, not a per-unit price (confirmed via the
  type's own field description: "calculated by multiplying the single unit price by
  the number of units purchased") — `normalizeEbayOrderLine()` divides by `quantity`
  to get `unitPrice`. `sku` isn't always populated on a real line item (a real
  community-fetched example response had none) — falls back to `legacyItemId`, then
  `lineItemId`. No eBay analog of Amazon's AFN/Walmart's WFS exists in this codebase's
  `FulfillmentType` union, so every eBay line maps to `seller_fulfilled`.
- **Inventory API — `pushInventory()` narrower than Amazon's/Walmart's own**: eBay's own
  docs state quantity "must be updated at both the inventory item and offer level" for
  a live listing's displayed quantity to actually change — the offer-level half needs
  an `offerId` this codebase has no onboarding flow to ever capture (see the listing-
  creation bullet below), so `EbayConnector.pushInventory()` only does the
  inventory-item half (`GET` then `PUT /sell/inventory/v1/inventory_item/{sku}`,
  merging only `availability.shipToLocationAvailability.quantity` into whatever's
  already there rather than constructing a full replace body from scratch, since this
  codebase has no confirmed-against-a-literal-example shape for the `product`/
  `condition`/`packageWeightAndSize` fields a from-scratch body would need). A SKU with
  an existing published offer may not show the new quantity live on eBay even though
  this call succeeds — a real, documented narrowing, same spirit as Amazon's/Walmart's
  own "MFN/DEFAULT fulfillment channel only" `pushInventory()` scope.
- **`confirmShipment()`**: `GET` the order for its line items, then
  `POST /sell/fulfillment/v1/order/{orderId}/shipping_fulfillment` — endpoint pattern
  and body field names (`lineItems`, `shippedDate`, `shipmentTrackingNumber`,
  `shippingCarrierCode`) confirmed from developer.ebay.com's fulfillment overview page,
  in prose rather than a literal rendered example (unlike Amazon's/Walmart's own
  confirmShipment() bodies). `shippingCarrierCode` is set directly from
  `tracking.carrier` with **no mapping/validation against eBay's own carrier-code
  enum** — unlike Amazon's confirmShipment(), which deliberately uses the
  always-valid `'Other'` + carrierName combination, no equivalent always-valid
  fallback was confirmed for eBay this pass, so an arbitrary carrier string may be
  rejected by eBay's own enum validation. Single-fulfillment assumption (every line
  ships together, same tracking info applied to all) — same documented limitation
  Amazon's/Walmart's own confirmShipment() carry.
- **Outbound listing creation — built, closing the prerequisite gap this section used
  to flag as out of scope entirely** (`EbayConnector.createListing()`,
  `fetchBusinessPolicies()`, `createMerchantLocation()`, migration
  `0026_channel_connections_ebay_selling_setup.sql`, three new routes under
  `/api/channels/ebay/{business-policies,location,listings}`, `/settings/channels`'
  new "Selling setup" sub-section, `/products` page): eBay's own three-step Inventory
  API flow (`createOrReplaceInventoryItem` → `createOffer` → `publishOffer`, confirmed
  via developer.ebay.com's own direct quote: "All three policies are required to
  publish offers and create active listings through the Inventory API") needs
  tenant-level business policies (fulfillment/payment/return) and a merchant location
  before it can succeed — this pass builds both prerequisites, split into two pieces
  with deliberately different scope:
  - **Business policies — fetch-existing only, never create**: `fetchBusinessPolicies()`
    calls `GET /sell/account/v1/{fulfillment,payment,return}_policy?marketplace_id=EBAY_US`
    (a new least-privilege `sell.account.readonly` scope added to
    `EBAY_OAUTH_SCOPES` — note a refresh token issued before this scope existed is NOT
    retroactively granted it; that tenant would need to reconnect, not a live issue
    since no real eBay connection has ever existed against this codebase) to populate
    three `<select>` pickers on `/settings/channels`; the tenant's choice is just
    persisted (`POST /api/channels/ebay/business-policies`) to three new
    `channel_connections` columns. This codebase will never call eBay's own
    `createFulfillmentPolicy`/`createPaymentPolicy`/`createReturnPolicy` endpoints —
    each has its own large required-field surface (handling time, payment methods,
    return window, category-specific overrides) that would be its own separate
    onboarding flow, a strictly bigger scope than the merchant location below (which IS
    built in full). Response wrapper field names
    (`fulfillmentPolicies`/`paymentPolicies`/`returnPolicies`, each entry with
    `<x>PolicyId`/`name`) were inferred from eBay's own consistent REST pluralization
    convention, not confirmed against a literal rendered JSON example — documented as
    such in `fetchBusinessPolicies()`'s own comment.
  - **Merchant location — built in full**, since it's just an address:
    `createMerchantLocation()` calls `POST /sell/inventory/v1/location/{merchantLocationKey}`
    (204 No Content on success; requires `location.address` with either
    city+stateOrProvince+country or postalCode+country, confirmed via community-
    generated PHP client docs since the official page rendered thin). The
    `merchantLocationKey` itself (max 36 chars per eBay's own docs) is auto-derived
    server-side as the tenant id with dashes stripped (32 chars), not collected from
    the tenant — one location per tenant for v1, matching `channel_connections`' own
    one-eBay-connection-per-tenant assumption.
  - **Per-listing form fields narrowed the same way Walmart's `productCategory` already
    is**: `categoryId` and `imageUrl` are plain, unvalidated, tenant-supplied fields on
    the `/products` per-listing form — no eBay Taxonomy API integration (category
    lookup) and no image-hosting feature exist or are built here.
    `marketplaceId`/`format`/currency/`condition` are hardcoded server-side to
    `"EBAY_US"`/`"FIXED_PRICE"`/USD/`"NEW"`, matching the established
    USD/new-condition-only v1 scope every other channel's own outbound listing path
    already uses.
  - `EbayConnector.createListing()` fails fast (no network call) if any of the four
    credential fields (three policy ids + merchant location key) is missing — the
    `/products` page only renders the listing form once `hasEbaySellingSetup` is true,
    so this is a defense-in-depth guard, not the primary UX.
  - `channel_listings` row lands as `listing_status = 'active'` immediately (no
    `'pending'` state) — like Amazon's/Shopify's own synchronous
    `createListing()` methods, the outcome (a real eBay `listingId`) comes back in the
    same call, nothing to poll for.
  - **UNVERIFIED, same status as the rest of this connector**: this environment's
    network block on `api.ebay.com`/`api.sandbox.ebay.com` (§4.6's own opening
    paragraph) means none of `fetchBusinessPolicies()`/`createMerchantLocation()`/
    `createListing()` has been exercised against live infrastructure — only the two new
    pure body-building functions (`buildEbayInventoryItemBody`/`buildEbayOfferBody`) are
    unit-tested (`packages/channel-connectors/test/ebay-connector.test.ts`, 30 tests).
- **Wired into the app** (no new migration — reuses the same `channel_connections`
  columns Amazon's own row already uses: `lwa_client_id` for the OAuth client id,
  `encrypted_client_secret`/`encrypted_refresh_token` for the real refresh-token pair,
  `marketplace = ''` since no per-region concept was confirmed anywhere on the Order
  type, `external_account_id` reusing the tenant's own `clientId` since eBay's REST
  APIs identify the seller purely from the access token — no independent seller id
  ever comes back on the callback the way Amazon's `selling_partner_id` does, same
  reuse-`clientId` pattern Walmart's own connect route already established for an
  identical reason): `/settings/channels` has a "Connect eBay" OAuth link (mirroring
  Amazon's own "Connect Amazon" redirect exactly) that hits
  `/api/channels/ebay/connect` → eBay's consent screen → `/api/channels/ebay/callback`,
  which verifies the signed CSRF `state` token (`packages/web/src/lib/ebay-oauth-state.ts`
  — a near-literal fork of `amazon-oauth-state.ts` with its own
  `EBAY_OAUTH_STATE_SECRET`, deliberately not shared, same "each channel gets its own
  distinguishable secret" reasoning the scheduler's own per-channel functions already
  follow), exchanges the code, and upserts the row. The scheduler
  (`packages/scheduler/src/{index,cron-runner}.ts`) runs an eBay order-sync pass in
  parallel to the other three — `syncEbayOrders`/`runEbayOrderSyncJob`/
  `startEbayOrderSyncScheduler`, a separate node-cron task and separate
  `scripts/ebay-order-sync-{job,scheduler}.ts` entrypoints. What actually triggers a
  sync on this app's Vercel deployment is `GET /api/cron/ebay-order-sync` (same
  `CRON_SECRET` Bearer-token gate, same idempotency contract as the other three cron
  routes) plus its `crons` entry in `vercel.json` (`0 6 * * *`, staggered 30 minutes
  after Walmart's own order-sync cron). `WarehouseService.confirmShipment()` dispatches
  to `createEbayConnectorFromChannelConnection` on `order.channel === "ebay"`,
  alongside the other three branches. `recordSyncFailure`/`recordSyncSuccess`/
  `recordRateLimitTrip`'s `channel` parameter type was widened to include `"ebay"`.
- **UNVERIFIED IN ITS ENTIRETY, more so than any other channel in this codebase**: this
  environment's outbound network policy blocks **both** `api.ebay.com` and
  `api.sandbox.ebay.com` entirely (confirmed directly — a token-exchange `curl` to each
  host was rejected at the proxy level, the same class of block already documented for
  `api.amazon.com`), on top of there being no eBay sandbox/production credentials
  anywhere in this codebase yet (same "no self-serve sandbox" starting position
  Walmart's connector carried, see `.env.example`'s `EBAY_SANDBOX_*` entries). So
  nothing eBay-related has been exercised against live infrastructure of any kind, not
  even once — unlike Amazon (proven against its SP-API sandbox) or Shopify (proven
  against a real dev store), and even more unverified than Walmart's own wiring (which
  at least confirmed its single most important request shape against one official doc
  page's literal rendered JSON example). Several of this connector's own shapes were
  cross-confirmed across multiple independent sources (official doc pages, a real
  OpenAPI spec file mirror on GitHub, and community-written generated API-client docs)
  specifically because individual eBay doc pages fetched during this pass were
  frequently thin/templated and didn't render literal examples the way Amazon's/
  Walmart's better-preserved pages did — see each method's own doc comment in
  `packages/channel-connectors/src/ebay-connector.ts` for exactly what was confirmed
  where. Pure request/response mapping logic (`normalizeEbayOrder`/
  `normalizeEbayOrderLine`, plus `ebay-oauth.ts`'s URL-building/parsing) is unit-tested
  (`packages/channel-connectors/test/ebay-connector.test.ts`) — everything past that
  boundary (`authenticate`, `pullOrders`, `pushInventory`, `confirmShipment`, the OAuth
  token exchange) stays a well-researched first draft until run against real
  credentials, exactly the status Amazon and Walmart each carried before their own
  first live pass.

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
| Observability | Sentry — **built**, see §13 | You *will* need to debug "why did SKU X oversell at 3am" |

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
- **Phase 4 — Operational maturity (Months 7-9)**: reporting/analytics — **first pass
  built** (`/reports`, `packages/web/src/app/(app)/reports/page.tsx`): sales by
  channel and top SKUs by revenue (both period-selectable, default 30 days, excludes
  cancelled orders), a returns summary (total vs. restocked-sellable, using the
  returns handling below), and a live inventory snapshot (units on hand/reserved/
  available tenant-wide, plus an out-of-stock/oversold list) — plain queries against
  the existing transactional tables, deliberately not the separate CDC-fed
  read-optimized store this section used to describe as the only shape (see that
  page's own doc comment for the "start simple" reasoning, same call already made for
  the event bus and job queue). No dollar inventory-value figure — this schema has no
  cost/COGS column, only sale price, so a $ "stock value" would silently misrepresent
  one as the other; units only. The real CDC-fed store is still open, see the item
  below. Multi-warehouse/3PL support: the ledger-level piece (moving stock
  between two locations, §2.2's "Multi-location transfers") and the
  locations-management UI (`/locations` — create + rename a warehouse/3pl/fba/wfs
  location; no delete, `type` fixed after creation, see that page's own doc
  comment) are now built. **Stock-aware multi-warehouse allocation — built**:
  `OrderService.allocateOrder()` (`packages/order-service/src/index.ts`) no longer
  checks only one location and backorders the instant it's short — it now tries
  every one of the tenant's warehouse locations, in priority order
  (`orders.preferred_location_id` first if a routing rule set one, same
  fail-loudly-if-it-doesn't-resolve behavior as before; then every other
  warehouse oldest-created-first), and allocates the whole order against the
  first candidate with enough stock for every line. An order still never splits
  across locations — it allocates entirely against one chosen location, just a
  better-chosen one. Concurrency-safe: every (location, product) row this order
  might touch, across ALL candidates, is locked (`SELECT ... FOR UPDATE`) in one
  GLOBAL order (by `location_id` then `product_id` — not this order's own
  priority order) before any location is chosen, specifically because two
  concurrent orders can have opposite location preferences with overlapping
  products, and locking in each order's own priority order could deadlock them
  against each other (`packages/order-service/test/multi-warehouse-allocation.test.ts`,
  plus the existing `allocation-concurrency.test.ts` "exactly 1 of 10" test still
  passes unchanged). Two related, larger gaps remain explicitly open and were not
  part of this change: nearest/cheapest-location-by-shipping-address routing (no
  schema support at all yet) and per-SKU rule-based routing (blocked upstream —
  `OrderReceivedPayload` carries no line-item data). Per-location fulfillment
  routing beyond what the rules engine's `route_to_warehouse` action already does
  is otherwise still open. Returns handling — **built**, see §2.2/§3. Rate-limit
  hardening, circuit breakers — **built**, see §4.4. Observability dashboards —
  **built**, see §13: Sentry is wired end-to-end across packages/web and every
  backend job/scheduler script, with every DSN left unset — no real Sentry account
  exists yet, so this is wired-and-ready, not proven against a live account (same
  "wire it now, verify later" status Amazon's/Walmart's/eBay's own credentials
  carried before their first live pass). The `[ALERT]`-tagged log lines §4.4
  describes now also fire a Sentry event alongside the log line, not instead of it.
  - Open question for Arif: given the widened volume ceiling (§0: up to 50,000
    orders/month), whether the CDC-fed reporting store is worth moving earlier than
    Phase 4 — not a change to the phase order itself, just worth deciding deliberately
    rather than by default. The `/reports` first pass above doesn't resolve this
    either way — it's cheap enough at today's volume that the decision can still wait.
- **Phase 5 — Scale features (Months 9-12+)**: eBay — built ahead of the rest of this
  phase, see §4.6 — /TikTok Shop/additional channels. Stock forecasting. B2B portal (if
  pursuing Cin7-style ERP breadth). SOC 2 prep if
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

## 13. Observability (Sentry — §5/§8 Phase 4's "Observability dashboards")

- **Why Sentry, not Datadog/Grafana+Prometheus**: hosted SaaS needing no new infra on
  this app's Vercel Hobby plan (no Redis/Kafka-class dependency either, same
  "don't stand up paid infra a single self-testing tenant hasn't earned yet" call
  §4.4 already makes for BullMQ), and it directly matches §5/§11's own "why did SKU X
  oversell at 3am" debugging story — a real stack trace plus tenant/order context
  beats grepping a log line.
- **Every DSN left unset in `.env.example`, deliberately** — same "wire it now, verify
  against a real account later" pattern as every marketplace connector's own
  credentials in this codebase. `Sentry.init()` with no `dsn` is a confirmed,
  documented no-op in the installed SDK itself (`@sentry/core`'s client logs a
  debug-only "No DSN provided, client will not send events" and never constructs a
  transport) — the app behaves identically with or without a real Sentry account
  connected, and every capture call below stays inert until one exists.
- **`packages/web` (Next.js, `@sentry/nextjs`)** — this version (10.74.0) confirmed
  against the actually-installed package's own source
  (`node_modules/@sentry/nextjs/build/cjs/config/webpack.js` and
  `config/turbopack/generateValueInjectionRules.js`), not assumed from training data,
  since this app pins Next.js 16.3.3 (`packages/web/AGENTS.md`'s own "this is NOT the
  Next.js you know" warning) and this app builds with **Turbopack**
  (`next build` prints `(Turbopack)`) — several older Sentry+Next.js conventions are
  confirmed broken or deprecated under this exact combination, not just superseded:
  - `src/instrumentation.ts`'s `register()` calls `Sentry.init()` directly (branching
    on `NEXT_RUNTIME` for `nodejs`/`edge`), and exports `onRequestError =
    Sentry.captureRequestError` — putting `Sentry.init()` in a separate
    `sentry.server.config.ts`/`sentry.edge.config.ts` file instead is explicitly
    flagged by the installed SDK as needing to move into `register()`.
  - `src/instrumentation-client.ts` (the Next.js 15.3+ file convention, confirmed via
    `node_modules/next/dist/docs/.../instrumentation-client.md`) holds the client-side
    `Sentry.init()` — **not** the older `sentry.client.config.ts`, which the installed
    SDK explicitly warns "will no longer work" under Turbopack. Also exports
    `onRouterTransitionStart = Sentry.captureRouterTransitionStart`, a required hook
    for navigation instrumentation surfaced as an "ACTION REQUIRED" build warning on
    the first real build against this SDK version, fixed immediately rather than left
    as a warning.
  - `next.config.mjs` wraps its config with `withSentryConfig` imported from the
    `@sentry/nextjs/config` subpath (not the package root — the root import path
    triggered a real deprecation warning on the first build against 10.74.0, fixed
    immediately per `AGENTS.md`'s "heed deprecation notices"). `org`/`project`/
    `authToken` are left unset (read from `SENTRY_ORG`/`SENTRY_PROJECT`/
    `SENTRY_AUTH_TOKEN` when present) — build-time source-map upload silently skips
    itself without them, same no-op-until-configured shape as the DSN.
  - Two Vercel Cron routes' worth of caveat: every `GET /api/cron/*-order-sync` route
    runs inside this same Next.js server process, so it's already covered by this
    wiring — it does not need its own separate `@alltix/shared` observability call.
- **Non-web packages (`@alltix/shared/src/observability.ts`, plain `@sentry/node`)** —
  the scheduler's node-cron scripts and the one-shot job scripts under `/scripts` run
  outside Next.js entirely, so they can't use `@sentry/nextjs`'s file conventions.
  `initObservability(service)` (idempotent, tags every event with a `service` string
  like `"scheduler:ebay"` so one shared Sentry project can still tell channels/
  processes apart), `captureAlert(message, extra)`, `captureError(error, extra)`, and
  `flushObservability(timeoutMs)` (awaited in every one-shot job script's top-level
  `main().catch()` before the process exits — `Sentry.captureException`/
  `captureMessage` enqueue for async delivery, they don't send synchronously, so a
  short-lived script that exits right after a capture can drop the event entirely
  without this).
  - **Deliberately narrow scope, not a blanket `console.error` hook**: `@sentry/node`
    ships `captureConsoleIntegration` for exactly that, and it was considered and
    rejected — §4.4's own `recordSyncFailure()`/`recordRateLimitTrip()` doc comments
    are explicit that only the `[ALERT]`-tagged lines are meant to page anyone; the
    per-tenant/per-run `console.error` calls alongside them are intentionally
    non-alerting (a single tenant's transient failure, tolerated and logged, not
    incident-worthy until it crosses `CONSECUTIVE_FAILURE_ERROR_THRESHOLD`). A blanket
    hook would silently erase that distinction and flood Sentry with noise on the
    first transient failure of any tenant, any channel. `captureAlert()`/
    `captureError()` are called explicitly only at: the two `[ALERT]`-tagged lines in
    `packages/scheduler/src/index.ts` (`recordSyncFailure`/`recordRateLimitTrip`), and
    `packages/scheduler/src/cron-runner.ts`'s four `runXOnceWithRetry` functions' final
    `!willRetry` branch (a whole sync job exhausting every retry — a materially
    different, rarer signal than one attempt's transient failure).
- **UNVERIFIED, same status every other external integration in this codebase carried
  before its first live pass**: no real Sentry account/project has ever been created,
  so no event from this wiring has ever actually been seen in a Sentry dashboard —
  only confirmed to build cleanly (`next build`, zero Sentry warnings after the two
  fixes above) and to run cleanly with `SENTRY_DSN` unset (the full test suite,
  including the `[ALERT]`-tagged `recordSyncFailure`/`recordRateLimitTrip` tests,
  passes unchanged). Creating a real project and setting the DSNs in `.env.example`'s
  Observability section is the remaining step before this is proven, not built.

---

*This document reflects standard, well-documented patterns for multichannel OMS/IMS
platforms plus the publicly documented behavior of the Amazon SP-API and Walmart
Marketplace API — not the proprietary internals of any specific vendor.*
