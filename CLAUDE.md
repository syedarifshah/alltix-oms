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
- **HR & Payroll — Arif's explicit pick, "add HR & payroll"**: a module inside
  alltix-oms, for tenants — not a separate product. Scope locked to three layers:
  (1) employee directory + time tracking, no wage math — built; (2) gross wage
  calculation (hours × rate), no tax withholding — built; (3) a real
  payroll-processor integration — vendor picked (**Check**, an embedded-payroll API
  provider — see §14.1), but NOT built yet: blocked on Arif getting a real quote/
  sandbox API key from Check's sales team (no vendor in this space publishes
  self-serve pricing). See §14/§14.1.

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

**Update — the OAuth flow above has now actually been run against a real seller in
production** (seller `A2P6SIBC86NP1T`, connected via the real redirect flow, not
`seed-test-channel-connection.ts`), which means the app was in fact published/
authorized enough for a real consent screen to work — the "cannot be proven until
run against a real seller account" framing immediately below is now stale for that
one bullet specifically, left in place with this note rather than silently rewritten,
since **that same real connection immediately surfaced a real production bug**:

- **PRODUCTION INCIDENT, found and fixed**: order sync for that real seller failed
  with `SP-API orders failed: 403 Unauthorized: Access to requested resource is
  denied` on every attempt (`/settings/channels` showed "Last order sync: never
  synced yet"). Root cause: `createAmazonConnectorFromChannelConnection()` — called
  by the scheduler, `WarehouseService.confirmShipment`, and the listings route alike
  — always defaulted `baseUrl`/`marketplaceIds` to the **sandbox** host and
  marketplace id, regardless of what the connection's own stored `marketplace`
  region said. That was invisible as long as only sandbox-seeded connections
  existed; once a real seller connected (storing a real refresh token and region,
  e.g. `"NA"`, via the OAuth callback), every scheduled sync kept sending that real
  production access token to the *sandbox* host — which Amazon correctly rejects,
  producing exactly this 403 (LWA authentication itself was never the problem; the
  token exchange succeeds, the subsequent `GetOrders` call against the wrong host
  is what's denied). **Fixed**: that function now resolves a real production host
  from the connection's stored region (only when the caller doesn't explicitly
  override `baseUrl`/`marketplaceIds`, so nothing sandbox-backed changed) and
  discovers the seller's real, current marketplace id(s) live via
  `getMarketplaceParticipations()` — filtered to `isParticipating` — rather than
  guessing one, since a single NA-region seller could be provisioned for US, CA,
  MX, or BR. The stored region column only recognizes SP-API's three real regions
  (`NA`/`EU`/`FE`) as "this is production" — anything else (including the sandbox
  seed script's `'UK'` marker, and this app's own previous, wrong `"US"` default
  for `AMAZON_OAUTH_DEFAULT_MARKETPLACE`, now corrected to `"NA"` in
  `.env.example`) safely stays on the sandbox default rather than guessing a
  production host. See `isAmazonProductionRegion`/`resolveAmazonProductionBaseUrl`
  and `createAmazonConnectorFromChannelConnection`'s own doc comment in
  `amazon-connector.ts` for the full reasoning, and
  `packages/channel-connectors/test/amazon-connector.test.ts` for regression
  coverage of the region-allowlist logic itself. Not yet re-verified against that
  real seller's actual order data post-fix — that confirmation happens on the next
  scheduled sync (or a manual trigger) after this ships to production.

**Update — `createListing()` now confirmed against real SP-API sandbox
infrastructure** (`npm run amazon:create-listing-smoke-test`, NA sandbox host, same
one `pushInventory()`'s own sandbox pass already used): a real `PUT
requirements=LISTING_OFFER_ONLY` request against a fake sandbox ASIN/SKU succeeded
end to end — LWA auth, the `merchant_suggested_asin`/`condition_type`/
`purchasable_offer`/`fulfillment_availability` request shape, and a real HTTP success
response all confirmed live, on the first attempt (no bugs found this pass, unlike
eBay's own equivalent push — see §4.6). Same caveat `pushInventory()`'s own sandbox
pass already carries: the SP-API sandbox round-trips the request shape and an HTTP
success without persisting a real, queryable listing, so a live production
ASIN/account is still the only way to prove an actual listing goes publicly live —
not pursued this pass, since that would mean creating a real, purchasable Amazon
offer under the connected seller's real account, a materially different risk than a
disposable sandbox call.

**Still unverified until run against a real order in production**:

- `AmazonConnector.confirmShipment()` — the static sandbox has no matching test
  scenario for this operation on this account (confirmed across multiple attempts,
  including Amazon's own documented example values); see its doc comment in
  `packages/channel-connectors/src/amazon-connector.ts` for what was tried. Unlike
  `createListing()`, there's no safe sandbox-only way to close this gap — a genuine
  success path can only be proven against a real order that has actually shipped,
  which isn't something to fabricate for a test (falsely confirming shipment on an
  order that didn't really ship is a real customer-facing action, not a disposable
  sandbox call). This will verify itself organically the next time a real Amazon
  order ships through this app in production, rather than being a task to force.

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

Channel #5 (Temu, §4.7) also does NOT implement this interface, same shape as eBay's own
original build before `createListing()` existed — `authenticate`/`pullOrders`/
`pushInventory`/`confirmShipment` only, no `submitListing`/`getFeedStatus`/
`subscribeToEvents`, and (per Arif's own explicit scope decision) no outbound listing
creation at all this pass either.

Channel #6 (TikTok Shop, §4.8) is the same shape again — `authenticate`/`pullOrders`/
`pushInventory`/`confirmShipment` only, per Arif's own explicit "Full connector, like
eBay/Temu v1" scope decision.

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
    below, plus a Sentry event (§13). Deliberately does **not** email the tenant the
    way `recordSyncFailure()`'s threshold-crossing branch does (see the alerting
    paragraph below) — a rate-limit trip is self-healing and non-actionable, and
    `recordRateLimitTrip()`'s own doc comment explains why emailing it would just be
    inbox noise; `packages/scheduler/test/rate-limit-cooldown.test.ts` has a test
    proving this (fetch is asserted never called, even with `RESEND_API_KEY` set).
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
  threshold — log-based, and (as of §13) also a Sentry event via `captureAlert()`,
  and (as of the alerting paragraph below) a real email to the tenant's own users.
  Recovery is manual today: the tenant
  reconnects via `/settings/channels`, which re-verifies live before writing
  `status = 'active'` again; nothing auto-retries an `error` row. Deliberately NOT
  wired into `syncShopifyCatalogForTenant` — catalog sync and order sync are
  different operations sharing one `channel_connections` row, and a catalog-only
  failure (e.g. a GraphQL schema quirk) shouldn't be able to flip a tenant to
  `error` and cut off order sync, which may be working fine; that gap stays open,
  flagged in that function's own comment.
- **Alerting/notifications — built, closing the "no email/Slack/other notification
  infra exists" gap this section and §13 both used to flag** (`packages/shared/src/
  email.ts`'s `sendEmail()`, `packages/scheduler/src/index.ts`'s
  `notifyTenantUsers()`, `packages/scheduler/src/cron-runner.ts`'s
  `notifyPlatformOperator()`): real transactional email via
  [Resend](https://resend.com) (`RESEND_API_KEY`), extracted from the pre-existing
  demo-request-notification code (`packages/web/src/app/api/leads/demo-request/
  route.ts`, which now calls the same shared `sendEmail()` instead of its own
  duplicate fetch logic) rather than introducing a second, competing email
  integration. `sendEmail()` never throws and is a silent no-op with zero
  recipients or an unset `RESEND_API_KEY` — same "wire it now, verify against a
  real account later, inert until configured" pattern as Sentry's own DSN (§13).
  - **Two deliberately separate audiences, not one generic "send an alert"
    concept**: `notifyTenantUsers()` (called from `recordSyncFailure()`'s
    threshold-crossing branch, above) emails that tenant's own `users` rows — a
    per-tenant, actionable incident (their own channel connection died) with a
    real fix path (`/settings/channels`). `notifyPlatformOperator()` (called from
    every one of `cron-runner.ts`'s six `runXOnceWithRetry` functions'
    `!willRetry` branch, alongside their existing `captureError()` call) emails a
    fixed `PLATFORM_ALERT_EMAIL` address instead — a whole-job-failure incident
    (DB down, every credential rejected, an unhandled bug) has no single tenant
    responsible for it, so there's no tenant inbox to route it to. Deliberately
    reuses the `users` table as the tenant recipient list rather than adding a new
    notification-preferences schema — see `notifyTenantUsers()`'s own doc comment
    for why that's the right amount of schema for v1.
  - **`recordRateLimitTrip()` deliberately does NOT email the tenant** — see the
    rate-limit paragraph above; a rate-limit trip is self-healing and
    non-actionable, and emailing it would be alert fatigue, the same reasoning
    `observability.ts`'s own header comment already gives for rejecting a blanket
    `console.error`→Sentry hook.
  - **A real, production-affecting bug found writing this feature's own regression
    tests, not by manual review**: `notifyTenantUsers()`'s
    `SELECT DISTINCT email FROM users WHERE tenant_id = $1`, run inside
    `withTenant()` (sets only `app.tenant_id`), silently returned **zero rows
    against real RLS, every time, in every environment** — not a test artifact.
    `users`' only RLS policy before this (`self_lookup_users`, migration `0010`) is
    scoped by `app.clerk_user_id`, which `withTenant()` never sets by design; that
    migration's own comment had already flagged this exact gap ahead of time
    ("a future 'list my org's teammates' feature needs an additional policy branch
    scoped by app.tenant_id"). `sendEmail()`'s own empty-recipients guard made the
    zero-row result look like a harmless "no users to notify" no-op instead of the
    real bug it was — not one tenant alert email could ever have actually been
    delivered. **Fixed** by migration `0030_users_tenant_scoped_select_policy.sql`,
    adding exactly the additive, SELECT-only, tenant-scoped policy `0010`'s own
    comment described (Postgres RLS policies for the same command are OR'd
    together, so this doesn't touch or narrow the existing self-lookup policy).
    Regression-tested in `packages/scheduler/test/sync-failure-tracking.test.ts`'s
    new `notifyTenantUsers()` test — which is what caught this in the first place,
    against a real seeded `tenants`+`users` pair, not a mock.
  - Tested: `packages/shared/test/email.test.ts` (`sendEmail()` itself — no-op when
    unconfigured/no recipients, request shape, non-2xx/thrown-error swallowing, all
    via a stubbed `global.fetch`, no real Resend account); the new
    `notifyTenantUsers()` test in `sync-failure-tracking.test.ts` (recipients match
    the tenant's own seeded users, fires exactly once, not per-run or post-error);
    the no-tenant-email test in `rate-limit-cooldown.test.ts`; and
    `packages/scheduler/test/cron-runner-platform-alerts.test.ts`
    (`notifyPlatformOperator()`'s own no-op/success/retry-recovery/notify paths,
    driven through the exported `runXOnceWithRetry` functions via a
    deterministically-rejecting fake `adminPool` — no real Postgres needed for this
    one file, see its own header comment).
  - **UNVERIFIED against a real Resend account**, same status every other external
    integration in this codebase carried before its first live pass (§13) —
    `RESEND_API_KEY`/`ALERT_FROM_EMAIL`/`PLATFORM_ALERT_EMAIL` are all left unset in
    `.env.example`, so this is wired-and-ready, not proven against real delivery.

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
  - **Update — real production incident, batch-wide rollback bug (found diagnosing a
    live "No channel_listings match ... cannot resolve product_id for order_lines"
    failure banner on `/settings/channels`)**: the SKU-less/unmapped-order case one
    paragraph above ("correctly failed loudly and rolled back") turned out to be
    rolling back more than just the one bad order. `OrderService.persistPulledOrders()`
    processes an entire pulled batch inside one `withTenant()` transaction; before this
    fix, one order's `insertOrderLines()` throw propagated straight out of the loop and
    aborted that whole transaction, silently losing every *other*, perfectly good order
    pulled in the same sync window too — not just the unresolvable one. Worse, because
    `last_order_sync_at` is only advanced on a fully successful call (§2.3-adjacent
    cursor semantics — `syncShopifyTenant()` in `packages/scheduler/src/index.ts` moves
    it only after `persistPulledOrders()` returns without throwing), the exact same
    batch — bad order included — got re-pulled and re-failed on every subsequent sync
    run, repeating the loss indefinitely instead of just once.
    - **Fix**: each order in the batch now runs inside its own Postgres `SAVEPOINT`
      (`persist_one_order`), released on success and rolled back to (not out of the
      whole transaction) on failure. Failures are collected instead of thrown mid-loop,
      so the loop always finishes the batch. Every order-received event/state-machine
      walk for the *successful* orders still runs (and their `orders` rows have already
      committed, since they were `RELEASE`d, not rolled back) before
      `persistPulledOrders()` throws one aggregated error at the very end if
      `failedOrders.length > 0` — preserving the existing contract every scheduler call
      site (`packages/scheduler/src/index.ts`) depends on: no throw means
      `recordSyncSuccess()` + cursor advance, a throw means `recordSyncFailure()` + the
      cursor stays put. `PersistPulledOrdersResult`'s shape is unchanged (still throw,
      not a partial-result return) to keep that contract exactly as-is. Regression
      coverage: `packages/order-service/test/batch-partial-failure.test.ts` — proves a
      good order both *before and after* the bad one in the same batch still persists
      and allocates, that the bad order's own `orders` row (and `order_lines`) leave no
      orphan, and that the call still throws so failure stays visible.
    - **Known residual behavior — deliberately not solved by this fix**: a
      *permanently* unresolvable order (e.g. the specific Shopify order this incident
      traces to, whose line item has no SKU set — likely one of Shopify's own demo/
      sample products, see `normalizeShopifyOrderLine`'s doc comment on the `sku ?? id`
      GID fallback in `shopify-connector.ts`) still can't advance the cursor past
      itself, since it never stops failing on its own. Every *other* order now safely
      gets through, but that one order will keep tripping `recordSyncFailure()` on every
      sync run until it's resolved at the source (set a real SKU on that Shopify variant,
      or otherwise remove/ignore that order in Shopify) — and enough consecutive
      failures still eventually flips the connection to `status = 'error'`
      (`recordSyncFailure`'s own doc comment), the same as a genuine connection-health
      failure would, even though this is a data-quality problem specific to one order.
      Distinguishing "one bad order" from "the whole connection is broken" for
      circuit-breaker purposes is a real gap, intentionally left open rather than
      redesigned as part of this fix.
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
  `limit=200` per page (eBay's own documented max). **Update — pagination now
  built**, closing the real (not theoretical) gap this section used to flag: a
  tenant with more than 200 new orders since their last sync used to silently lose
  the rest until a later run's own cursor happened to land past them.
  `pullOrders()` now loops on the response's own `next` field (checked only for
  truthiness, never fetched as a literal URL — see the method's own doc comment for
  why: blindly following a response-supplied host is the same class of bug the real
  Amazon SP-API 403 incident, CLAUDE.md's own §4.1 update, already came from once),
  bounded by `EBAY_ORDERS_MAX_PAGES` (250 pages × `EBAY_ORDERS_PAGE_SIZE` 200 =
  50,000 orders — deliberately the same figure as §0's own monthly ceiling) as a
  hard safety cap against a malformed/looping response, not expected to ever be hit
  in practice. Unit-tested against a stubbed `global.fetch`
  (`packages/channel-connectors/test/ebay-connector.test.ts`, the same
  stub-and-restore-in-`finally` discipline `retry.test.ts` already established) —
  multi-page collection, stopping on a page with no `next`, stopping on a page that
  claims `next` but returns zero orders (defensive), and the safety cap itself —
  the first live-fetch-mocked coverage this connector class has had, everything
  else in this file still being pure-function-only per this section's own opening
  paragraph. `lineItemCost` is the line's **total**, not a per-unit price (confirmed via the
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
  own "MFN/DEFAULT fulfillment channel only" `pushInventory()` scope. **Confirmed
  against real eBay Sandbox infrastructure** — see the "Update — confirmed live
  against real eBay Sandbox infrastructure" paragraph at the end of this section for
  the full trace, including a real bug this exact method's own GET call had (no
  `Accept-Language` header at all, not even the wrong one).
- **`confirmShipment()`**: `GET` the order for its line items, then
  `POST /sell/fulfillment/v1/order/{orderId}/shipping_fulfillment` — endpoint pattern
  and body field names (`lineItems`, `shippedDate`, `shipmentTrackingNumber`,
  `shippingCarrierCode`) confirmed from developer.ebay.com's fulfillment overview page,
  in prose rather than a literal rendered example (unlike Amazon's/Walmart's own
  confirmShipment() bodies). `shippingCarrierCode` is set directly from
  `tracking.carrier` with **no mapping/validation against eBay's own carrier-code
  enum**. **Narrowed further this pass**: eBay's own `ShippingFulfillmentDetails` type
  page confirms this field is a plain `string`, not a REST-API-level fixed enum — but
  says valid values must be looked up per-marketplace via the *legacy* Trading API's
  `GeteBayDetails` (`DetailName=ShippingServiceDetails`) call, a genuinely separate
  auth flow/credential shape from the REST OAuth token this connector otherwise uses
  entirely. No universal fallback (no `"Other"`/`"OTHER"`) is documented as always
  valid anywhere — unlike Amazon's confirmShipment(), which deliberately uses the
  confirmed always-valid `'Other'` + carrierName combination, eBay has no equivalent
  escape hatch; the only literal example carrier value any official page rendered was
  `"USPS"`. In this app, `tracking.carrier` comes straight from a free-text "Carrier
  (e.g. UPS)" field on `/picklists` (`PackOrderForm`) — untouched, unvalidated. Fixing
  this properly means adding the legacy Trading API's `GeteBayDetails` call, a real
  scope increase, not attempted here. Single-fulfillment assumption (every line ships
  together, same tracking info applied to all) — same documented limitation Amazon's/
  Walmart's own confirmShipment() carry.
- **Getting a real sandbox order to test `confirmShipment()` against is itself an
  open, externally-blocked problem, not something more of this codebase's own code can
  solve**: eBay's own developer community (multiple forum threads checked directly)
  confirms sandbox order-creation for Fulfillment API testing is a known, long-standing
  pain point with no officially confirmed working method — one thread's own author,
  after failing both the API route (`AddOrder`-style Trading API calls not reaching
  fulfillment) and the sandbox website (checkout errors), reported resorting to testing
  against real production instead. This matches what this section's own "Sandbox setup
  itself needed a workaround" note below already found for Business Policies (My eBay
  Active and Seller Hub both erroring in sandbox) — eBay's sandbox is confirmed
  unreliable for more than one seller-side workflow, not just this one. Until either
  eBay ships a working sandbox path or this channel goes live against a real production
  order, `confirmShipment()` stays a well-researched, unverified first draft — the
  same status Temu's and TikTok's connectors carry, for a related but distinct reason
  (those two lack readable official docs at all; this one has readable docs but a
  broken sandbox for exactly the scenario that would prove it).
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
  - **Confirmed against real eBay Sandbox infrastructure** — `fetchBusinessPolicies()`,
    `createMerchantLocation()`, and `createListing()` have all now been run for real
    (see the "Update — confirmed live" paragraph at the end of this section for the
    full trace, including two real bugs this pass found and fixed in
    `createListing()`'s own three-step write). The two pure body-building functions
    (`buildEbayInventoryItemBody`/`buildEbayOfferBody`) stay unit-tested as before
    (`packages/channel-connectors/test/ebay-connector.test.ts`), now asserting the
    hardcoded-aspects fix described below too.
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
- **Update — confirmed live against real eBay Sandbox infrastructure, closing out
  the "UNVERIFIED IN ITS ENTIRETY" status this section used to carry**: the network
  block described below is specific to the sandboxed AI coding-agent environment this
  connector was originally built in, not a real limitation of eBay's own APIs — run
  from a genuine developer machine with real eBay Sandbox credentials
  (`EBAY_SANDBOX_*` populated, a real refresh token obtained via the authorization-
  code round trip), `npm run ebay:sandbox-smoke-test` reaches `api.sandbox.ebay.com`
  cleanly. **Five of the connector's six methods are now confirmed working against
  live infrastructure**: `authenticate()` (refresh-token exchange), `pullOrders()`
  (round-trips cleanly; a fresh sandbox seller account has no orders until a test-buyer
  purchase exists, so this returns zero rather than being provably exhaustive),
  `fetchBusinessPolicies()`, `createMerchantLocation()`, `createListing()` (a real
  `listingId` returned), and `pushInventory()`. Only `confirmShipment()` remains
  unverified — it needs a real sandbox order, meaning a second test-buyer account
  actually completing a purchase, which was deliberately not pursued this pass as a
  materially bigger, less certain lift than everything else here (see the sandbox-UI
  unreliability note below); it stays a well-researched first draft, exactly the
  status every other method in this connector carried before this pass.
  - **Sandbox setup itself needed a workaround, not just credentials**: a fresh
    sandbox seller account has no Business Policies (fulfillment/payment/return)
    configured by default, and `fetchBusinessPolicies()` failed with a misleading
    `400 20403: Invalid .` (an empty field name in eBay's own error template) until
    one policy of each type existed. eBay's sandbox web UI could not create them —
    both the legacy "My eBay Active" page and Seller Hub returned outright errors
    (a load failure and a 404, respectively), confirming eBay's own "Sandbox
    Supported/Unsupported Features" disclaimer is real for this feature. Worked
    around with a one-off local script calling eBay's Account API directly
    (`POST /sell/account/v1/program/opt_in` + one `POST` each to
    `{fulfillment,payment,return}_policy`) — not part of this codebase, a one-time
    manual setup step the same way a real tenant's own eBay seller account would
    already have these configured through eBay's normal (non-sandbox) seller tools.
  - **PRODUCTION BUG #1, found and fixed**: every Inventory API write this connector
    makes (`createOrReplaceInventoryItem` PUT, `createOffer` POST, `publishOffer`
    POST) — and, it turned out, `pushInventory()`'s own read-before-merge GET too —
    needs an `Accept-Language` header in addition to `Content-Language`; this
    connector only ever sent the latter. eBay's own error
    (`400 25709: Invalid value for header Accept-Language`) is misleading — it reads
    the same whether the header is present-but-wrong or missing outright, which cost
    real debugging time before the fix was found. Fixed on all four call sites (three
    writes plus `pushInventory()`'s GET) — this would have broken `createListing()`
    and `pushInventory()` for every real tenant, not just this test, so this is a
    genuine production-bug fix, not a smoke-test artifact.
  - **PRODUCTION BUG #2, found and fixed, narrower in scope**: `publishOffer()`
    rejected the smoke test's first listing category (Cell Phones & Smartphones,
    `categoryId 9355`) four times in a row, each for a different missing required
    "item specific" (Brand, then Storage Capacity, then Model, then Color) — eBay's
    Inventory API validates these per-category, and this connector had no handling
    for them at all. `buildEbayInventoryItemBody()` now hardcodes three generic
    values (`Brand: "Unbranded"`, `"Storage Capacity": "64 GB"`, `Model: "Does not
    apply"` — all eBay's own recognized conventions for a generic/inapplicable
    value) as a narrow v1 default, same spirit as this method's existing hardcoded
    `condition`/`marketplaceId`/`format`. **This is explicitly not a general fix**:
    a category could still reject for a different required aspect this hardcoded
    set doesn't cover (Color and Network are both plausible for other categories),
    since this codebase still has no Taxonomy-API-driven variable aspects system —
    deliberately out of scope, per this section's own "Per-listing form fields"
    bullet above. After four required-aspect rounds in a row for one category, the
    smoke test itself was switched to a genuinely zero-required-aspect category
    (Postcards, `categoryId 262042`) found by querying eBay's own Taxonomy API
    (`get_category_suggestions` + `get_item_aspects_for_category`) rather than
    continuing to guess — a real tenant listing into a dense category (electronics,
    apparel) will still hit this same wall and need their own category-appropriate
    aspects collected, which this codebase does not do.
  - Pure request/response mapping logic (`normalizeEbayOrder`/`normalizeEbayOrderLine`,
    plus `ebay-oauth.ts`'s URL-building/parsing, plus the two aspect-hardcoding
    body-builders) stays unit-tested
    (`packages/channel-connectors/test/ebay-connector.test.ts`) alongside this live
    verification, not in place of it.

### 4.7 Temu Open Platform (channel #5 — Arif's explicit pick, "add temu")

- **Why now, and what scope**: Arif's own explicit request ("add temu and HR & Payroll"),
  clarified via an explicit follow-up decision: **"Full connector, like eBay"** — meaning
  eBay's own ORIGINAL v1 scope (§4.6, before its later, separate `createListing()`
  addition), not the full outbound-listing-capable connector eBay is today. So this is
  `authenticate()` / `pullOrders()` / `pushInventory()` / `confirmShipment()` only — no
  outbound listing creation this pass, even though Temu's own API surface has plenty of
  listing-creation methods (`bg.local.goods.add` and friends) that were deliberately not
  built.
- **Research trail — the least accessible official documentation of any channel in this
  codebase, worse than eBay's own merely-thin doc pages**: `partner[-us/-eu].temu.com/
  documentation` is a pure JavaScript SPA — every page fetched during this connector's
  research pass (including a literal, search-surfaced "Signature Method for API request"
  page and a literal "bg.local.goods.stock.edit" reference page) returned only "You need
  to enable JavaScript to run this app." No official Temu documentation content was
  readable at all, by any method tried, this entire research pass — a strictly worse
  starting position than eBay's (where the pages at least rendered, just thin).
  - Pivoted to the real, installed community Python SDK `temu_api` (PyPI, v0.2.1,
    `github.com/XIE7654/temu_api`) — installed into a scratch venv and its source read
    directly. This is the PRIMARY confirmed source for the base URL pattern, the signing
    algorithm, and every REQUEST parameter name in this connector — same "an installed
    package's real source is more authoritative than a rendered doc page" precedent this
    codebase's own Sentry integration first established.
  - The installed SDK's own `request()` method returns raw `response.json()` with NO
    envelope parsing of its own — meaning even the SDK doesn't confirm what a RESPONSE
    actually looks like, success or failure. Every other source tried (a community Go
    SDK whose doc pages truncated before showing full struct fields, a third-party
    integration-platform doc site, a GitHub repo whose README named literal
    example-response filenames) either rendered no example or — in one specific case
    worth flagging — turned out to document a same-named but entirely UNRELATED
    third-party Temu-product-SCRAPING API (idatariver.com's, not Temu's own Open
    Platform), which would have been a wrong confirmation if used without checking.
  - Net effect: this connector's REQUEST shapes are confirmed from real SDK source;
    its RESPONSE shapes (the envelope, and every field on an order/line item) are this
    codebase's best-effort inference from Temu's own consistent camelCase
    request-naming convention and common Alibaba-TOP-API-gateway envelope shapes —
    genuinely unconfirmed, not documented fact. See
    `packages/channel-connectors/src/temu-connector.ts`'s own header comment and each
    method's own doc comment for exactly what's confirmed where.
- **Auth**: not OAuth — an `appKey`/`appSecret`/`accessToken` triple issued directly to a
  Temu Open Platform application, with the `accessToken` used directly on every signed
  request (confirmed: the installed SDK never exchanges or refreshes it). Closer in shape
  to Shopify's static `shpat_...` token than to Amazon's/eBay's refresh-token exchange,
  just three values instead of one. `authenticate()` calls `bg.open.accesstoken.info.get`
  (the closest thing this SDK exposes to a verify-these-credentials-work call) and
  returns a far-future placeholder `expiresAt`, same shape
  `ShopifyConnector.authenticate()` uses for its own non-expiring token.
- **Signing** (`buildTemuSignature`, confirmed verbatim from the installed SDK's
  `BaseClient._get_sign()`): sort every param key alphabetically, concatenate each as
  `key` immediately followed by `value` with no separators, strip spaces, wrap as
  `appSecret + concatenated + appSecret`, MD5, uppercase hex. Every request also carries
  `type` (the specific API method, e.g. `"bg.order.list.v2.get"`) — this is an
  Alibaba-TOP-API-style single-endpoint-plus-`type`-param design (`POST
  {baseUrl}/openapi/router` for everything), common among Chinese e-commerce open
  platforms, unlike every other channel in this codebase's own distinct-URL-per-operation
  REST shape.
- **`pullOrders()`**: two calls per discovered order, mirroring this codebase's own Amazon
  precedent exactly (§4.1: "order headers vs. a separate line-items call") —
  `bg.order.list.v2.get` for headers filtered by `createAfter` (unix seconds, the closest
  confirmed analog to every other connector's `since` cursor), then
  `bg.order.detail.v2.get(parentOrderSn)` per header for line items. `pageSize` capped at
  100 with no pagination loop beyond the first page — a real, documented gap, same status
  as eBay's own 200-row/no-pagination narrowing. **Shipping address is deliberately not
  fetched** — `bg.order.shippinginfo.v2.get` is a real, confirmed, separate THIRD call
  this v1 pass doesn't make; `extractUsShippingZip()` (`packages/order-service/src/
  index.ts`) has no `'temu'` case, so a Temu order's nearest-location ranking simply falls
  back to the pre-existing oldest-created-first default rather than erroring.
- **`pushInventory()` — structurally different from every other connector's**: Temu's
  confirmed request shape is `bg.local.goods.stock.edit` with a required `goodsId` plus a
  `skuStockTargetList` array of per-SKU entries under that one parent listing — not a flat
  single-SKU identifier. Since nothing in this codebase calls `pushInventory()`
  generically across channels (confirmed by grep before building this — every call site
  is channel-specific), `productId` for Temu is DELIBERATELY a compound string,
  `"<goodsId>:<skuId>"` (`parseTemuProductId`); a Temu `channel_listings` row stores
  `goodsId` in `external_id` and `skuId` in `external_sku`. Uses `skuStockTargetList`
  (absolute) over `skuStockChangeList` (relative), same "system of truth pushes absolute"
  reasoning `ShopifyConnector.pushInventory()`'s own doc comment gives. **The single
  least-confirmed request body in this entire connector**: the inner
  `skuStockTargetList` entry's own field names (guessed as `skuId`/`targetStockQuantity`)
  were not found in ANY source tried this research pass.
- **`confirmShipment()`**: uses `bg.order.fulfillment.info.sync` — chosen over the two
  other shipment-confirmation methods this API exposes
  (`bg.logistics.shipment.v2.confirm`'s `sendRequestList`, or the
  discover-then-confirm `bg.order.unshipped.package.get` +
  `bg.logistics.shipped.package.confirm` pair) specifically because it's the only one
  with flat, individually-confirmed top-level scalar fields and no unconfirmed nested
  list — same "prefer the confirmed synchronous shape over an unconfirmed batch one"
  reasoning behind Amazon's own Listings-Items-API-over-Feeds-API choice for
  `pushInventory()` (§4.1). Two real, documented narrowings: `tracking.carrier` is
  silently discarded (this endpoint's confirmed field set has no carrier-code parameter
  at all), and `orderSn` is passed this method's whole-order `orderId` even though the
  endpoint's own docstring literally labels that parameter a SUB-order number, not a
  parent order number — an honestly-flagged, unconfirmed risk, not a resolved decision
  (same "single-fulfillment assumption" narrowing every other connector's own
  `confirmShipment()` already carries, just with a real naming-mismatch risk on top).
- **No new migration needed** — Temu's three-value credential reuses existing
  `channel_connections` columns exactly the way Walmart's/eBay's own connect routes
  already reuse `lwa_client_id` for a non-Amazon client id: `lwa_client_id` = `appKey`
  (also reused into `external_account_id`, same "no independent seller id" pattern
  Walmart/eBay both established), `encrypted_client_secret` = `appSecret`,
  `encrypted_access_token` (added by migration `0019_channel_connections_shopify.sql` for
  Shopify's own static token) = `accessToken` — the identical "long-lived, high-value,
  used directly" semantic Shopify's row already uses that column for, just under a
  different channel.
- **Wired into the app**, mirroring eBay's own wiring exactly: `/settings/channels` has a
  plain "Connect Temu" form (App Key + App Secret + Access Token, all required every
  submission, no OAuth redirect — same shape as Walmart's/Shopify's own static-credential
  forms) that POSTs to `/api/channels/temu/connect`, which calls
  `TemuConnector.authenticate()` live to reject a bad triple before persisting anything.
  The scheduler (`packages/scheduler/src/{index,cron-runner}.ts`) runs a Temu order-sync
  pass in parallel to the other four — `syncTemuOrders`/`runTemuOrderSyncJob`/
  `startTemuOrderSyncScheduler`, a separate node-cron task and separate
  `scripts/temu-order-sync-{job,scheduler}.ts` entrypoints. What actually triggers a sync
  on this app's Vercel deployment is `GET /api/cron/temu-order-sync` (same `CRON_SECRET`
  Bearer-token gate, same idempotency contract as the other four cron routes) plus its
  `crons` entry in `vercel.json` (`30 6 * * *`, staggered 30 minutes after eBay's own
  order-sync cron). `WarehouseService.confirmShipment()` dispatches to
  `createTemuConnectorFromChannelConnection` on `order.channel === "temu"`, alongside the
  other four branches. `recordSyncFailure`/`recordSyncSuccess`/`recordRateLimitTrip`'s
  `channel` parameter type was widened to include `"temu"`.
- **Does NOT implement the shared `ChannelConnector` interface** — same shape decision as
  Amazon/eBay (§4.3): a plain class with only the four v1 methods, no
  `submitListing()`/`getFeedStatus()`/`subscribeToEvents()`.
- **UNVERIFIED IN ITS ENTIRETY, more so than any other channel in this codebase,
  including eBay**: unlike eBay (where this repo's own network policy, not readability,
  was the blocker — the doc pages at least rendered), Temu's documentation was simply
  never readable by any method tried. No Temu credentials of any kind exist anywhere in
  this codebase yet (see `.env.example`'s `TEMU_*` entries) — this is a well-researched
  first draft, in the same "sandbox-first, never guess straight into production" spirit
  every other connector's own first pass carries (§7, §11 item 5), not a proven
  implementation. Pure mapping logic (`normalizeTemuOrder`/`normalizeTemuOrderLine`,
  `buildTemuSignature`/`buildTemuRequestBody`, `parseTemuProductId`) is unit-tested
  (`packages/channel-connectors/test/temu-connector.test.ts`, 19 tests) — everything past
  that boundary stays unverified until run against real credentials.

### 4.8 TikTok Shop Open Platform (channel #6 — Arif's explicit pick, "add tiktok shop connector")

- **Why now, and what scope**: same "next expansion once the abstraction had proven
  itself" reasoning as eBay's and Temu's own additions (§4.6/§4.7) — Arif's explicit
  request, clarified via an explicit follow-up AskUserQuestion decision: **"Full
  connector, like eBay/Temu v1"** — `authenticate()`/`pullOrders()`/`pushInventory()`/
  `confirmShipment()` only, no outbound listing creation, does not implement the shared
  `ChannelConnector` interface (§4.3).
- **Research trail — the official docs had the same "unreadable JS SPA" problem Temu's
  own did, worked around the same way**: `partner.tiktokshop.com/docv2/...` is a pure
  JavaScript SPA — every page fetched this pass (including literal, search-surfaced
  pages titled "Sign your API request" and "Get Package Detail") returned only
  navigation chrome, no documentation content.
  - PRIMARY confirmed source: a real, detailed technical integration spike written up
    as a GitHub issue (`github.com/openlinker-project/openlinker#2882`), dated the same
    week as this research pass — base URLs, the OAuth token exchange/refresh flow, the
    full request-signing algorithm, and a broad endpoint inventory (orders, packages,
    inventory, returns). The single best source found for this connector, comparable
    in detail to eBay's own official doc pages and materially better than anything
    found for Temu.
  - CROSS-CONFIRMED, not taken on one source alone: base URLs and the
    app_key/access_token/shop_cipher credential model both independently match a
    second, unrelated source — the Go package `github.com/jianjungki/tiktok`, read via
    `pkg.go.dev`'s plain server-rendered documentation (unlike the official SPA, this
    actually renders). That Go package's own literal endpoint paths
    (`/api/fulfillment/...`) were deliberately NOT used — they don't match the
    versioned `/{category}/{YYYYMM}/{action}` shape the openlinker spike documents as
    current, reading instead as an older/legacy API generation. Two more sources
    (npm's `tiktok-shop-sdk`, EcomPHP's `tiktokshop-php`) corroborated the credential
    model's shape without themselves exposing readable endpoint/signing detail.
  - What's NOT confirmed by anything found this pass: literal response field names for
    an order/line item (every source gave endpoint paths and the credential/signing
    model, none rendered an actual example JSON response) — same gap Temu's own
    connector carries. See `tiktok-connector.ts`'s own header comment and each
    type/method's own doc comment for exactly what's confirmed where.
- **Auth**: a genuine OAuth refresh flow, closer to Amazon's/eBay's own shape than to
  Temu's static token — but structurally unusual in its own way: `GET
  https://auth.tiktok-shops.com/api/v2/token/refresh` with `app_key`/`app_secret`/
  `refresh_token`/`grant_type=refresh_token` as a **plain, unsigned query string**
  against a separate auth host, not the signed-request convention every business-API
  call uses. Access token reported ~7-day expiry, refresh token ~365 days (both read
  from the response, never hardcoded). The access token travels on every business-API
  call via the `x-tts-access-token` header — not `Authorization`, not the signed query
  string.
- **A fifth credential value, unique among this codebase's channels**: `shop_cipher` —
  a genuinely independent per-shop identifier (one `app_key`/`access_token` pair can
  cover multiple shops, each with its own cipher, obtained from
  `/authorization/202309/shops`), required as a query param on most business-API calls
  (the spike names ~7 exempt endpoint families, none of which this v1 connector calls).
- **Signing** (`buildTikTokSignature`, confirmed from the openlinker spike's own
  step-by-step description, not independently re-verified against a second worked
  example the way Temu's MD5 algorithm was confirmed against real SDK source): sort
  every non-array-valued query param alphabetically, concatenate as `key` immediately
  followed by `value` with no separators, **prepend the request PATH** (unlike Temu's/
  eBay's own signing, the URL path itself is part of what's signed), append the raw
  JSON request body for a non-GET call, wrap as `appSecret + <string> + appSecret`,
  **HMAC-SHA256** keyed with `appSecret` (not Temu's MD5), lowercase hex.
- **`pullOrders()`**: `POST /order/202309/orders/search` (paginated via
  `next_page_token`, bounded by a 250-page safety cap same spirit as eBay's own
  `EBAY_ORDERS_MAX_PAGES`), body `filter.update_time_ge` (unix seconds) as the closest
  confirmed analog to every other connector's `since` cursor — the field NAME is
  confirmed from the spike, its exact position inside a `filter` object is this
  codebase's own inferred shape. Falls back to `GET /order/202309/orders?ids=...`
  (batched 50 ids/call, a commonly-cited but not officially-confirmed limit) only for
  orders the search response didn't already include line items for, per-batch
  error-isolated the same way Temu's own per-order detail lookup is.
- **`pushInventory()` — the single least-confirmed request body in this connector**,
  same "flag it, don't hide it" precedent Temu's own `skuStockTargetList` sets: `POST
  /product/202309/products/{productId}/inventory/update`, body
  `{ skus: [{ id: skuId, inventory: [{ warehouse_id, quantity }] }] }` — no source
  found this pass rendered a literal example of this endpoint. `productId` is a
  compound `"<productId>:<skuId>"` string (`parseTikTokProductId`), same pattern
  Temu's own `parseTemuProductId` established — and this connector needs a THIRD value
  beyond that pair: `warehouse_id`, read from a single tenant-wide
  `TIKTOK_DEFAULT_WAREHOUSE_ID` env var rather than a second compound-id scheme,
  correct only for a seller with one TikTok-registered warehouse (a real, documented
  v1 narrowing).
- **`confirmShipment()` — this connector's other major unconfirmed piece**: TikTok's
  own fulfillment model treats an order and its package(s) as genuinely distinct
  objects (an order can be combined/split/uncombined into one or more packages, per
  the spike), and no endpoint to resolve an orderId to its package id(s) was found
  rendered anywhere this pass. `POST /fulfillment/202309/packages/{orderId}/ship`
  passes this method's own whole-order id directly into the package-ship endpoint's
  `{id}` segment, on the unconfirmed assumption that a simple, never-combined-or-split
  order's package id equals its order id — a genuine, unresolved risk, not a resolved
  design decision, same honesty standard Temu's own `orderSn`/sub-order-sn risk is held
  to. `tracking.carrier` is passed straight into `shipping_provider_id` with no
  mapping/validation against whatever provider-id scheme TikTok actually expects — no
  confirmed lookup/enum was found, same gap eBay's own `confirmShipment()` carries.
- **No new migration needed** — reuses existing `channel_connections` columns:
  `lwa_client_id` = `appKey`, `encrypted_client_secret` = `appSecret`,
  `encrypted_access_token` = `accessToken`, `encrypted_refresh_token` = `refreshToken`,
  `external_account_id` = `shop_cipher`. That last one is a genuinely BETTER semantic
  fit than every other channel's own reuse of this column — Amazon/Walmart/eBay/Temu
  all reuse `external_account_id` to hold their OWN client/app id ("no independent
  seller id exists to put here instead," each connector's own doc comment says) —
  TikTok Shop is the first channel in this codebase where a real, independent per-shop
  identifier (`shop_cipher`) actually exists, so this is `external_account_id` finally
  being used for what its name says, not a repurposing.
- **Wired into the app**, mirroring Temu's own wiring exactly: `/settings/channels` has
  a plain "Connect TikTok Shop" form (App Key + App Secret + Access Token + Refresh
  Token + Shop Cipher — five fields, more than any other channel's own form, because
  TikTok Shop's credential model genuinely has five independent parts, see above — all
  required every submission, no OAuth redirect) that POSTs to
  `/api/channels/tiktok/connect`, which calls `TikTokConnector.authenticate()` live to
  reject a bad credential set before persisting anything. The scheduler
  (`packages/scheduler/src/{index,cron-runner}.ts`) runs a TikTok Shop order-sync pass
  in parallel to the other five — `syncTikTokOrders`/`runTikTokOrderSyncJob`/
  `startTikTokOrderSyncScheduler`, a separate node-cron task and separate
  `scripts/tiktok-order-sync-{job,scheduler}.ts` entrypoints. What actually triggers a
  sync on this app's Vercel deployment is `GET /api/cron/tiktok-order-sync` (same
  `CRON_SECRET` Bearer-token gate, same idempotency contract as the other five cron
  routes) plus its `vercel.json` entry, staggered 30 minutes after Temu's own
  (`0 7 * * *`, following the existing 30-minute-stagger convention).
  `WarehouseService.confirmShipment()` (`packages/warehouse-service/src/index.ts`) also
  dispatches to `createTikTokConnectorFromChannelConnection` for `order.channel ===
  "tiktok"`, same as every other channel.
- **UNVERIFIED IN ITS ENTIRETY**, same status Temu's own connector carries and for the
  same reason: no TikTok credentials of any kind exist anywhere in this codebase yet
  (see `.env.example`'s `TIKTOK_*` entries), no confirmed self-serve sandbox exists to
  test against safely, and this is a well-researched first draft, not a proven
  implementation. Pure mapping/signing logic (`normalizeTikTokOrder`/
  `normalizeTikTokOrderLine`, `buildTikTokSignature`, `parseTikTokProductId`) is
  unit-tested; everything past that boundary (`authenticate`, `pullOrders`,
  `pushInventory`, `confirmShipment`) stays unverified until run against real
  credentials. Being "wired into the app" here means the plumbing (UI/scheduler/cron)
  exists and compiles, not that a real TikTok Shop sync has ever succeeded.

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
  location, plus set/clear its optional ZIP code (see the nearest-location-routing
  paragraph below); no delete, `type` fixed after creation, see that page's own doc
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
  passes unchanged). **Nearest-location-by-shipping-address routing — built**,
  closing one of the two related gaps this section used to flag as explicitly open
  (migration `0027_locations_postal_code.sql`, `extractUsShippingZip()`/
  `rankByDistanceToShippingZip()` in `packages/order-service/src/index.ts`,
  `/locations`' new per-row "Set ZIP" form): a tenant can now give a warehouse
  location an optional US ZIP code, and `resolveCandidateLocations()` ranks its
  non-preferred fallback candidates nearest-first to the order's own shipping ZIP
  (great-circle distance via the `zipcodes` npm package's bundled US ZIP centroid
  data — no geocoding API call, no new paid infra, same "don't stand up
  infrastructure a single self-testing tenant hasn't earned yet" call already made
  for BullMQ/Redis) instead of purely oldest-created-first. `preferred_location_id`
  (a routing rule's explicit choice) is untouched by this and still wins outright.
  The order's own shipping ZIP is read out of `orders.shipping_address`'s raw,
  per-channel JSONB via `extractUsShippingZip()` — a small, deliberately
  channel-aware field-path lookup (Amazon's `PostalCode`/`CountryCode`, Shopify's
  `zip`/`countryCodeV2`, Walmart's `postalCode`/`country`, eBay's one-level-deeper
  `contactAddress.postalCode`/`contactAddress.countryCode`), each confirmed against
  that channel's own real or community-verified example response — see that
  function's own doc comment for every source. **US-only, deliberately narrow**:
  a non-US order, a location with no ZIP set, or an unrecognized ZIP all mean
  "distance unknown," which falls back to the pre-existing oldest-created-first
  order for that location (`Array.prototype.sort`'s ES2019+ stability guarantee is
  what makes this a true fallback rather than a reshuffle — see
  `rankByDistanceToShippingZip()`'s own doc comment) — this ranking only ever adds
  information on top of the old default, it never removes or degrades it.
  Distance is "as the crow flies," not real shipping/driving distance, per the
  `zipcodes` package's own README. Fully unit- and integration-tested
  (`packages/order-service/test/nearest-location-routing.test.ts` — pure
  `extractUsShippingZip()`/`rankByDistanceToShippingZip()` cases needing no DB,
  plus live-Postgres `allocateOrder()` cases proving nearer-but-newer beats
  farther-but-older, preferred still wins over nearest, and every no-distance-info
  case falls back unchanged). **Per-SKU rule-based routing — built**, closing
  the other related gap this section used to flag as blocked upstream:
  `OrderReceivedPayload` (`packages/shared/src/events.ts`) now carries a
  `lineSkus: string[]` field alongside its existing channel/marketplace/
  shipping fields — one entry per order line, each the platform-canonical
  `products.internal_sku` (not each channel's own `external_sku`), resolved
  by `insertOrderLines()` (`packages/order-service/src/index.ts`) at the same
  point it already resolves `product_id` via `channel_listings`, so this cost
  no extra query. The rules engine (`packages/rules-engine/src/index.ts`)
  gained a matching `"contains"` condition operator — the mirror image of the
  existing `"in"` (there, a scalar field is checked against a list of
  candidate values; here, an array field like `lineSkus` is checked for
  whether it contains one candidate value) — so a rule like
  `{"field":"lineSkus","op":"contains","value":"WIDGET-RED"}` combined with
  the existing `route_to_warehouse` action routes an order by which product
  is in it, the same way an existing rule already routes by channel. Fires
  identically for the same product regardless of which channel's own SKU
  spelling the order arrived under, since it keys off `internal_sku`, not
  `external_sku` — proven directly in
  `packages/rules-engine/test/sku-routing-integration.test.ts` (one seeded
  product listed under two different channels' SKUs, two synthetic orders
  from each channel, both route). `/rules`' condition-JSON help text
  documents the new operator. Not a new action type, not a new trigger event,
  and not an OR/any-of-N-SKUs condition (conditions stay an implicit AND
  list, unchanged — matching multiple SKUs with OR still means one rule per
  SKU, a real but deliberately unaddressed limitation, same scope discipline
  as every other pass in this file). Per-location fulfillment routing beyond
  what the rules engine's `route_to_warehouse` action, this nearest-location
  ranking, and per-SKU routing already do is otherwise still open.
  **Rules engine expansion — built**: a second trigger event
  (`order.backordered`) and a third action type (`send_notification`),
  closing the "retention feature" out further rather than leaving it at just
  routing/holding. `RulesEngine.attach()` (`packages/rules-engine/src/
  index.ts`) now subscribes both `order.received` and `order.backordered` to
  the same generic handler (`handleOrderEvent`, renamed from the
  order.received-only `handleOrderReceived` — every step past reading
  `event.name`/`payload.orderId` was already fully trigger-agnostic, so one
  handler covers both instead of a copy-pasted second one).
  `OrderBackorderedPayload` (`packages/shared/src/events.ts`) is now typed
  (`{ orderId: string }`, deliberately minimal — a backorder has no
  channel/SKU context worth pre-resolving the way `order.received`'s own
  `lineSkus` does). `send_notification` emails every one of the tenant's own
  `users` (a near-fork of `packages/scheduler/src/index.ts`'s own
  `notifyTenantUsers()` — not shared/imported from `@alltix/scheduler`,
  since rules-engine has no existing dependency on the job-runner layer and
  shouldn't gain one for a five-line query) with either a tenant-supplied
  custom message (`action.value`, a plain string) or a generic default
  naming the rule/trigger/order when `value` is omitted, `null`, or
  whitespace-only; a non-string, non-empty value is a config mistake and
  throws, recorded as that row's `error` the same way an unrecognized
  warehouse name already is for `route_to_warehouse`. The actual `sendEmail()`
  call deliberately happens AFTER the whole rule-execution transaction
  commits, not from inside `executeAction()` itself — an outbound HTTP call
  has no business holding open the same DB transaction that's writing
  `rule_executions` (and, for a matched `hold_order` in the same batch, the
  order's own status change), same "email is additive, not load-bearing"
  precedent `recordSyncFailure()`'s own `notifyTenantUsers()` call already
  set by running after its UPDATE's transaction, not inside it (§4.4/the
  alerting paragraph above). A consequence worth being explicit about: a
  `send_notification` action's `rule_executions` row always shows
  `applied: true, error: null` once its message is built, regardless of
  whether the email actually gets delivered afterward — building the
  message can't itself fail, and `sendEmail()` never throws (same
  fire-and-forget contract as every other email in this codebase).
  `hold_order` combined with an `order.backordered` trigger is a real,
  reachable misconfiguration (the order is already 'backordered', not
  'received', by the time that event fires) — deliberately not blocked at
  rule-creation time, same "fails loud in `rule_executions`, not rejected
  upfront" philosophy every other action's bad config already gets;
  `/rules`' own help text calls this out directly rather than leaving a
  tenant to discover it the hard way. Depends on migration
  `0030_users_tenant_scoped_select_policy.sql` (the alerting paragraph
  above) for `send_notification`'s own `SELECT ... FROM users` to see any
  rows at all — without it this would have silently emailed nobody, the
  same real bug that migration fixed for the scheduler's own tenant
  alerting. Tested in `packages/rules-engine/test/
  order-backordered-integration.test.ts` (the second trigger event firing
  independently of `order.received`, both on the same order; the
  `hold_order`-on-`order.backordered` failure mode) and `packages/rules-engine/
  test/send-notification-integration.test.ts` (RESEND_API_KEY unset stays a
  no-op; a non-string value throws; a blank string falls back to the
  default message) — all against real seeded `tenants`/`users` rows, not
  mocks, same rigor `sync-failure-tracking.test.ts`'s own
  `notifyTenantUsers()` test already established.

  **Real usage-based billing — built**, closing the other half of §1's
  Billing/Subscription line ("usage metering ... for tiered SaaS pricing")
  that basic Stripe Checkout/Portal wiring (`@alltix/billing-service` — one
  flat plan, webhook-driven subscription status, `tenant_usage.orders_processed`
  displayed but not billed against) left open; that migration's own doc
  comment (`0016_billing.sql`) explicitly named this counter "the seed of a
  real Stripe usage-record report later," so this isn't scope creep, it's
  finishing a call already made. This SDK version (`stripe@22.6.1`, API
  version confirmed against `node_modules/stripe/cjs/apiVersion.js`) has no
  legacy `subscriptionItems.createUsageRecord` — usage reporting goes
  through the modern Billing Meters API instead
  (`stripe.billing.meterEvents.create`/`stripe.billing.meters.create`,
  confirmed against the installed SDK's own type definitions before writing
  any of this, not assumed from training data). A new `UsageReporter`
  class (`packages/billing-service/src/index.ts`) subscribes to
  `order.received` on the same `EventBus` `RulesEngine` already does —
  deliberately mirroring its decoupled-subscriber pattern rather than
  calling Stripe from inside `OrderService.persistPulledOrders()` itself —
  and reports one metered usage unit per order via
  `buildOrderUsageMeterEventParams()` (pure, unit-tested), whose
  `identifier` (`order-usage:<orderId>`) doubles as Stripe's own
  idempotency key for the Meter Events API (dedupes "within a rolling
  period of at least 24 hours" per the installed types), the same
  idempotency-key discipline `inventory_events.idempotency_key` already
  applies to the stock ledger. Deliberately silent and best-effort like
  every other optional integration in this codebase, with two guard
  clauses before ever touching Stripe: `STRIPE_SECRET_KEY` unset (most
  environments, including this one) is a same-shape no-op to `sendEmail()`'s
  own unset-key behavior, and a tenant with no `stripe_customer_id` yet
  (never visited `/settings/billing`) is skipped rather than lazily
  Stripe-customer-created from a background job. Unlike `sendEmail()`
  (console-log-only on failure), a thrown error from the actual Stripe call
  is reported via `captureError()` — a usage report that silently and
  systematically fails is a revenue-metering bug worth paging on, not
  merely cosmetic. Only subscribes to `order.received`, not
  `order.backordered` — `persistPulledOrders()` increments
  `tenant_usage.orders_processed` unconditionally on insert, before
  allocation runs, so counting a backorder again would double-count the
  same order. `createCheckoutSession()` now adds a second, `quantity`-less
  metered line item (`buildCheckoutSessionLineItems()`, pure, unit-tested)
  when `STRIPE_METERED_ORDERS_PRICE_ID` is configured — omitted entirely,
  not just inert, when it isn't, so this stays fully backward-compatible
  for any tenant who already subscribed before this existed. That price is
  itself created (idempotently, mirroring `stripe-setup-mvp-plan.ts`'s own
  conventions) by the new `scripts/stripe-setup-usage-metered-price.ts`: a
  Billing Meter plus a `tiers_mode: 'graduated'` metered Price whose first
  tier (`up_to: MVP_PLAN_ORDER_LIMIT_PER_MONTH`) is free and whose second
  (`up_to: 'inf'`) charges a placeholder per-order rate — giving
  `MVP_PLAN_ORDER_LIMIT_PER_MONTH` a second, now load-bearing meaning
  beyond the display-only number `getBillingSummary()` already showed.
  `/settings/billing`'s own caption now reads differently depending on
  `BillingSummary.usageBasedBillingConfigured` (`Boolean(process.env.
  STRIPE_METERED_ORDERS_PRICE_ID)`), so it never claims overage is
  "informational only" once it genuinely isn't. Testing note worth being
  explicit about, same carve-out reasoning as `AMAZON_SANDBOX_TESTS` in
  `scripts/run-tests.sh`: this SDK's default HTTP client is Node's own
  `http`/`https` modules, not `fetch`, so it can't be intercepted the
  lightweight way this codebase already overrides `globalThis.fetch` for
  Resend — `packages/billing-service/test/usage-reporter.test.ts` therefore
  proves the pure param-building functions directly and proves
  `UsageReporter` never reaches a real Stripe call under either guard
  clause (key unset; no customer yet, even with a fake key set) rather than
  mocking a live Meter Event call; genuinely verifying delivery is a manual
  step (run the setup script with a real test-mode key, trigger a real
  sync, check the Stripe Dashboard's Meters view), same as this repo has
  never had a stripe-mock server wired in.

  **Rules engine: `webhook` action — built**, a fourth action type
  alongside `route_to_warehouse`/`hold_order`/`send_notification` —
  POSTs a small JSON body (`event`, `orderId`, `ruleId`, `ruleName`,
  `occurredAt`) to a tenant-configured URL, the general-purpose escape
  hatch into any external system (Slack via an incoming webhook, Zapier,
  a tenant's own internal service) that doesn't need a purpose-built
  integration. Same "collect during the transaction, dispatch after it
  commits" discipline `send_notification` already established
  (`RuleSideEffect`, a small discriminated union of `RuleNotification` |
  `RuleWebhookCall`, replaces the old single-purpose `pendingNotifications`
  list so a third kind of deferred side effect is one more union member
  and `case`, not a third parallel array) — `dispatchWebhook()` never
  throws and isn't retried, so (like `send_notification`) a
  `rule_executions` row shows `applied: true` once the call is *built*,
  regardless of whether the tenant's endpoint actually receives it.
  `buildRuleWebhookCall()` requires `action.value` to be a non-empty,
  `https:`-only URL (no bare-string "no target" default the way
  `send_notification`'s value is optional — a webhook needs somewhere
  real to go) and rejects it outright — before ever calling `fetch()` —
  if it targets a private/internal address, via a new exported pure
  helper, `isBlockedWebhookHost()`: loopback, RFC1918/link-local ranges,
  `169.254.169.254` (the AWS/GCP/Azure instance-metadata endpoint, the
  first thing any SSRF writeup checks), and bare `localhost`/`*.local`.
  **Honest, documented limitation, not silently swept under the rug**:
  this checks the literal hostname/IP text in the URL a tenant typed, not
  the IP `fetch()` actually resolves and connects to at request time — it
  does not defend against DNS rebinding (a public-looking hostname whose
  DNS record points at an internal address). Real protection against that
  would mean resolving DNS here first, validating *that* IP, and pinning
  the outbound connection to it — meaningfully more infrastructure than
  this pass builds, flagged plainly rather than left as an unstated gap,
  the same "wire it now, note the real limitation" discipline this
  codebase already applies elsewhere (e.g. `CHANNEL_CREDENTIALS_ENCRYPTION_KEY`'s
  own "interim stand-in for the KMS-backed encryption CLAUDE.md §6 calls
  for" framing). Bounded by a 5s timeout (`WEBHOOK_TIMEOUT_MS`, via
  `AbortSignal.timeout()`) so a hanging tenant endpoint can never stall
  the rules engine. `/rules`' own subtitle and action-JSON help text
  document all of this plainly, same as `hold_order`-on-`order.backordered`'s
  own caveat already does. Tested in `packages/rules-engine/test/
  webhook-integration.test.ts` (7 tests: the happy-path POST body shape;
  firing on `order.backordered` too, not just `order.received`; non-https
  rejected; a blocked/internal target rejected *before* `fetch()` is ever
  called; a missing/empty value rejected; a failed/500 delivery still
  recording `applied: true`; and `isBlockedWebhookHost()`'s own pure
  unit-test table) — via the same `globalThis.fetch` interception this
  codebase already uses for Resend, since (unlike Stripe's SDK, which
  defaults to Node's own `http`/`https` client) this action's outbound
  call is deliberately implemented with `fetch()` specifically so it's
  testable this way.

  Returns
  handling — **built**, see §2.2/§3. Rate-limit
  hardening, circuit breakers — **built**, see §4.4. Observability dashboards —
  **built**, see §13: Sentry is wired end-to-end across packages/web and every
  backend job/scheduler script, with every DSN left unset — no real Sentry account
  exists yet, so this is wired-and-ready, not proven against a live account (same
  "wire it now, verify later" status Amazon's/Walmart's/eBay's own credentials
  carried before their first live pass). The `[ALERT]`-tagged log lines §4.4
  describes now also fire a Sentry event alongside the log line, not instead of it.
  - **Decided (Arif, this pass): keep deferring the CDC-fed store, not a change to the
    phase order** — the open question above is resolved, not just left open longer.
    Reasoning: unlike RLS (§11 item 6, a correctness/security problem — wrong from day
    one leaks tenant data), the CDC-fed store is a performance/scaling concern that
    degrades gracefully and is visible well before it's a real problem, so there's no
    "expensive to retrofit" clock running the same way. At today's real volume
    (effectively one live tenant — Arif's own Amazon seller account, still in testing,
    no other sellers onboarded yet), building Debezium + ClickHouse/BigQuery now would
    be standing up infra to solve a problem that doesn't exist yet — the same
    "don't build infra a single self-testing tenant hasn't earned" call already made
    for Redis/BullMQ and Kafka (§4.4, §1).
  - **Concrete revisit trigger, so this doesn't stay a vague "later"**: whichever
    happens first — (a) a real tenant's `/reports` page becomes visibly/measurably
    slow, or (b) any tenant's monthly order volume crosses roughly 10,000-20,000
    orders/month (the point `inventory_events`' own growth, §2.2's "Retrofit risk"
    note, starts making a plain-query report meaningfully more expensive than it is
    today). Until one of those two fires, `/reports`' plain-query approach stays as-is
    — no infra work now.
- **Stock forecasting — built, v1 scope, moved up from Phase 5** (`@alltix/inventory-service`'s
  `computeDailyVelocity`/`computeDaysOfStockRemaining`/`assessStockForecast`,
  `/inventory`'s new "Est. days left" column, `/reports`' new "Reorder soon" section):
  deliberately simple, not a demand-forecasting model — recent sales velocity (units
  sold over a lookback window, from the same `inventory_events` ledger everything else
  reads, `-sum(quantity_delta) WHERE event_type = 'sale'`) divided into current
  `available` stock, nothing else. No seasonality, no trend detection, no external
  signals, no purchase-order automation — the same "start simple, earn the complexity
  later" call already made for the event bus, job queue, and `/reports`' own
  plain-queries-not-CDC approach right above this bullet.
  - Two call sites, two different windows, same pure functions: `/inventory` uses a
    fixed 30-day lookback (no period selector on that page); `/reports`' new "Reorder
    soon" section reuses that page's own existing `periodDays` selector (7/30/90/365)
    instead of introducing a second, separate period concept.
  - `computeDaysOfStockRemaining` returns two deliberately distinct non-identical
    "low" states: `0` when `available <= 0` (already out — a real, known answer), vs.
    `null` when there's simply no recent sales velocity to estimate from (available >
    0, zero sales in the window) — rendered as "no recent sales," never as 0 or
    Infinity. This means a low-stock product with zero recent sales will NOT be
    flagged by this feature, even though it may genuinely need attention — that case
    is already covered by `/inventory`'s separate, older, buffer-based `assessRisk`
    badge (channel_buffer vs. a flat fallback threshold), which this is a complement
    to, not a replacement for. The two signals can and do disagree (a product can be
    "LOW" by buffer but not "reorder soon" by velocity, or vice versa) — both are
    shown, deliberately, rather than one silently overriding the other.
  - Reorder threshold: `DEFAULT_REORDER_THRESHOLD_DAYS = 14`, an admittedly arbitrary
    but documented default (same status `/inventory`'s own
    `LOW_STOCK_FALLBACK_THRESHOLD` already carries) — not yet a real per-tenant
    setting anywhere; `assessStockForecast`'s own `reorderThresholdDays` parameter
    exists for that to be added later without changing this function's shape.
  - Unit-tested (`packages/inventory-service/test/forecast.test.ts`, 14 tests, pure
    functions, no DB needed — same "pure-function-first" precedent
    `extractUsShippingZip`/`rankByDistanceToShippingZip` already set in
    `packages/order-service/test/nearest-location-routing.test.ts`). The two pages'
    own SQL (`sum(-quantity_delta) ... WHERE event_type = 'sale'`) is NOT
    independently integration-tested against live Postgres this pass — consistent
    with every other read-only query already on `/inventory`/`/reports` (neither page
    has a test file at all; both inherit correctness from the ledger-writing services,
    which ARE tested, e.g. `recordShipmentSaleEvents`'s own sign convention this
    query relies on). Worth a quick visual sanity check against real data once this
    is live, same as every other report figure's own "first pass" status.
- **Phase 5 — Scale features (Months 9-12+)**: eBay, Temu, and TikTok Shop — all three
  built and wired into the app ahead of the rest of this phase, see §4.6/§4.7/§4.8 (all
  three remain UNVERIFIED against real infrastructure — no live credentials/sandbox for
  any of them yet, see each section's own note) — /additional channels. Stock
  forecasting — **built, moved up ahead of this phase**, see the bullet above.
  B2B portal (if pursuing Cin7-style ERP breadth). SOC 2 prep if targeting mid-market.

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

## 14. HR & Payroll Module (§0's locked decision — a module, not a separate product)

- **Why/scope**: this platform's own MVP customers (small-to-mid multichannel
  sellers, §0) run warehouse/fulfillment staff who need clocking-in and gross-pay
  visibility, but not full payroll processing (tax withholding, filings) — that's a
  correctly-scoped-out, jurisdiction-specific problem (task #34, deliberately not
  started this pass). This module ships the two layers that are NOT
  jurisdiction-specific: an employee directory + time tracking, and a gross wage
  calculation (hours × rate, no withholding) computed live over the tracked time.
- **Schema (`0028_hr_payroll_employees_and_time_entries.sql`)** — two new tables,
  same tenant-scoped RLS treatment (tenant_id + `USING`/`WITH CHECK` policy +
  `FORCE ROW LEVEL SECURITY` + `GRANT ... TO app_user`) as every other table in this
  schema (§2's own pattern):
  - `employees` — `name`, `role` (free TEXT, not a fixed enum — this codebase's MVP
    customers already have their own job-title vocabulary; a fixed list just grows an
    "Other" escape hatch), `location_id` (nullable FK to `locations` — not every
    employee is tied to one warehouse), `hourly_rate` (nullable `NUMERIC(10,2)` — an
    employee can exist for time tracking alone before wage data is entered),
    `status` ('active'/'inactive').
  - `time_entries` — one row per shift, whichever way it was captured. Deliberately
    **one canonical shape**, not a separate "manual hours" field alongside
    clock_in/clock_out: a manually-entered shift still gets real clock_in/clock_out
    timestamps (the UI computes `clock_out = clock_in + N hours` when someone keys in
    "8 hours" instead of punching in/out), so gross-wage calculation and every other
    downstream reader sees one shape instead of branching on `entry_source` (kept
    purely as UI/audit provenance, 'clock' vs 'manual'). `clock_out IS NULL` means
    still clocked in — an open shift, not a zero-length one — enforced alongside a
    `CHECK (clock_out IS NULL OR clock_out > clock_in)`. `location_id` is nullable and
    independent of `employees.location_id` (a shift can be worked covering a
    different location than an employee's usual one).
  - **No `pay_periods`/`payroll_runs` table in this pass** — gross wage calculation
    (task #33) is a live query over an arbitrary tenant-chosen date range (hours
    derived from `time_entries`, rate from `employees.hourly_rate`), mirroring the
    existing `/reports` page's period-selector pattern, rather than a stored
    payroll-run state machine. A "what's been run vs. not" state machine is
    speculative until real payroll processing (task #34) actually needs to track
    that — adding it now would be building ahead of a requirement that doesn't exist
    yet.
  - `updated_at` follows this codebase's established convention (confirmed via
    `order-service`/`inventory-service`'s own UPDATE statements) of the
    application setting `updated_at = now()` explicitly per UPDATE — no DB trigger.
- **App wiring — `/hr` (employee directory + time tracking)**: form-POST-then-
  redirect-with-`?error=` mutations, same convention as `/locations`/`/products`/
  `/rules` (see those pages' own doc comments) — no client JS anywhere in this app.
  `POST /api/hr/employees/create` / `[id]/update` manage the directory (`name` isn't
  editable after creation — no request for it yet, unlike `role`/`location_id`/
  `hourly_rate`/`status`, which are all freely editable; marking an employee
  'inactive' rather than deleting, same "workflow record" precedent as
  locations/orders/picklists). `POST /api/hr/time-entries/clock-in` /
  `[id]/clock-out` drive the per-employee "Clock in"/"Clock out" button pair (only
  one button renders per employee, whichever their current open-shift state calls
  for); `clock-in` refuses a second open shift for the same employee so task #33's
  hours sum can never double-count an overlapping pair — see the real-concurrency
  fix below, since the obvious-looking guard here (`SELECT ... FOR UPDATE`) turned
  out not to be enough on its own. `POST /api/hr/time-entries/manual` adds a shift
  after the fact — still a real clock_in/clock_out pair (`clockIn` + `hours`
  computes `clockOut` server-side), not a separate shape; flagged there as a known
  limitation that `datetime-local`'s timezone-free string is parsed in the
  *server's* local timezone, not the browser's, since no tenant-timezone setting
  exists anywhere in this schema yet.
  - **Concurrency gap found and fixed (routine audit, not production)** — closing
    a real gap this section itself used to imply was already closed: `clock-in`'s
    `SELECT id FROM time_entries WHERE ... clock_out IS NULL FOR UPDATE` only locks
    ROWS THAT ALREADY EXIST. When an employee has no open shift yet (the common
    case — their last shift closed normally, or this is their first ever clock-in),
    that SELECT returns zero rows and locks nothing, so two genuinely concurrent
    clock-ins for the same employee (a double-click, two people at a shared kiosk)
    could both see "no open shift" and both INSERT — exactly the double-open-shift
    outcome this route's own doc comment already said it was trying to prevent, via
    a guard that didn't actually prevent it under real concurrency. Same class of
    bug CLAUDE.md's own allocation/transfer code is careful about elsewhere (§2.2,
    §3) — missed here because the HR module's business logic lives inline in the
    route rather than in a service package with its own concurrency test, per
    `packages/db/test/hr-rls.test.ts`'s own "no HTTP API test suite for these
    routes yet" admission. **Fixed** the way this codebase always closes this class
    of gap: at the database, not the application SELECT (migration
    `0029_time_entries_one_open_shift_per_employee.sql`, a partial UNIQUE index on
    `time_entries (tenant_id, employee_id) WHERE clock_out IS NULL`). A second
    concurrent INSERT now fails with a real `unique_violation` (23505), caught by
    the route the same way `/api/products/create` already catches a duplicate-SKU
    23505 — same friendly `time_entry_already_clocked_in` redirect error either
    way. The pre-existing `SELECT ... FOR UPDATE` stays as a fast, friendly
    early-exit for the common sequential case; it's no longer the correctness
    guarantee. Regression-tested in `packages/db/test/hr-rls.test.ts` — a direct
    reproduction of the route's own SELECT+INSERT transaction shape, run 10-way
    concurrently, proving exactly one clock-in succeeds and the employee never ends
    up with more than one open shift.
- **App wiring — `/hr/payroll` (task #33, gross wage calculation)**: a read-only
  report, same "plain Postgres query, not a separate read-optimized store" call
  `/reports` already makes (see its own doc comment) — `from`/`to` date-range GET
  params (`<input type="date">`, no client JS), defaulting to the trailing 14 days.
  Sums `time_entries` duration per employee via `extract(epoch FROM (clock_out -
  clock_in)) / 3600.0`, `FILTER (WHERE clock_out IS NOT NULL)` so a shift still
  open at query time is excluded from the hours sum (its duration isn't knowable
  yet) rather than silently truncated to "so far" — that employee still appears in
  the table with an "N still open" badge instead of being dropped. Gross pay =
  hours × `employees.hourly_rate`; an employee with hours but no rate set shows "no
  rate set" and is excluded from the total rather than treated as $0 — conflating
  "zero dollars" with "rate unknown" would be a real payroll error, not a rounding
  one.
- **Tests**: `packages/db/test/hr-rls.test.ts` — DB-layer tenant-isolation proof for
  both new tables (SELECT/UPDATE/INSERT cross-tenant, mirroring
  `channel-connections-rls.test.ts`'s own rigor), plus the two schema invariants the
  design leans on: `hourly_rate` nullable (an employee can exist for time tracking
  alone) and the `clock_out > clock_in` CHECK constraint. No page-level/route-level
  test suite exists for `/hr`/`/hr/payroll` yet — same gap `/locations` already has
  (there's no HTTP API test harness for a plain form-POST page in this codebase at
  all currently); verified instead via `tsc -b`, `next build`, and a manual
  `psql` smoke test of the payroll aggregate query's SQL (FILTER clauses, the
  `extract(epoch ...)` hours computation) against real rows.

### 14.1 Real payroll processor integration (task #34 — Arif's explicit pick: Check)

**Status: research/design only — NOT built.** No code exists yet; this section is the
scoping pass §14's own "explicitly out of scope, pending its own dedicated
research/scoping pass" line always pointed at. Nothing here should be treated as
implemented until a "Wired into the app" note like every channel connector's own
(§4.1-§4.7) appears below it.

**Why this needs a real processor, not more of this codebase's own SQL**: §14's
gross-wage view (hours × rate) deliberately stops short of tax withholding,
deductions, filings, and actually moving money to an employee's bank account —
getting federal/state/local withholding tables, quarterly/annual filings (941, 940,
state unemployment, W-2s, etc.) right is a regulated, jurisdiction-by-jurisdiction
problem with real legal liability for getting it wrong, not a business-logic problem
this team should build in-house. Same "buy, don't build — not your differentiator"
call §5's tech stack table already makes for auth (Clerk) and billing (Stripe
Billing).

**Vendor research (this pass)**: the relevant market isn't general payroll software
(ADP, QuickBooks Payroll) but **embedded/API-first payroll infrastructure** —
vendors built specifically for a platform like this one to offer payroll as a
feature to ITS OWN tenants, under alltix-oms's own brand. Four compared:

| Vendor | Coverage | Integration surface | Notes |
|---|---|---|---|
| **Check** (chosen) | All 50 US states + DC | Full REST API, or prebuilt white-label "Components" (Onboard, Run Payroll) adopted incrementally | API-first design — "Flexible Payroll API" with optional components, not iframe-only. $4.1B in payroll moved in 2024 (real scale, not a startup toy). |
| Gusto Embedded | All 50 US states + DC | REST API, React SDK, or prebuilt iframe "Flows" | Most recognized brand; Flows can launch in ~4 weeks with the least engineering, at the cost of API depth/control. |
| Zeal | All 50 US states + DC | REST API only, no prebuilt UI components | Positions itself as the leanest/most startup-friendly of the group — worth revisiting if Check's actual quote comes back too expensive for this stage. |
| Salsa | US + Canada | REST API or GraphQL, plus a "Salsa Express" UI component | Only one of these four with Canada coverage — irrelevant given CLAUDE.md §0's US-only customer base (Amazon NA/Walmart US/eBay/Temu US), so not seriously considered. |

**None of these four publish self-serve pricing** — every one gates cost/revenue-share
terms behind a sales conversation, confirmed across multiple searches and vendor
pages. This is a real, load-bearing gap: task #34's actual next step is Arif getting
a real quote (and likely a sandbox API key) from Check's sales team — something this
research pass cannot do on its own. Nothing below should be built against a live
Check API until that account exists, same "UNVERIFIED pending real credentials"
discipline this codebase already holds Walmart/eBay/Temu to (§4.2/§4.6/§4.7).

**Check's confirmed data model** (from `docs.checkhq.com`, not yet exercised against
a live account): `Company` (the tenant, requires EIN verification), `Employee`/
`Worker` and `Contractor`, `Pay Schedule`, `Payroll` (a pay run), bank accounts
(linked via Plaid), and tax documents. Two integration depths: the raw API for full
programmatic control, or **Check Components** — prebuilt, white-labeled iframes for
"Onboard" (collects an employee's bank details, tax withholding elections, and tax
form e-signature in one flow) and "Run Payroll" (submits a pay run with a live
preview/totals before finalizing).

**Design direction (not yet built)**: use Check Components for v1, not the raw API —
same reasoning as choosing Check over Gusto's own Flows isn't really "components vs.
API," it's that **building a custom UI for bank-account linking and tax-withholding-
election collection would mean re-implementing a highly regulated, liability-heavy
surface Check has already built and battle-tested**, which is exactly the kind of
work §5's "buy, don't build" table already says this team shouldn't take on itself.
Sketch of the flow once a real account exists: a new `/settings/payroll` connects a
tenant's Check `Company` (their own EIN/bank via the Onboard Component, embedded,
not collected into this app's own DB — a deliberate privacy/liability boundary, not
an oversight); each `employees` row gets a nullable `check_employee_id` (an
expand-only column, added only when this is actually built, not before) once that
employee completes their own Check Onboard flow; a pay run is triggered from THIS
app's own already-built gross-wage view (§14, task #33) — `time_entries` stays the
system of record for hours worked, Check becomes the system of record for money
movement and tax compliance only, not a second place hours get tracked. A new
`payroll_connections` table (tenant_id + encrypted Check API key + `check_company_id`
+ status) would mirror `channel_connections`' own shape (§2.4) but scoped to one
processor per tenant, not one row per channel/marketplace pair.

**Explicitly not decided/built yet**: the actual schema migration, any UI, any
`packages/` service/connector code, and — most importantly — whether Check's real
pricing is viable at this platform's current single-self-testing-tenant stage (§0).
Revisit once Arif has a real quote.

---

*This document reflects standard, well-documented patterns for multichannel OMS/IMS
platforms plus the publicly documented behavior of the Amazon SP-API and Walmart
Marketplace API — not the proprietary internals of any specific vendor.*
