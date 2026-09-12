-- Extends channel_connections (0012) to hold a Shopify custom-app
-- connection, alongside the Amazon rows it was originally built for.
--
-- Shopify's auth model is structurally simpler than Amazon's OAuth
-- (packages/channel-connectors/src/shopify-connector.ts's own header
-- comment): a single static, non-expiring Admin API access token
-- (shpat_...) -- no client id, no client secret, no refresh token. That
-- means three of this table's existing columns (lwa_client_id,
-- encrypted_client_secret, encrypted_refresh_token) are Amazon-specific
-- concepts a Shopify row has nothing to put in -- they're relaxed to
-- nullable here rather than given throwaway values, so a Shopify row can
-- legitimately leave them NULL instead of lying about having a client
-- id/secret/refresh token it doesn't have.
--
-- The token itself is long-lived and high-value (unlike Amazon's
-- short-lived, auto-refreshed `access_token` column, which is left
-- plaintext for exactly that reason -- see 0012's comment) -- closer in
-- sensitivity to Amazon's refresh_token, so it gets the same
-- pgcrypto-encrypted-at-rest treatment via a new column rather than
-- reusing the existing plaintext `access_token` column.
--
-- external_account_id (already "seller id / merchant id, channel-specific"
-- per 0012's comment) holds the store's *.myshopify.com domain for a
-- Shopify row -- the natural per-store identifier, same role sellerId
-- plays for Amazon. marketplace has no Shopify equivalent (one connected
-- store is one connection, full stop -- see normalizeShopifyOrder's own
-- channelMarketplace: "" convention) and is stored as '' for a Shopify row,
-- same as it does for orders/order_lines already normalized this way.
--
-- Expand-only per CLAUDE.md §9: relaxing NOT NULL and adding a nullable
-- column are both backward-compatible; no existing Amazon row's data or
-- shape changes.
ALTER TABLE channel_connections ALTER COLUMN lwa_client_id DROP NOT NULL;
ALTER TABLE channel_connections ALTER COLUMN encrypted_client_secret DROP NOT NULL;
ALTER TABLE channel_connections ALTER COLUMN encrypted_refresh_token DROP NOT NULL;
ALTER TABLE channel_connections ADD COLUMN encrypted_access_token BYTEA;
