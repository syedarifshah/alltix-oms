-- Closes the "KNOWN GAP" api/webhooks/shopify/route.ts's handleOrderCancelled
-- documented: a Shopify orders/cancelled delivery that arrives before the
-- corresponding order has ever been created locally (genuine out-of-order
-- delivery, or webhooks enabled after an order was already placed *and*
-- cancelled on Shopify) previously had nothing to cancel and was just
-- logged and dropped -- so a later orders/create delivery (or the daily
-- cron catch-up) would still insert the order as a normal 'received' order
-- and allocate real stock against it as if it had never been cancelled.
--
-- This is the "small 'seen but not yet local' staging table" option that
-- comment named but didn't build. A row here means "this external order was
-- reported cancelled by its channel before we ever saw it locally" --
-- handleOrderCancelled (route.ts) inserts one when it finds nothing to
-- cancel, and OrderService.persistPulledOrders() (packages/order-service)
-- deletes-and-consumes the matching row the moment it inserts that same
-- order for the first time, landing it straight in 'cancelled' instead of
-- walking it through the normal received -> validated -> allocated chain.
--
-- (tenant_id, channel, external_order_id) mirrors the exact same identity
-- triple orders' own UNIQUE constraint uses (CLAUDE.md §2.3) -- this table
-- is keyed to match, not to the orders row itself, since the whole point is
-- that the orders row doesn't exist yet when a record here is created.
-- channel is included (not hardcoded 'shopify') so this stays reusable if
-- another channel ever gets real-time cancellation webhooks -- only Shopify
-- populates it today.
CREATE TABLE early_channel_cancellations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  channel TEXT NOT NULL,
  external_order_id TEXT NOT NULL,
  cancelled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, channel, external_order_id)
);

CREATE INDEX idx_early_channel_cancellations_tenant_id ON early_channel_cancellations (tenant_id);

ALTER TABLE early_channel_cancellations ENABLE ROW LEVEL SECURITY;
ALTER TABLE early_channel_cancellations FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_early_channel_cancellations ON early_channel_cancellations
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- No UPDATE grant -- rows are only ever inserted (a cancellation arrives
-- early) and deleted (the matching order shows up and consumes it). Nothing
-- in the app ever modifies a row in place.
GRANT SELECT, INSERT, DELETE ON early_channel_cancellations TO app_user;
