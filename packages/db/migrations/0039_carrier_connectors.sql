-- Carrier/Shipment Integration (Arif's explicit pick, "add FedEx, UPS, DHL,
-- Royal Mail, Parcelforce, DPD, Evri, Hermes" -- 5-question AskUserQuestion
-- round this pass: full scope eventually -- structured carrier picklist,
-- full carrier API integration (labels/tracking/rates), peak-season
-- surcharge monitoring, across all 8 -- phased carrier-first, Royal Mail
-- built completely before any other carrier, same "prove the pattern on one,
-- like Amazon among marketplaces" reasoning CLAUDE.md §4.6/§4.7/§4.8 already
-- used for eBay/Temu/TikTok among channels).
--
-- This is a NEW top-level integration layer, deliberately not folded into
-- channel_connections: a carrier is not a sales channel (no orders pulled,
-- no listings pushed, no inventory synced) -- it is the thing a WAREHOUSE
-- talks to once an order is already packed, a structurally different
-- relationship. CLAUDE.md §4.3's ChannelConnector interface has no method
-- that fits "generate a label" or "get a live tracking scan history" either.
--
-- Written from the start with the guarded NULLIF(...) tenant_id cast
-- (CLAUDE.md §18) -- every one of these three tables is NEW as of this
-- migration, so there is no excuse to reproduce the bug class §18 spent two
-- rounds fixing across six other tables; crib the guarded form directly, per
-- §18's own closing instruction.

-- carrier_connections: one row per (tenant, carrier) -- like
-- payroll_connections (migration 0038), not like channel_connections
-- (migration 0012, tenant+channel+marketplace+external_account_id): a
-- carrier has no per-marketplace-region concept the way a sales channel
-- does, so a plain UNIQUE(tenant_id, carrier) is the right constraint, same
-- "one processor per tenant" reasoning 0038's own doc comment gives for
-- Check.
--
-- Credential shape deliberately mirrors channel_connections' own three
-- encrypted-secret columns (client_id/client_secret/access_token) rather
-- than inventing a carrier-specific shape up front: every carrier
-- researched so far (Royal Mail's Bearer-token Click & Drop API, but also
-- FedEx/UPS/DHL's own well-known OAuth2 client_credentials shapes) fits
-- some subset of {client_id, client_secret, access_token, refresh_token} --
-- same "generic enough to reuse across a structurally different second
-- carrier" bet already proven right for channel_connections across six
-- channels (CLAUDE.md §4.3's own "don't trust this interface until channel
-- #2" caution, now applied here preemptively instead of learned the hard
-- way a second time).
CREATE TABLE carrier_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  carrier TEXT NOT NULL CHECK (
    carrier IN ('royal_mail', 'fedex', 'ups', 'dhl', 'parcelforce', 'dpd', 'evri', 'hermes')
  ),
  encrypted_client_id BYTEA,
  encrypted_client_secret BYTEA,
  encrypted_access_token BYTEA,
  encrypted_refresh_token BYTEA,
  external_account_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disconnected', 'error')),
  consecutive_failures INT NOT NULL DEFAULT 0,
  last_failure_at TIMESTAMPTZ,
  last_failure_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, carrier)
);

CREATE INDEX idx_carrier_connections_tenant_id ON carrier_connections (tenant_id);

ALTER TABLE carrier_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE carrier_connections FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_carrier_connections ON carrier_connections
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON carrier_connections TO app_user;

-- shipments: one row per real carrier-generated shipment (a label actually
-- requested from Royal Mail/etc.), distinct from and upstream of
-- WarehouseService.confirmShipment()'s existing TrackingInfo. That existing
-- flow tells the ORDER'S CHANNEL (Amazon/Shopify/...) that an order shipped
-- -- it has always assumed a human already has a real carrier/tracking
-- number in hand (today: typed into /picklists' free-text "Carrier (e.g.
-- UPS)" field). This table is the missing piece before that: the CARRIER
-- SIDE record of a real label actually being generated, whose own
-- tracking_number is what then flows into that existing TrackingInfo call
-- -- see CarrierConnector.createShipment()'s own doc comment
-- (packages/carrier-connectors/src/connector.ts) for the full sequencing.
--
-- Not UNIQUE(tenant_id, order_id): a void-and-recreate (a mis-weighed
-- package, a wrong service selected) needs a second row for the same
-- order, not an UPDATE-in-place that would lose the voided shipment's own
-- history -- same "the ledger should show why, not just the new state"
-- principle CLAUDE.md §3 already applies to order cancellation. Callers
-- needing "the current shipment for this order" filter to
-- status != 'void' and take the most recent.
CREATE TABLE shipments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  order_id UUID NOT NULL REFERENCES orders (id),
  carrier_connection_id UUID REFERENCES carrier_connections (id),
  carrier TEXT NOT NULL,
  service_code TEXT,
  carrier_order_id TEXT,
  tracking_number TEXT,
  -- Base64 label document (Royal Mail's own CreateOrderResponse.label field,
  -- confirmed shape -- see RoyalMailConnector's own doc comment). Stored
  -- inline rather than re-fetched on demand: Royal Mail's API has no GET
  -- for a previously-generated label by itself outside GET
  -- /orders/{id}/label, and this codebase has no object-storage
  -- integration (S3/GCS/etc.) to hand a large binary off to instead -- same
  -- "no infra a single self-testing tenant hasn't earned yet" call already
  -- made for Redis/BullMQ/Kafka (CLAUDE.md §1, §4.4). A real multi-tenant
  -- deployment at scale would want this in object storage, not inline
  -- TEXT -- flagged here rather than silently assumed fine at any size.
  label_base64 TEXT,
  weight_grams INT,
  -- Estimated cost only -- Royal Mail's Click & Drop API has no live
  -- rate-shopping/quote endpoint (confirmed: absent from both the official
  -- swagger spec and the official API product listing -- see
  -- RoyalMailConnector's own class doc comment). This is either a
  -- tenant-entered shippingCostCharged (the field the order-creation
  -- request itself requires) or a lookup against carrier_surcharges/a
  -- static published price table, never a live quoted price.
  cost NUMERIC(10, 2),
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'manifested', 'void', 'error')),
  raw_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_shipments_tenant_id ON shipments (tenant_id);
CREATE INDEX idx_shipments_order_id ON shipments (order_id);

ALTER TABLE shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipments FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_shipments ON shipments
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON shipments TO app_user;

-- carrier_surcharges: platform-wide reference data (peak-season/fuel/other
-- surcharge thresholds), NOT tenant-scoped -- the first table in this
-- schema with no tenant_id column at all. Every other table in this
-- database is either genuinely per-tenant data or, like this one, was
-- deliberately never built until now because nothing needed pure global
-- reference data before. RLS is still enabled with a USING (true) policy
-- rather than left off entirely -- same "defense-in-depth stays on even for
-- a non-tenant table" precedent demo_requests' own
-- public_insert_demo_requests policy sets (migration 0017, cited directly
-- in CLAUDE.md §16's public-rate-limit-windows paragraph), applied here to
-- a read-only table instead of a public-insert one.
--
-- Seeded with Royal Mail's own real, dated, published figures (CLAUDE.md's
-- own research this pass, confirmed live against
-- royalmail.com/business/mail/surcharges) -- not synthetic placeholder
-- numbers. amount_type distinguishes a flat per-item GBP charge from a
-- percentage-of-postage charge (Fuel/Energy Surcharge is a %, Peak/Green
-- Surcharges are flat per item) -- one numeric column can't represent both
-- meaningfully without this discriminator.
CREATE TABLE carrier_surcharges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  carrier TEXT NOT NULL,
  surcharge_name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('uk', 'international', 'all')),
  starts_on DATE,
  ends_on DATE,
  amount_type TEXT NOT NULL CHECK (amount_type IN ('flat_gbp', 'percent')),
  amount NUMERIC(10, 4) NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_carrier_surcharges_carrier ON carrier_surcharges (carrier);

ALTER TABLE carrier_surcharges ENABLE ROW LEVEL SECURITY;
ALTER TABLE carrier_surcharges FORCE ROW LEVEL SECURITY;

CREATE POLICY public_read_carrier_surcharges ON carrier_surcharges
  USING (true);

GRANT SELECT ON carrier_surcharges TO app_user;

-- Seed data: Royal Mail's real, currently-published peak-season and
-- standing surcharges (royalmail.com/business/mail/surcharges, confirmed
-- live this pass). UK Peak Surcharge and International Peak Surcharge
-- share the same 2026/2027 peak window; Fuel/Energy and Green Surcharges
-- are standing (no end date) as of this writing, re-confirm before relying
-- on these figures past that window -- Royal Mail revises them periodically
-- and this table has no live sync back to royalmail.com, by design (no such
-- API exists -- see RoyalMailConnector's own class doc comment).
INSERT INTO carrier_surcharges (carrier, surcharge_name, scope, starts_on, ends_on, amount_type, amount, notes) VALUES
  ('royal_mail', 'UK Peak Surcharge', 'uk', '2026-11-02', '2027-01-10', 'flat_gbp', 0.30, 'Range £0.10-£0.30/item for most services; up to £5.00 for Express48 Large -- this row stores the general per-item ceiling, not every per-service tier.'),
  ('royal_mail', 'International Peak Surcharge', 'international', '2026-11-02', '2027-01-10', 'flat_gbp', 0.25, 'Range £0.10-£0.25/item.'),
  ('royal_mail', 'Fuel/Energy Surcharge (UK)', 'uk', NULL, NULL, 'percent', 16.0, 'Standing surcharge, % of postage, no announced end date as of this research pass.'),
  ('royal_mail', 'Fuel/Energy Surcharge (International)', 'international', NULL, NULL, 'percent', 12.0, 'Standing surcharge, % of postage, no announced end date as of this research pass.'),
  ('royal_mail', 'Green Surcharge', 'all', NULL, NULL, 'flat_gbp', 0.05, 'Standing surcharge, £0.05/item, no announced end date as of this research pass.');
