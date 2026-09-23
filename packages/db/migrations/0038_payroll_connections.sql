-- Real Check payroll-processor integration (CLAUDE.md §14.1, task #34) --
-- schema half of the "wired but unverified" pass: built speculatively
-- against Check's documented API shape (docs.checkhq.com, confirmed live via
-- WebFetch this pass -- see CLAUDE.md §14.1's own updated notes for exactly
-- which pages), the same way Walmart/eBay/Temu/TikTok's own tables were
-- built ahead of ever having real credentials to test against. No real
-- Check API key exists anywhere in this codebase or this tenant's account
-- yet (a sales contact form was submitted -- see CLAUDE.md §14.1) -- nothing
-- here has round-tripped against sandbox.checkhq.com.
--
-- One row per TENANT, not one per (channel, marketplace, external_account_id)
-- triple the way channel_connections is (migration 0012) -- CLAUDE.md §14.1
-- is explicit that this is "one processor per tenant," unlike the six
-- multi-marketplace channels above it, so a plain UNIQUE(tenant_id) is the
-- correct constraint here, not channel_connections' own four-column one.
-- Deliberately a separate table rather than a new 'check' row shape bolted
-- onto channel_connections: Check is not a sales channel (no orders, no
-- listings, no inventory) and forcing it through that table's channel/
-- marketplace/external_account_id columns would make every one of them
-- either meaningless or overloaded for a payroll processor.
--
-- Encryption: same pgcrypto pgp_sym_encrypt/pgp_sym_decrypt interim
-- mechanism as channel_connections.encrypted_client_secret (migration 0012's
-- own doc comment explains why no real KMS integration exists yet) --
-- reuses packages/db/src/encryption.ts's existing encryptChannelSecret/
-- decryptChannelSecret functions rather than duplicating them under a new
-- name: despite the "Channel" in their names, they're already generic
-- tenant-secret encryption helpers keyed off CHANNEL_CREDENTIALS_ENCRYPTION_KEY,
-- and Check's API key is exactly the same shape of secret (a long-lived,
-- high-value bearer credential) as an OAuth client_secret/refresh_token.
--
-- check_company_id is nullable: connecting an API key (POST /api/payroll/connect)
-- and creating the Check Company resource itself (POST /api/payroll/company/create,
-- confirmed shape: POST https://sandbox.checkhq.com/companies) are two
-- separate steps in this build, same as how a channel_connections row can
-- exist before eBay's own Selling Setup (business policies, merchant
-- location) is complete -- see 0026_channel_connections_ebay_selling_setup.sql.
CREATE TABLE payroll_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL UNIQUE,
  encrypted_api_key BYTEA NOT NULL,
  check_company_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disconnected', 'error')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_payroll_connections_tenant_id ON payroll_connections (tenant_id);

ALTER TABLE payroll_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_connections FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_payroll_connections ON payroll_connections
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON payroll_connections TO app_user;

-- Expand-only, backward-compatible (CLAUDE.md §9), same precedent as
-- orders.channel_connection_id (migration 0037): nullable, no backfill,
-- zero behavior change for any existing employees row. Every employee ever
-- created before this migration, and every one created after it until a
-- tenant actually connects Check and runs that employee through Check
-- Onboard (POST /companies/{company}/components/employee_onboard,
-- confirmed component-generation shape -- see CLAUDE.md §14.1), keeps this
-- NULL.
--
-- Deliberately TEXT, not a foreign key -- this references a resource in
-- Check's own system, not a row in this database, the same way
-- channel_listings.external_id (ASIN / Walmart Item ID / Shopify variant
-- id) is a plain TEXT external identifier rather than a local FK.
--
-- time_entries stays the system of record for hours worked (CLAUDE.md
-- §14.1 is explicit about this) -- this column only ever lets this app
-- resolve "which Check Employee does this local employees row correspond
-- to," for the Run Payroll flow to look up each worker's Check-side record.
-- Check becomes the system of record for money movement/tax compliance
-- only, never a second place hours get tracked.
ALTER TABLE employees ADD COLUMN check_employee_id TEXT;

-- A given Check Employee resource should never be linked from more than one
-- local employees row for the same tenant -- partial (WHERE ... IS NOT
-- NULL) so this stays a no-op for every row that hasn't been onboarded to
-- Check yet, the overwhelming majority for the foreseeable future.
CREATE UNIQUE INDEX idx_employees_tenant_check_employee_id
  ON employees (tenant_id, check_employee_id)
  WHERE check_employee_id IS NOT NULL;
