-- Sapient tracking webhook receiving (CLAUDE.md §19.9) -- the honest fix for
-- the real, documented architectural mismatch EvriConnector.trackShipment()/
-- DpdConnector.trackShipment() have carried since Evri was built (§19.2):
-- POST /v4/trackings is meant for registering tracking numbers from OTHER
-- systems, not polling a shipment created within the same Sapient account.
-- Sapient's own docs confirm real tracking delivery is a configured
-- webhook instead -- this migration is the storage side of receiving it.
--
-- Arif's own explicit pick ("Sapient webhook receiving (Recommended)") among
-- 4 AskUserQuestion options, once carrier feature-flags (§19.8) closed out
-- that round's own recommended pick.
--
-- Written with the guarded NULLIF(...) tenant_id cast from the start
-- (CLAUDE.md §18) -- this table is new as of this migration, so there is no
-- excuse to reproduce the bug class §18 spent two rounds fixing; crib the
-- guarded form directly, per §18's own closing instruction.

-- shipment_tracking_events: one row per tracking update Sapient pushes, an
-- append-only ledger of what was actually received -- same "the ledger
-- should show why, not just the latest state" principle CLAUDE.md §3
-- already applies to order cancellation and §2.2 applies to inventory_events
-- (this table is this feature's own equivalent of that ledger: every event
-- ever delivered is kept, not overwritten in place).
--
-- shipment_id is nullable-in-practice-never (NOT NULL, no ON DELETE --
-- shipments rows are never deleted, only voided, same "status-flipped, never
-- deleted" precedent channel_connections/carrier_connections both already
-- establish for their own FKs) -- a webhook delivery this codebase cannot
-- match to a known shipment (an unrecognized tracking number) is
-- deliberately NOT inserted here at all; see the receiver route's own doc
-- comment for why that's acked with 200 and just logged, not stored as an
-- orphan row with no tenant to scope it to.
--
-- event_code/milestone/description/location/occurred_at are all NULLABLE:
-- unlike every carrier request BODY this codebase builds (where a missing
-- required field is this app's own mistake), this is a payload SHAPE this
-- research pass could not confirm field-by-field (Sapient's own docs render
-- the "Tracking Webhook Push Payload Example" reference page via a
-- client-side widget this pass's fetch tooling could not extract text from
-- -- see the receiver route's own header comment for the full research
-- trail). Read defensively across several candidate field-name shapes, same
-- "read several plausible candidates, never assume one is right" discipline
-- EvriConnector's/DhlConnector's own least-confirmed response parsing
-- already establishes -- a field this pass's parser doesn't recognize is
-- simply NULL on that row, not a reason to reject the whole delivery.
--
-- idempotency_key is UNIQUE, same purpose inventory_events.idempotency_key
-- already serves (migration 0001-era schema, CLAUDE.md §2.2): Sapient's own
-- CONFIRMED retry policy (8 attempts, 5 minutes up to 72 hours apart, per
-- docs.intersoftsapient.net/docs/webhook-suspension) means the SAME event
-- can genuinely arrive more than once if this endpoint's own 200 response
-- didn't reach Sapient the first time -- without this, a redelivered event
-- would double-count in the tracking history. Best-effort, not a confirmed
-- Sapient event id (none was found) -- see the receiver route's own doc
-- comment for exactly what it's built from.
--
-- raw_payload keeps the complete, untouched delivery body -- same "last-seen
-- raw channel data, for debugging/replay" precedent channel_listings.raw_payload
-- (CLAUDE.md §2.1) and every carrier connector's own shipment.raw already
-- establish, worth doubling down on here specifically since this table's own
-- structured columns are the least-confirmed shape in this entire migration.
CREATE TABLE shipment_tracking_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  shipment_id UUID NOT NULL REFERENCES shipments (id),
  carrier TEXT NOT NULL,
  event_code TEXT,
  milestone TEXT,
  description TEXT,
  location TEXT,
  occurred_at TIMESTAMPTZ,
  raw_payload JSONB NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_shipment_tracking_events_tenant_id ON shipment_tracking_events (tenant_id);
CREATE INDEX idx_shipment_tracking_events_shipment_id ON shipment_tracking_events (shipment_id);

ALTER TABLE shipment_tracking_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipment_tracking_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_shipment_tracking_events ON shipment_tracking_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- No UPDATE/DELETE grant -- append-only by construction, not by convention,
-- same "the application literally cannot edit or erase a row" discipline
-- CLAUDE.md §17's audit_log table already establishes (that migration's own
-- GRANT covers only SELECT/INSERT for app_user, verified directly against a
-- real Postgres rather than just by code inspection -- worth doing the same
-- smoke test here before this ships, per §19.9's own Tests paragraph).
GRANT SELECT, INSERT ON shipment_tracking_events TO app_user;

-- shipments gains three columns for "what's the current status," recomputed
-- directly on the row rather than requiring a join against the ledger above
-- on every read -- same "recompute latest state directly on the row, keep
-- full history in a child table" convention channel_connections' own
-- consecutive_failures/last_failure_at/last_failure_message columns already
-- establish alongside audit_log's separate full history.
ALTER TABLE shipments
  ADD COLUMN latest_tracking_status TEXT,
  ADD COLUMN latest_tracking_milestone TEXT,
  ADD COLUMN latest_tracking_at TIMESTAMPTZ;
