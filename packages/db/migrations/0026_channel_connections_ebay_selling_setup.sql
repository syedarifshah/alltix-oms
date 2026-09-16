-- Adds the tenant-level eBay selling prerequisites CLAUDE.md §4.6 flagged as
-- the reason eBay had NO outbound listing creation at all: eBay's Inventory
-- API requires an offer to carry a fulfillment/payment/return business
-- policy id (all three -- confirmed at
-- developer.ebay.com/api-docs/sell/static/inventory/publishing-offers.html:
-- "All three policies are required to publish offers and create active
-- listings through the Inventory API") and a merchantLocationKey pointing at
-- an already-created inventory location, before publishOffer() can ever
-- succeed.
--
-- These are NOT secrets -- a business policy id and a merchant-defined
-- location key are opaque identifiers, not credentials -- so plain TEXT
-- columns, not pgcrypto-encrypted like encrypted_client_secret/
-- encrypted_refresh_token. Prefixed `ebay_` (unlike this table's existing
-- generic columns, e.g. lwa_client_id reused across Amazon/Walmart/eBay's
-- own OAuth client id) because these four concepts exist for no other
-- channel today -- a generic name would misleadingly suggest they might be.
--
-- All four nullable: an existing eBay connection (from before this
-- migration, or a freshly-OAuth-connected one) has none of this configured
-- yet -- EbayConnector.createListing() checks for all four and fails with a
-- clear, actionable error rather than attempting a publishOffer() call
-- that's guaranteed to be rejected by eBay itself. Populated via two new
-- /settings/channels forms: choosing existing policies (fetched live from
-- the tenant's own eBay account via the Account API -- this app does not,
-- and does not plan to, create business policies on a tenant's behalf; see
-- EbayConnector.fetchBusinessPolicies()'s own doc comment for why that's a
-- deliberately bigger, separate scope) and creating a new merchant location
-- via the Inventory API. Expand-only per CLAUDE.md §9.
ALTER TABLE channel_connections ADD COLUMN ebay_fulfillment_policy_id TEXT;
ALTER TABLE channel_connections ADD COLUMN ebay_payment_policy_id TEXT;
ALTER TABLE channel_connections ADD COLUMN ebay_return_policy_id TEXT;
ALTER TABLE channel_connections ADD COLUMN ebay_merchant_location_key TEXT;
