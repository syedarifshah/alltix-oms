import type { Pool } from "pg";
import { withTenant } from "@alltix/db";
import { InProcessEventBus, type EventBus } from "@alltix/shared";
import {
  createAmazonConnectorFromChannelConnection,
  SP_API_SANDBOX_TEST_CASE_CREATED_AFTER,
  createShopifyConnectorFromChannelConnection,
  createWalmartConnectorFromChannelConnection,
  type NormalizedShopifyProductVariant,
} from "@alltix/channel-connectors";
import { InventoryService } from "@alltix/inventory-service";
import { OrderService } from "@alltix/order-service";
import { RulesEngine } from "@alltix/rules-engine";

// The scheduled job that actually invokes pullOrders()/persistPulledOrders()
// on a real cadence -- CLAUDE.md §4.4's "Rate-Limited Job Queue" layer,
// deliberately NOT BullMQ yet. Only Amazon is live and nothing has hit a
// real SP-API rate limit in sandbox testing; BullMQ's actual value --
// per-tenant/per-marketplace/per-endpoint limiting, priority lanes,
// retry/backoff -- has nothing to bite on with one channel. Same "start
// simple, split out infra when scale demands it" call as the in-process
// EventBus. Bringing BullMQ in is triggered by either: Walmart going live
// (§4.4's limiting is explicitly per-marketplace, and that only starts
// mattering with a second, structurally different API sharing the job
// pool), or real tenant volume at the widened ceiling (CLAUDE.md §0, up to
// 50,000 orders/month) making sequential-per-tenant too slow for whatever
// cadence gets chosen.
//
// No cron/scheduler infra is built here -- nothing in this repo provisions
// one (no Vercel Cron config, no ECS scheduled-task Terraform). This module
// is the callable job logic; scripts/amazon-order-sync-job.ts is the
// directly-runnable entrypoint a real cron/ECS scheduled task/EventBridge
// rule would invoke on a cadence. Provisioning that trigger is separate,
// later infrastructure work.

/** First-sync lookback when a tenant has no channel_connections.last_order_sync_at
 *  yet -- an explicit, documented, tunable default rather than silently
 *  defaulting to "now" (which would skip any pre-existing unpulled orders). */
const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export interface TenantSyncResult {
  tenantId: string;
  success: boolean;
  insertedOrderIds: string[];
  skippedExternalOrderIds: string[];
  error: string | null;
}

/** Consecutive failed sync runs past which a channel_connections row's
 *  status flips from 'active' to 'error' -- see recordSyncFailure()'s doc
 *  comment for the full reasoning. Three, not one: a single transient
 *  network blip or a marketplace's momentary 503 shouldn't flip a healthy
 *  tenant to 'error' on the very next cron tick; three in a row is a much
 *  stronger signal of a genuinely dead credential/token than one. */
export const CONSECUTIVE_FAILURE_ERROR_THRESHOLD = 3;

/**
 * Records a failed sync attempt against the tenant's active channel_connections
 * row for this channel: increments consecutive_failures, stamps
 * last_failure_at/last_failure_message, and -- once
 * CONSECUTIVE_FAILURE_ERROR_THRESHOLD is reached -- flips `status` from
 * 'active' to 'error' in the same statement. This is the fix for the
 * "KNOWN GAP" every syncXTenant() catch block used to document (a dead
 * connection failing silently forever, with only per-run log lines and no
 * cross-run signal anywhere); it's a single shared helper rather than
 * three near-copies because the tracking logic itself -- increment a
 * counter, stamp a timestamp/message, threshold-flip a status -- is
 * identical across channels, unlike the sync functions themselves (which
 * differ in real, connector-specific ways: Amazon's isSandbox() lookback
 * branch has no Shopify/Walmart equivalent, see syncShopifyOrders's doc
 * comment).
 *
 * WHERE status = 'active' is deliberate, not incidental: once a row has
 * already been flipped to 'error' (by a prior call crossing the
 * threshold), this UPDATE matches zero rows and consecutive_failures stops
 * climbing -- an 'error' row is a fixed historical marker, not a counter
 * that keeps incrementing forever. It also means an 'error' row
 * self-removes from every syncXOrders() discovery query's own
 * `WHERE status = 'active'` filter, so a tenant that's been failing for
 * CONSECUTIVE_FAILURE_ERROR_THRESHOLD runs in a row stops being retried on
 * every subsequent cron tick -- retrying a connection that's this
 * consistently broken wastes calls against a marketplace that may itself
 * be rate-limiting/circuit-breaking the tenant (CLAUDE.md §4.4), and
 * fixes nothing a human reconnecting the credential wouldn't also
 * require. Recovery today is the tenant using the Reconnect form
 * (ChannelConnectForm et al. already verify live before writing
 * status = 'active' again -- see the connect routes) -- nothing here
 * auto-retries an 'error' row; an explicit "retry now" action is future
 * work, not attempted here.
 *
 * Alerting is log-based only, deliberately -- no email/Slack/notification
 * infra exists anywhere in this codebase (CLAUDE.md §5's Observability row
 * names Datadog/Sentry, not a notification service). The distinctly
 * "[ALERT]"-tagged console.error below fires exactly once per incident --
 * on the run that *crosses* the threshold, not on every failed run after
 * (the row leaves the 'active' pool at that point, so there is no "after"
 * to log) -- so a log-based alert (a Sentry issue, a Datadog log monitor
 * matching "[ALERT]") fires once, not once per cron tick for as long as
 * the tenant stays broken. The caller's own per-run console.error is
 * unchanged and still fires every time.
 *
 * Exported (along with {@link recordSyncSuccess} and
 * {@link CONSECUTIVE_FAILURE_ERROR_THRESHOLD}) purely so
 * test/sync-failure-tracking.test.ts can exercise this DB logic directly
 * against a real local Postgres, the same "exported for testability"
 * treatment walmart-connector.ts already gives its own pure mapping
 * functions -- callers inside this file should keep going through
 * syncTenant()/syncShopifyTenant()/syncWalmartTenant(), not call this
 * directly.
 */
export async function recordSyncFailure(
  appPool: Pool,
  tenantId: string,
  channel: "amazon" | "shopify" | "walmart",
  message: string,
): Promise<void> {
  await withTenant(appPool, tenantId, async (client) => {
    const updated = await client.query<{ consecutive_failures: number; status: string }>(
      `UPDATE channel_connections
          SET consecutive_failures = consecutive_failures + 1,
              last_failure_at = now(),
              last_failure_message = $1,
              status = CASE WHEN consecutive_failures + 1 >= $2 THEN 'error' ELSE status END,
              updated_at = now()
        WHERE tenant_id = $3 AND channel = $4 AND status = 'active'
        RETURNING consecutive_failures, status`,
      // Truncated defensively -- last_failure_message is TEXT (unbounded),
      // but an unbounded connector error string (a raw provider response
      // body, say) has no business growing this row without limit.
      [message.slice(0, 2000), CONSECUTIVE_FAILURE_ERROR_THRESHOLD, tenantId, channel],
    );

    const row = updated.rows[0];
    if (row?.status === "error" && row.consecutive_failures === CONSECUTIVE_FAILURE_ERROR_THRESHOLD) {
      console.error(
        `[ALERT] ${channel} channel_connections for tenant ${tenantId} has failed ${row.consecutive_failures} ` +
          `consecutive sync runs and is now status='error' -- it will NOT be retried automatically until ` +
          `reconnected via /settings/channels. Last error: ${message}`,
      );
    }
  });
}

/**
 * Records a successful sync attempt, resetting consecutive_failures back to
 * 0 -- the counterpart to recordSyncFailure(), called from every
 * syncXTenant()'s success path. Deliberately does NOT clear
 * last_failure_at/last_failure_message on success -- see the migration's
 * own comment (0021_channel_connections_failure_tracking.sql): a past
 * incident stays visible even once resolved, rather than being erased the
 * moment things recover.
 *
 * `AND consecutive_failures > 0` is a pure optimization, not a correctness
 * requirement -- without it, every single successful run of a healthy
 * connection (the overwhelmingly common case) would still issue a no-op
 * UPDATE and bump updated_at for no reason.
 *
 * Matches only status = 'active' rows -- a row already flipped to 'error'
 * is not auto-recovered by this. That's dead code for the 'error' case as
 * things stand today (nothing calls pullOrders() for an 'error' row's
 * tenant in the first place -- see recordSyncFailure()'s doc comment on
 * why an 'error' row self-removes from every discovery query), kept only
 * as a safety net should that invariant ever change.
 */
export async function recordSyncSuccess(
  appPool: Pool,
  tenantId: string,
  channel: "amazon" | "shopify" | "walmart",
): Promise<void> {
  await withTenant(appPool, tenantId, (client) =>
    client.query(
      `UPDATE channel_connections
          SET consecutive_failures = 0, updated_at = now()
        WHERE tenant_id = $1 AND channel = $2 AND status = 'active' AND consecutive_failures > 0`,
      [tenantId, channel],
    ),
  );
}

export interface SyncAmazonOrdersParams {
  /** The least-privilege `app_user` pool -- every actual read/write for a
   *  discovered tenant goes through this, RLS-scoped via withTenant(), same
   *  as everywhere else in this codebase. */
  appPool: Pool;
  /**
   * The schema-owning connection (DATABASE_URL), used for exactly one
   * query: enumerating which tenants have an active Amazon connection.
   * This is the one deliberate exception to this codebase's otherwise
   * absolute rule (packages/web/src/lib/db.ts: "never use DATABASE_URL ...
   * since RLS is not enforced for table owners") -- justified here because
   * "list every tenant with an active Amazon connection" is inherently a
   * cross-tenant operation that RLS makes impossible through the normal
   * app_user path by design, and this is a background job doing legitimate
   * system-level orchestration, not a per-request web handler where a
   * bypass could leak one tenant's data into another's response. Nothing
   * beyond that one tenant-id enumeration query uses this pool -- every
   * subsequent operation for a discovered tenant goes through `appPool`
   * via withTenant(), scoped exactly like the rest of the app.
   */
  adminPool: Pool;
  eventBus: EventBus;
}

/**
 * Runs one sync pass: discovers every tenant with an active 'amazon'
 * channel_connection, then syncs each in turn (sequential, not concurrent --
 * v1 simplicity, see this file's header comment). One shared OrderService/
 * RulesEngine pair handles the whole pass rather than being rebuilt per
 * tenant -- both are stateless orchestrators whose actual work is already
 * tenant-scoped internally (OrderService via withTenant(), RulesEngine via
 * its own withTenant()-scoped queries), so sharing them across tenants in
 * one pass is safe and is how a real production job would be structured.
 *
 * RulesEngine is attached to the same `eventBus` OrderService publishes on
 * -- this is the first real (non-test) code path where that wiring exists:
 * a routing rule genuinely gets a chance to run before allocation for a
 * real sandbox order pulled through this job, not just in
 * order-received-integration.test.ts's direct construction.
 */
export async function syncAmazonOrders(params: SyncAmazonOrdersParams): Promise<TenantSyncResult[]> {
  const { appPool, adminPool, eventBus } = params;

  const orderService = new OrderService(appPool, eventBus);
  const rulesEngine = new RulesEngine(appPool);
  rulesEngine.attach(eventBus);

  const tenants = await adminPool.query<{ tenant_id: string }>(
    `SELECT DISTINCT tenant_id FROM channel_connections WHERE channel = 'amazon' AND status = 'active'`,
  );

  const results: TenantSyncResult[] = [];
  for (const { tenant_id: tenantId } of tenants.rows) {
    results.push(await syncTenant(appPool, orderService, tenantId));
  }
  return results;
}

/**
 * Builds a fresh EventBus + OrderService/RulesEngine pair and runs one sync
 * pass -- the convenience entrypoint for a real cron/ECS scheduled task
 * (see scripts/amazon-order-sync-job.ts), which shouldn't need to know
 * EventBus wiring is even a thing. Callers that already have a shared
 * eventBus (tests proving rule evaluation fired) should call
 * {@link syncAmazonOrders} directly instead.
 */
export async function runAmazonOrderSyncJob(appPool: Pool, adminPool: Pool): Promise<TenantSyncResult[]> {
  return syncAmazonOrders({ appPool, adminPool, eventBus: new InProcessEventBus() });
}

/**
 * Syncs one tenant. Never throws -- a single tenant's failure (bad
 * credentials, expired token, connector error, anything) is caught and
 * returned as a failed result instead of propagating, so it can't stop the
 * loop in {@link syncAmazonOrders} from reaching the rest of the tenants.
 * Same "one bad actor shouldn't stall everyone" principle as
 * EventBus.publish()'s per-handler catch and RulesEngine's per-rule catch.
 */
async function syncTenant(appPool: Pool, orderService: OrderService, tenantId: string): Promise<TenantSyncResult> {
  const syncStartedAt = new Date();

  try {
    const lastSync = await withTenant(appPool, tenantId, (client) =>
      client.query<{ last_order_sync_at: string | null }>(
        `SELECT last_order_sync_at FROM channel_connections
          WHERE tenant_id = $1 AND channel = 'amazon' AND status = 'active'
          ORDER BY created_at DESC LIMIT 1`,
        [tenantId],
      ),
    );
    const lastOrderSyncAt = lastSync.rows[0]?.last_order_sync_at;
    const since = lastOrderSyncAt ? new Date(lastOrderSyncAt) : new Date(syncStartedAt.getTime() - DEFAULT_LOOKBACK_MS);

    const connector = await createAmazonConnectorFromChannelConnection(appPool, tenantId);
    // The sandbox rejects a real computed date outright (CLAUDE.md §4.1);
    // it only returns canned data for its one documented literal trigger.
    // Production Amazon (once live) gets the real, computed `since`.
    const pullSince = connector.isSandbox() ? SP_API_SANDBOX_TEST_CASE_CREATED_AFTER : since;

    const pulled = await connector.pullOrders(pullSince);
    const persisted = await orderService.persistPulledOrders(tenantId, pulled);

    // Recorded as the sync's *start* time, not now -- see migration 0015's
    // comment: an order placed while this sync was in flight must not fall
    // into the gap between "when this started reading" and "when it
    // finished writing."
    await withTenant(appPool, tenantId, (client) =>
      client.query(
        `UPDATE channel_connections SET last_order_sync_at = $1, updated_at = now()
          WHERE tenant_id = $2 AND channel = 'amazon' AND status = 'active'`,
        [syncStartedAt.toISOString(), tenantId],
      ),
    );
    await recordSyncSuccess(appPool, tenantId, "amazon");

    return { tenantId, success: true, ...persisted, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Amazon order sync failed for tenant ${tenantId}, continuing with remaining tenants:`, message);
    // Cross-run failure tracking/alerting -- see recordSyncFailure()'s doc
    // comment. This used to be a KNOWN GAP (a dead connection failing
    // silently forever, no signal anywhere beyond this one log line); it
    // no longer is.
    await recordSyncFailure(appPool, tenantId, "amazon", message);
    return { tenantId, success: false, insertedOrderIds: [], skippedExternalOrderIds: [], error: message };
  }
}

/**
 * Shopify's channel #3 counterpart to {@link syncAmazonOrders} -- same
 * shape (discover every tenant with an active connection of this channel,
 * sync each sequentially, never let one tenant's failure stop the rest),
 * kept as a parallel function rather than a generic
 * "syncChannelOrders(channel)" abstraction: AmazonConnector's `isSandbox()`
 * lookback special-case (see syncTenant below) has no Shopify equivalent
 * (a Shopify dev store is a real store, not a separate sandbox environment
 * -- see ShopifyCredentials's own doc comment), and forcing that through a
 * shared function would need a channel-specific branch inside it anyway.
 * Revisit this duplication if/when a fourth channel makes the shared shape
 * actually pay for itself.
 */
export async function syncShopifyOrders(params: SyncAmazonOrdersParams): Promise<TenantSyncResult[]> {
  const { appPool, adminPool, eventBus } = params;

  const orderService = new OrderService(appPool, eventBus);
  const rulesEngine = new RulesEngine(appPool);
  rulesEngine.attach(eventBus);

  const tenants = await adminPool.query<{ tenant_id: string }>(
    `SELECT DISTINCT tenant_id FROM channel_connections WHERE channel = 'shopify' AND status = 'active'`,
  );

  const results: TenantSyncResult[] = [];
  for (const { tenant_id: tenantId } of tenants.rows) {
    results.push(await syncShopifyTenant(appPool, orderService, tenantId));
  }
  return results;
}

/** Shopify counterpart to {@link runAmazonOrderSyncJob} -- see its doc comment. */
export async function runShopifyOrderSyncJob(appPool: Pool, adminPool: Pool): Promise<TenantSyncResult[]> {
  return syncShopifyOrders({ appPool, adminPool, eventBus: new InProcessEventBus() });
}

/** Shopify counterpart to {@link syncTenant} -- identical error-isolation
 *  contract (never throws; a bad token/connector error becomes a failed
 *  result, not a stopped loop). No isSandbox()/canned-lookback branch here
 *  -- ShopifyConnector has no sandbox concept to special-case (see
 *  syncShopifyOrders's doc comment) -- `since` is always the real computed
 *  value. */
async function syncShopifyTenant(appPool: Pool, orderService: OrderService, tenantId: string): Promise<TenantSyncResult> {
  const syncStartedAt = new Date();

  try {
    const lastSync = await withTenant(appPool, tenantId, (client) =>
      client.query<{ last_order_sync_at: string | null }>(
        `SELECT last_order_sync_at FROM channel_connections
          WHERE tenant_id = $1 AND channel = 'shopify' AND status = 'active'
          ORDER BY created_at DESC LIMIT 1`,
        [tenantId],
      ),
    );
    const lastOrderSyncAt = lastSync.rows[0]?.last_order_sync_at;
    const since = lastOrderSyncAt ? new Date(lastOrderSyncAt) : new Date(syncStartedAt.getTime() - DEFAULT_LOOKBACK_MS);

    const connector = await createShopifyConnectorFromChannelConnection(appPool, tenantId);
    const pulled = await connector.pullOrders(since);
    const persisted = await orderService.persistPulledOrders(tenantId, pulled);

    // Same start-time-not-now reasoning as syncTenant() -- migration 0015's
    // comment applies identically here.
    await withTenant(appPool, tenantId, (client) =>
      client.query(
        `UPDATE channel_connections SET last_order_sync_at = $1, updated_at = now()
          WHERE tenant_id = $2 AND channel = 'shopify' AND status = 'active'`,
        [syncStartedAt.toISOString(), tenantId],
      ),
    );
    await recordSyncSuccess(appPool, tenantId, "shopify");

    return { tenantId, success: true, ...persisted, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Shopify order sync failed for tenant ${tenantId}, continuing with remaining tenants:`, message);
    // Same cross-run failure tracking as syncTenant() -- see
    // recordSyncFailure()'s doc comment.
    await recordSyncFailure(appPool, tenantId, "shopify", message);
    return { tenantId, success: false, insertedOrderIds: [], skippedExternalOrderIds: [], error: message };
  }
}

/**
 * Walmart's channel counterpart to {@link syncShopifyOrders} -- identical
 * shape again (discover every tenant with an active 'walmart'
 * channel_connection, sync each sequentially via adminPool/appPool, never
 * let one tenant's failure stop the rest). Kept as its own parallel function
 * for the same duplication-vs-abstraction call syncShopifyOrders's doc
 * comment already made for channel #2 -- now with a third channel wired
 * this way and still no shared shape worth extracting (Amazon's
 * isSandbox()-canned-lookback branch has no Walmart equivalent either; see
 * syncWalmartTenant below).
 *
 * UNVERIFIED IN PRACTICE along with the rest of the Walmart wiring (see
 * WalmartConnector's own class doc comment and the connect route's) --
 * this function's *logic* mirrors syncShopifyOrders exactly and is
 * typechecked/covered by the same "never throws per-tenant" contract, but
 * it has never actually pulled a real order from Walmart's live API, since
 * createWalmartConnectorFromChannelConnection() has nothing to authenticate
 * against without a real tenant-entered clientId/clientSecret pair.
 */
export async function syncWalmartOrders(params: SyncAmazonOrdersParams): Promise<TenantSyncResult[]> {
  const { appPool, adminPool, eventBus } = params;

  const orderService = new OrderService(appPool, eventBus);
  const rulesEngine = new RulesEngine(appPool);
  rulesEngine.attach(eventBus);

  const tenants = await adminPool.query<{ tenant_id: string }>(
    `SELECT DISTINCT tenant_id FROM channel_connections WHERE channel = 'walmart' AND status = 'active'`,
  );

  const results: TenantSyncResult[] = [];
  for (const { tenant_id: tenantId } of tenants.rows) {
    results.push(await syncWalmartTenant(appPool, orderService, tenantId));
  }
  return results;
}

/** Walmart counterpart to {@link runShopifyOrderSyncJob} -- see its doc comment. */
export async function runWalmartOrderSyncJob(appPool: Pool, adminPool: Pool): Promise<TenantSyncResult[]> {
  return syncWalmartOrders({ appPool, adminPool, eventBus: new InProcessEventBus() });
}

/** Walmart counterpart to {@link syncShopifyTenant} -- identical
 *  error-isolation contract (never throws; a bad clientId/clientSecret pair
 *  or connector error becomes a failed result, not a stopped loop). No
 *  isSandbox()/canned-lookback branch here either -- like Shopify,
 *  WalmartConnector always talks to the real computed `since` (see
 *  createWalmartConnectorFromChannelConnection's own comment: it's always
 *  constructed against WALMART_PRODUCTION_BASE_URL, a real tenant connecting
 *  their real seller account, never this repo's internal sandbox). */
async function syncWalmartTenant(appPool: Pool, orderService: OrderService, tenantId: string): Promise<TenantSyncResult> {
  const syncStartedAt = new Date();

  try {
    const lastSync = await withTenant(appPool, tenantId, (client) =>
      client.query<{ last_order_sync_at: string | null }>(
        `SELECT last_order_sync_at FROM channel_connections
          WHERE tenant_id = $1 AND channel = 'walmart' AND status = 'active'
          ORDER BY created_at DESC LIMIT 1`,
        [tenantId],
      ),
    );
    const lastOrderSyncAt = lastSync.rows[0]?.last_order_sync_at;
    const since = lastOrderSyncAt ? new Date(lastOrderSyncAt) : new Date(syncStartedAt.getTime() - DEFAULT_LOOKBACK_MS);

    const connector = await createWalmartConnectorFromChannelConnection(appPool, tenantId);
    const pulled = await connector.pullOrders(since);
    const persisted = await orderService.persistPulledOrders(tenantId, pulled);

    // Same start-time-not-now reasoning as syncShopifyTenant()/syncTenant()
    // -- migration 0015's comment applies identically here.
    await withTenant(appPool, tenantId, (client) =>
      client.query(
        `UPDATE channel_connections SET last_order_sync_at = $1, updated_at = now()
          WHERE tenant_id = $2 AND channel = 'walmart' AND status = 'active'`,
        [syncStartedAt.toISOString(), tenantId],
      ),
    );
    await recordSyncSuccess(appPool, tenantId, "walmart");

    return { tenantId, success: true, ...persisted, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Walmart order sync failed for tenant ${tenantId}, continuing with remaining tenants:`, message);
    // Same cross-run failure tracking as syncTenant()/syncShopifyTenant()
    // -- see recordSyncFailure()'s doc comment. Doubly expected to fire
    // (and to flip status to 'error' within CONSECUTIVE_FAILURE_ERROR_THRESHOLD
    // runs) for every Walmart-connected tenant right now, given the
    // UNVERIFIED status above -- that's the correct, intended behavior,
    // not a bug: an unverified connection that's actually broken SHOULD
    // end up visibly in 'error' rather than failing invisibly forever.
    await recordSyncFailure(appPool, tenantId, "walmart", message);
    return { tenantId, success: false, insertedOrderIds: [], skippedExternalOrderIds: [], error: message };
  }
}

/** Every product/channel_listings row this catalog-sync job maintains uses
 *  this same location for its baseline stock -- see syncShopifyCatalogForTenant's
 *  doc comment. Deliberately the exact string
 *  scripts/add-channel-listing.ts's own LOCATION_NAME default already uses,
 *  so a SKU onboarded manually and a SKU picked up later by this automatic
 *  sync land in the same `locations` row instead of silently fragmenting a
 *  tenant's stock across two differently-named locations for the same
 *  physical warehouse. */
const CATALOG_SYNC_LOCATION_NAME = "Primary Warehouse";

export interface CatalogSyncResult {
  tenantId: string;
  success: boolean;
  variantsUpserted: number;
  error: string | null;
}

export interface SyncShopifyCatalogParams {
  /** Same two-pool pattern as SyncAmazonOrdersParams -- see its doc comment. */
  appPool: Pool;
  adminPool: Pool;
}

/**
 * Closes the gap scripts/add-channel-listing.ts is a manual, one-SKU-at-a-time
 * stopgap for: pulls every tenant's connected Shopify store's full product
 * catalog (ShopifyConnector.pullProductCatalog) and upserts a
 * products/channel_listings row per SKU'd variant, exactly the shape that
 * script already creates by hand. Same discovery/per-tenant-isolation shape
 * as syncShopifyOrders (enumerate active 'shopify' channel_connections via
 * adminPool, sync each tenant via appPool, one tenant's failure never stops
 * the rest) -- kept as its own function rather than folded into
 * syncShopifyOrders since catalog sync and order sync are genuinely
 * different operations with different failure/idempotency shapes, not just
 * a parameter away from each other.
 */
export async function syncShopifyCatalog(params: SyncShopifyCatalogParams): Promise<CatalogSyncResult[]> {
  const { appPool, adminPool } = params;
  const inventoryService = new InventoryService(appPool);

  const tenants = await adminPool.query<{ tenant_id: string }>(
    `SELECT DISTINCT tenant_id FROM channel_connections WHERE channel = 'shopify' AND status = 'active'`,
  );

  const results: CatalogSyncResult[] = [];
  for (const { tenant_id: tenantId } of tenants.rows) {
    results.push(await syncShopifyCatalogForTenant(appPool, inventoryService, tenantId));
  }
  return results;
}

/** Convenience entrypoint mirroring {@link runAmazonOrderSyncJob} -- see its doc comment. */
export async function runShopifyCatalogSyncJob(appPool: Pool, adminPool: Pool): Promise<CatalogSyncResult[]> {
  return syncShopifyCatalog({ appPool, adminPool });
}

/**
 * Syncs one tenant's catalog. Never throws -- same per-tenant error
 * isolation as syncShopifyTenant/syncTenant.
 *
 * For each SKU'd variant: upsert `products` (keyed on its own
 * (tenant_id, internal_sku) UNIQUE constraint, internal_sku defaulting to
 * "shopify-<sku>" -- the exact convention scripts/add-channel-listing.ts
 * also defaults to, so a SKU already onboarded manually is found and
 * updated here, never duplicated) and `channel_listings` (keyed on its own
 * (tenant_id, channel, channel_marketplace, external_id) UNIQUE constraint,
 * external_id = the variant's InventoryItem gid -- distinct per variant, so
 * two different SKUs never collide the way two empty external_ids would).
 *
 * Baseline stock is seeded via InventoryService.recordInventoryEvent with
 * idempotency_key = "catalog-onboarding:<tenantId>:shopify:<sku>" --
 * DELIBERATELY the same key prefix scripts/add-channel-listing.ts's own
 * manual seeding uses, not a separate "catalog-sync:" prefix: idempotency_key
 * is UNIQUE across the whole inventory_events table regardless of which
 * script or job wrote it, so a SKU a human already onboarded by hand stays
 * at whatever quantity they entered -- this job's own attempt to seed a
 * baseline for that same SKU correctly becomes a no-op instead of adding a
 * second, conflicting "initial" receipt on top of real, already-allocated
 * stock. Every subsequent run of this job (for a SKU it or the manual
 * script already baselined) only re-upserts the product/listing rows --
 * cheap and idempotent on their own UNIQUE constraints -- without touching
 * inventory again: this tenant's own ledger (orders, allocations, manual
 * pushInventory) is the ongoing source of truth after the first baseline,
 * not Shopify's currently-reported quantity.
 */
async function syncShopifyCatalogForTenant(
  appPool: Pool,
  inventoryService: InventoryService,
  tenantId: string,
): Promise<CatalogSyncResult> {
  let variants: NormalizedShopifyProductVariant[];
  try {
    const connector = await createShopifyConnectorFromChannelConnection(appPool, tenantId);
    variants = await connector.pullProductCatalog();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Shopify catalog sync failed for tenant ${tenantId}, continuing with remaining tenants:`, message);
    // Deliberately NOT wired into recordSyncFailure()/the shared
    // consecutive_failures counter that syncTenant()/syncShopifyTenant()/
    // syncWalmartTenant() now use (see recordSyncFailure()'s doc comment)
    // -- catalog sync and order sync are genuinely different operations
    // sharing the same channel_connections row (this function's own doc
    // comment above already makes that "different failure/idempotency
    // shapes" point), and pullProductCatalog() failing for reasons that
    // have nothing to do with pullOrders() (e.g. a GraphQL-only schema
    // quirk) should never flip a tenant's connection to 'error' and cut
    // off order sync, which may be working perfectly. This still logs
    // every failure, same as before -- it's cross-run tracking/alerting
    // specifically that's still an open gap here, deliberately, not
    // fixed by this change.
    return { tenantId, success: false, variantsUpserted: 0, error: message };
  }

  let variantsUpserted = 0;
  for (const variant of variants) {
    try {
      const internalSku = `shopify-${variant.externalSku}`;

      const { productId, locationId } = await withTenant(appPool, tenantId, async (client) => {
        const product = await client.query<{ id: string }>(
          `INSERT INTO products (tenant_id, internal_sku, name)
           VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, internal_sku) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [tenantId, internalSku, variant.title],
        );
        const productId = product.rows[0]!.id;

        await client.query(
          `INSERT INTO channel_listings
             (tenant_id, product_id, channel, channel_marketplace, external_id, external_sku, listing_status)
           VALUES ($1, $2, 'shopify', '', $3, $4, 'active')
           ON CONFLICT (tenant_id, channel, channel_marketplace, external_id) DO UPDATE SET
             product_id = EXCLUDED.product_id,
             external_sku = EXCLUDED.external_sku,
             listing_status = 'active',
             updated_at = now()`,
          [tenantId, productId, variant.inventoryItemId, variant.externalSku],
        );

        const existingLocation = await client.query<{ id: string }>(
          `SELECT id FROM locations WHERE tenant_id = $1 AND name = $2 LIMIT 1`,
          [tenantId, CATALOG_SYNC_LOCATION_NAME],
        );
        const locationId = existingLocation.rows[0]
          ? existingLocation.rows[0].id
          : (
              await client.query<{ id: string }>(
                `INSERT INTO locations (tenant_id, name, type) VALUES ($1, $2, 'warehouse') RETURNING id`,
                [tenantId, CATALOG_SYNC_LOCATION_NAME],
              )
            ).rows[0]!.id;

        return { productId, locationId };
      });

      await inventoryService.recordInventoryEvent({
        tenantId,
        productId,
        locationId,
        eventType: "receipt",
        quantityDelta: variant.totalAvailable,
        referenceType: "manual",
        idempotencyKey: `catalog-onboarding:${tenantId}:shopify:${variant.externalSku}`,
      });

      variantsUpserted++;
    } catch (err) {
      // One bad variant (e.g. a genuinely malformed row) shouldn't abort
      // the rest of this tenant's catalog -- same per-item isolation
      // philosophy as syncTenant's own per-tenant isolation, one level
      // deeper.
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `Shopify catalog sync: failed to upsert sku='${variant.externalSku}' for tenant ${tenantId}, continuing with remaining variants:`,
        message,
      );
    }
  }

  return {
    tenantId,
    success: true,
    variantsUpserted,
    error: null,
  };
}

// The recurring trigger this file's own header comment above flagged as
// separate, later infrastructure work -- see cron-runner.ts for why
// node-cron (not BullMQ) and what "later" means concretely.
export {
  startAmazonOrderSyncScheduler,
  runOnceWithRetry,
  startShopifyOrderSyncScheduler,
  runShopifyOnceWithRetry,
  startWalmartOrderSyncScheduler,
  runWalmartOnceWithRetry,
  type AmazonOrderSyncSchedulerOptions,
  type ShopifyOrderSyncSchedulerOptions,
  type WalmartOrderSyncSchedulerOptions,
} from "./cron-runner.js";
