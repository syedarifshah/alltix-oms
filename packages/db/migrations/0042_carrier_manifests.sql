-- Real Parcelforce manifest generation (CLAUDE.md §19.4/§19.10/§19.11's own
-- standing "Deliberately not built this pass" line, closed out this pass).
-- ShipEngine's own documented Parcelforce integration guide states plainly:
-- "Manifests are required for Parcelforce Worldwide shipments and must be
-- printed" -- confirming createManifest/printManifest (both real, confirmed
-- operation NAMES on expressLink's own ShipServiceSoapBinding, see
-- ParcelforceConnector's own class doc comment) are load-bearing, not
-- decorative WSDL entries. shipments.status (migration 0039) already had a
-- 'manifested' value in its own CHECK constraint from the very first carrier
-- migration -- this table and column are what finally give that value a real
-- writer.
--
-- Written with the guarded NULLIF(...) tenant_id cast from the start
-- (CLAUDE.md §18) -- this table is new as of this migration, so there is no
-- excuse to reproduce the bug class §18 spent two rounds fixing; crib the
-- guarded form directly, per §18's own closing instruction.

-- carrier_manifests: one row per real manifest actually generated with a
-- carrier -- a single manifest can (and typically does) cover many
-- shipments at once, the real-world "close of day, hand everything to the
-- driver at once" convention every UK courier's own manifest step follows
-- (the only shape any source this codebase's own research could confirm
-- even generally -- see ParcelforceConnector.generateManifest()'s own doc
-- comment). A separate table rather than duplicating manifest_number/
-- document_base64 onto every one of N shipments rows it covers -- same "the
-- ledger should show why, don't repeat the same large blob N times"
-- reasoning shipment_tracking_events (migration 0041) already applies to a
-- different one-to-many relationship in this same layer.
CREATE TABLE carrier_manifests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  carrier TEXT NOT NULL,
  carrier_connection_id UUID REFERENCES carrier_connections (id),
  -- Nullable: a close-of-day manifest call with nothing pending to manifest
  -- is a real, non-error outcome (see generateManifest()'s own doc comment),
  -- not something this codebase fabricates a row for -- so in practice this
  -- column is only ever NULL if a future caller inserts a placeholder row,
  -- which nothing in this pass does; kept nullable rather than NOT NULL
  -- purely because no confirmed schema exists to prove it can never be
  -- empty on Parcelforce's own side either.
  manifest_number TEXT,
  -- Base64 manifest document (PDF), same "no object-storage integration
  -- exists yet, same 'no infra a single self-testing tenant hasn't earned
  -- yet' call already made for Redis/BullMQ/Kafka" reasoning
  -- shipments.label_base64 (migration 0039) already documents for its own
  -- inline storage.
  document_base64 TEXT,
  raw_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_carrier_manifests_tenant_id ON carrier_manifests (tenant_id);

ALTER TABLE carrier_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE carrier_manifests FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_carrier_manifests ON carrier_manifests
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- No UPDATE/DELETE grant -- append-only by construction, same discipline
-- audit_log (migration 0034, CLAUDE.md §17) and shipment_tracking_events
-- (migration 0041) both already establish for a record that should never be
-- edited or erased after the fact.
GRANT SELECT, INSERT ON carrier_manifests TO app_user;

-- shipments.manifest_id: links every shipment a manifest actually covered
-- back to that one manifest row -- nullable (most shipments, at any given
-- moment, haven't been manifested yet), no ON DELETE (carrier_manifests rows
-- are never deleted, same "status-flipped/append-only, never deleted"
-- precedent every other carrier-layer FK in this schema already follows).
ALTER TABLE shipments ADD COLUMN manifest_id UUID REFERENCES carrier_manifests (id);
