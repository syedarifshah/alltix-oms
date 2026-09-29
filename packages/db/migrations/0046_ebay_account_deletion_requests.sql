-- eBay's own Marketplace Account Deletion/Closure Notifications compliance
-- requirement (developer.ebay.com's own confirmed spec): a Production
-- keyset with any OAuth scope that can touch personal data is blocked
-- ("Your key set is currently invalid") until the developer either
-- subscribes to this notification workflow or formally opts out declaring
-- no eBay user data is retained. This codebase genuinely does retain eBay
-- buyer data (orders.customer/orders.shipping_address, pulled per order via
-- EbayConnector.pullOrders()) -- opting out would be a false declaration to
-- eBay, so subscribing (this table + the endpoint that receives the real
-- notification) is the only honest path, not a preference.
--
-- Same shape as demo_requests (migration 0017): a genuinely cross-tenant,
-- not-tenant-scoped table -- a notification names an eBay MARKETPLACE
-- USER (buyer/seller account on eBay's side), which this app has no
-- reliable way to resolve to one specific tenant's own order rows at
-- ingestion time (an eBay username/userId/eiasToken isn't stored anywhere
-- on the orders/order_lines schema today -- only the raw shipping address/
-- customer JSONB pulled from eBay's own order payload). So this is
-- INSERT-only for app_user (no SELECT grant, no policy allowing it) --
-- reading a received deletion request back out and acting on it (finding
-- and erasing/anonymizing whatever order data actually matches) is a
-- deliberately manual operator task for now, done directly against
-- DATABASE_URL's owner role (bypasses RLS), not an automated pipeline --
-- see /api/webhooks/ebay/marketplace-account-deletion/route.ts's own
-- header comment for the honest scope line on why automated erasure isn't
-- attempted in this pass.
CREATE TABLE ebay_account_deletion_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ebay_username TEXT,
  ebay_user_id TEXT,
  eias_token TEXT,
  event_date TIMESTAMPTZ,
  raw_payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  processed_note TEXT
);

ALTER TABLE ebay_account_deletion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE ebay_account_deletion_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY public_insert_ebay_account_deletion_requests ON ebay_account_deletion_requests
  FOR INSERT
  WITH CHECK (true);

GRANT INSERT ON ebay_account_deletion_requests TO app_user;
