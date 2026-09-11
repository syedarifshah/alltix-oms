-- Fixes a live production bug: `invalid input syntax for type uuid: ""`
-- thrown from the Stripe webhook route (POST /api/webhooks/stripe) on
-- checkout.session.completed / customer.subscription.* events.
--
-- Root cause: every tenant_isolation_* RLS policy below casts
-- current_setting('app.tenant_id', true)::uuid directly. Postgres's
-- documented behavior for a custom (non-declared) GUC on a *pooled*
-- connection is that once SET LOCAL app.tenant_id = '...' has run at least
-- once on that physical backend (i.e. any ordinary withTenant() call --
-- ~every ordinary page load), the value the setting reverts to after COMMIT
-- is an empty string '', not NULL -- even though current_setting(name, true)
-- is documented to return NULL for a setting that was never touched at all.
-- pg.Pool reuses physical connections across unrelated requests, so a
-- connection that previously served a normal withTenant() request can later
-- be handed to withStripeCustomer() (packages/db/src/pool.ts), which
-- deliberately leaves app.tenant_id unset. On `tenants`, which OR's
-- tenant_isolation_tenants together with stripe_customer_self_lookup_tenants
-- (migration 0016), that stale '' then hits ''::uuid and throws --
-- confirmed live via Vercel function logs on 11 Sept 2026 (see the
-- checkout.session.completed failure logged as "processing failed:
-- invalid input syntax for type uuid: \"\"").
--
-- This isn't unique to `tenants` -- every table below has exactly this same
-- unguarded cast, so the same failure is latent anywhere a future second
-- permissive policy (or any code path that queries a tenant-scoped table
-- without first calling withTenant()) reuses a connection that's already
-- been "poisoned" this way. Fixing all of them now rather than only
-- `tenants`, per CLAUDE.md §11 item 6 (RLS correctness is cheap now,
-- expensive to retrofit once this class of bug has more surface area).
--
-- Fix: NULLIF(current_setting('app.tenant_id', true), '') turns that stale
-- '' back into a real SQL NULL before the ::uuid cast ever runs, so the cast
-- always sees either a real UUID string or NULL (which casts to NULL, not
-- an error) -- matching the behavior every caller already assumed.
--
-- Expand-only per CLAUDE.md §9: DROP + CREATE POLICY only, no table/column
-- change, no app code change required, safe to apply without a deploy
-- coordination window.

DROP POLICY tenant_isolation_tenants ON tenants;
CREATE POLICY tenant_isolation_tenants ON tenants
  USING (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY tenant_isolation_locations ON locations;
CREATE POLICY tenant_isolation_locations ON locations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY tenant_isolation_products ON products;
CREATE POLICY tenant_isolation_products ON products
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY tenant_isolation_channel_listings ON channel_listings;
CREATE POLICY tenant_isolation_channel_listings ON channel_listings
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY tenant_isolation_inventory_events ON inventory_events;
CREATE POLICY tenant_isolation_inventory_events ON inventory_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY tenant_isolation_inventory_levels ON inventory_levels;
CREATE POLICY tenant_isolation_inventory_levels ON inventory_levels
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY tenant_isolation_orders ON orders;
CREATE POLICY tenant_isolation_orders ON orders
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY tenant_isolation_order_lines ON order_lines;
CREATE POLICY tenant_isolation_order_lines ON order_lines
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY tenant_isolation_automation_rules ON automation_rules;
CREATE POLICY tenant_isolation_automation_rules ON automation_rules
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY tenant_isolation_channel_connections ON channel_connections;
CREATE POLICY tenant_isolation_channel_connections ON channel_connections
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY tenant_isolation_picklists ON picklists;
CREATE POLICY tenant_isolation_picklists ON picklists
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY tenant_isolation_picklist_lines ON picklist_lines;
CREATE POLICY tenant_isolation_picklist_lines ON picklist_lines
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY tenant_isolation_rule_executions ON rule_executions;
CREATE POLICY tenant_isolation_rule_executions ON rule_executions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY tenant_isolation_tenant_usage ON tenant_usage;
CREATE POLICY tenant_isolation_tenant_usage ON tenant_usage
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
