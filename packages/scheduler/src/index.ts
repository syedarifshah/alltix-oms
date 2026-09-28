import type { Pool, PoolClient } from "pg";
import { withTenant } from "@alltix/db";
import { InProcessEventBus, type EventBus, captureAlert, sendEmail } from "@alltix/shared";
import {
  createAmazonConnectorFromChannelConnection,
  SP_API_SANDBOX_TEST_CASE_CREATED_AFTER,
  createShopifyConnectorFromChannelConnection,
  createWalmartConnectorFromChannelConnection,
  createEbayConnectorFromChannelConnection,
  createTemuConnectorFromChannelConnection,
  createTikTokConnectorFromChannelConnection,
  RateLimitExhaustedError,
  type NormalizedShopifyProductVariant,
} from "@alltix/channel-connectors";
import { InventoryService } from "@alltix/inventory-service";
import { OrderService, PartialOrderPersistFailureError } from "@alltix/order-service";
import { RulesEngine } from "@alltix/rules-engine";
import { UsageReporter } from "@alltix/billing-service";

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
  /** Which specific channel_connections row this result is for -- only ever
   *  populated by TikTok's own per-connection sync loop (syncTikTokConnection),
   *  since it's the one channel where a tenant can have more than one
   *  active connection and a single sync pass can return more than one
   *  result for the same tenantId (CLAUDE.md §12's "no true multi-shop
   *  CONNECT" gap). Every other channel leaves this undefined -- one result
   *  per tenant, as before. */
  connectionId?: string;
}

/** Consecutive failed sync runs past which a channel_connections row's
 *  status flips from 'active' to 'error' -- see recordSyncFailure()'s doc
 *  comment for the full reasoning. Three, not one: a single transient
 *  network blip or a marketplace's momentary 503 shouldn't flip a healthy
 *  tenant to 'error' on the very next cron tick; three in a row is a much
 *  stronger signal of a genuinely dead credential/token than one. */
export const CONSECUTIVE_FAILURE_ERROR_THRESHOLD = 3;

/** CLAUDE.md §4.4's cross-run circuit-breaker cooldown -- how long a
 *  connection sits out of every discovery query's `WHERE` clause once
 *  fetchWithBackoff (packages/channel-connectors/src/retry.ts) has already
 *  exhausted its own in-process retries and thrown RateLimitExhaustedError.
 *  A fixed window, deliberately NOT exponential the way the in-process
 *  backoff is: the in-process half already spends a few seconds proving a
 *  429/503 is sustained, not a blip, before this even fires, and the
 *  cadence this cooldown sits inside of is a once-or-twice-daily cron tick
 *  (CLAUDE.md §4.4's job queue is per-run, not per-second) -- there's no
 *  meaningful difference between "back off 15 minutes" and "back off 15
 *  minutes, then 30, then 60" when the next opportunity to even check is
 *  tomorrow's run regardless. Fifteen minutes is long enough that a single
 *  rate-limited run doesn't immediately retry into the same throttle on
 *  the very next tick of a more frequent schedule, without leaving a
 *  connection dark for the rest of a day over one bad run. */
export const RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;

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
 * Alerting is log-based AND a Sentry event (captureAlert(), CLAUDE.md §5/§8
 * Phase 4's "Observability dashboards" -- @alltix/shared's observability.ts
 * has the full reasoning for why this call site specifically, and not a
 * blanket console.error hook, is the one wrapped). No email/Slack/other
 * notification infra exists anywhere in this codebase beyond that. The
 * distinctly "[ALERT]"-tagged console.error below fires exactly once per
 * incident -- on the run that *crosses* the threshold, not on every failed
 * run after (the row leaves the 'active' pool at that point, so there is no
 * "after" to log) -- so the Sentry event fires once too, not once per cron
 * tick for as long as the tenant stays broken. The caller's own per-run
 * console.error is unchanged and still fires every time, but does NOT reach
 * Sentry -- only this threshold-crossing line does.
 *
 * Exported (along with {@link recordSyncSuccess} and
 * {@link CONSECUTIVE_FAILURE_ERROR_THRESHOLD}) purely so
 * test/sync-failure-tracking.test.ts can exercise this DB logic directly
 * against a real local Postgres, the same "exported for testability"
 * treatment walmart-connector.ts already gives its own pure mapping
 * functions -- callers inside this file should keep going through
 * syncTenant()/syncShopifyConnection()/syncWalmartTenant(), not call this
 * directly.
 */

/**
 * Closes the "no email/Slack/other notification infra exists anywhere in
 * this codebase" gap CLAUDE.md §4.4/§13 both flagged -- emails every user
 * of the AFFECTED TENANT (not a platform operator; see cron-runner.ts's
 * own whole-job alerting for that) when their own channel connection needs
 * their attention. Deliberately no new recipient-list schema: `users` is
 * already tenant-scoped and RLS-isolated, so "everyone who can see this
 * tenant's /settings/channels page" is exactly the right audience with no
 * new column, table, or per-tenant notification-preference UI needed for
 * v1 -- the same "start simple, earn the complexity later" call this
 * codebase makes everywhere else (CLAUDE.md §1, §4.4, §8).
 *
 * A tenant with zero users (shouldn't happen in practice -- a tenant only
 * exists because a Clerk user created it, see 0010_tenants_and_users.sql)
 * is a silent no-op via sendEmail()'s own empty-recipients guard, not an
 * error -- there being no one to notify is not itself alert-worthy, and
 * this function's callers already fire captureAlert()/console.error
 * regardless of whether an email goes out.
 */
async function notifyTenantUsers(appPool: Pool, tenantId: string, subject: string, message: string): Promise<void> {
  const recipients = await withTenant(appPool, tenantId, (client) =>
    client.query<{ email: string }>(`SELECT DISTINCT email FROM users WHERE tenant_id = $1`, [tenantId]),
  );
  await sendEmail({
    to: recipients.rows.map((r) => r.email),
    subject,
    text: message,
  });
}

/**
 * `connectionId` (optional, defaults to null): scopes this UPDATE to one
 * specific `channel_connections` row instead of every active row of this
 * `channel` for this tenant -- closes CLAUDE.md §12's "no true multi-shop
 * CONNECT" gap for TikTok Shop, the one channel where a tenant can have
 * more than one active connection at once. Every other channel's own call
 * site omits it, keeping the exact original "every active row of this
 * channel" behavior (harmless there, since none of them can have more than
 * one such row today) -- only TikTok's per-connection sync loop passes a
 * real value, so one shop tripping the failure threshold doesn't also flip
 * an unrelated, perfectly healthy shop to `status = 'error'`.
 */
export async function recordSyncFailure(
  appPool: Pool,
  tenantId: string,
  channel: "amazon" | "shopify" | "walmart" | "ebay" | "temu" | "tiktok",
  message: string,
  connectionId?: string | null,
): Promise<void> {
  const updated = await withTenant(appPool, tenantId, (client) =>
    client.query<{ consecutive_failures: number; status: string }>(
      `UPDATE channel_connections
          SET consecutive_failures = consecutive_failures + 1,
              last_failure_at = now(),
              last_failure_message = $1,
              status = CASE WHEN consecutive_failures + 1 >= $2 THEN 'error' ELSE status END,
              updated_at = now()
        WHERE tenant_id = $3 AND channel = $4 AND status = 'active'
          AND ($5::uuid IS NULL OR id = $5)
        RETURNING consecutive_failures, status`,
      // Truncated defensively -- last_failure_message is TEXT (unbounded),
      // but an unbounded connector error string (a raw provider response
      // body, say) has no business growing this row without limit.
      [message.slice(0, 2000), CONSECUTIVE_FAILURE_ERROR_THRESHOLD, tenantId, channel, connectionId ?? null],
    ),
  );

  const row = updated.rows[0];
  if (row?.status === "error" && row.consecutive_failures === CONSECUTIVE_FAILURE_ERROR_THRESHOLD) {
    const alertMessage =
      `[ALERT] ${channel} channel_connections for tenant ${tenantId} has failed ${row.consecutive_failures} ` +
      `consecutive sync runs and is now status='error' -- it will NOT be retried automatically until ` +
      `reconnected via /settings/channels. Last error: ${message}`;
    console.error(alertMessage);
    captureAlert(alertMessage, { tenantId, channel, consecutiveFailures: row.consecutive_failures });
    // Outside the UPDATE's own withTenant() block, deliberately -- this is
    // an unrelated read (users, not channel_connections) that has no
    // reason to share the UPDATE's transaction, and running it only after
    // that transaction has committed means a tenant's notified users can
    // always find the 'error' status this email describes if they click
    // through to /settings/channels right away.
    await notifyTenantUsers(
      appPool,
      tenantId,
      `Action needed: your ${channel} connection has stopped syncing`,
      `${alertMessage}\n\nReconnect from /settings/channels to resume order sync for this channel.`,
    );
  }
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
 * `AND (consecutive_failures > 0 OR rate_limited_until IS NOT NULL)` is a
 * pure optimization, not a correctness requirement -- without it, every
 * single successful run of a healthy connection (the overwhelmingly common
 * case) would still issue a no-op UPDATE and bump updated_at for no reason.
 *
 * Also clears `rate_limited_until` -- a successful call this run is direct
 * proof the earlier trip has resolved, so there's no reason to make the
 * connection sit out the rest of its cooldown once it's demonstrably
 * healthy again. (In practice a still-cooling-down connection never
 * reaches this line at all: it was excluded from the discovery query's
 * `rate_limited_until` filter in the first place -- this clears a cooldown
 * that already expired naturally, or one from a run prior to this cooldown
 * concept existing at all.)
 *
 * Matches only status = 'active' rows -- a row already flipped to 'error'
 * is not auto-recovered by this. That's dead code for the 'error' case as
 * things stand today (nothing calls pullOrders() for an 'error' row's
 * tenant in the first place -- see recordSyncFailure()'s doc comment on
 * why an 'error' row self-removes from every discovery query), kept only
 * as a safety net should that invariant ever change.
 *
 * `connectionId` (optional, defaults to null): same per-connection scoping
 * as recordSyncFailure()'s own new parameter, for the same reason -- a
 * successful sync of one TikTok shop must not also clear another shop's
 * own, unrelated, still-genuinely-failing consecutive_failures count.
 */
export async function recordSyncSuccess(
  appPool: Pool,
  tenantId: string,
  channel: "amazon" | "shopify" | "walmart" | "ebay" | "temu" | "tiktok",
  connectionId?: string | null,
): Promise<void> {
  await withTenant(appPool, tenantId, (client) =>
    client.query(
      `UPDATE channel_connections
          SET consecutive_failures = 0, rate_limited_until = NULL, updated_at = now()
        WHERE tenant_id = $1 AND channel = $2 AND status = 'active'
          AND ($3::uuid IS NULL OR id = $3)
          AND (consecutive_failures > 0 OR rate_limited_until IS NOT NULL)`,
      [tenantId, channel, connectionId ?? null],
    ),
  );
}

/**
 * Shared by every syncXTenant()/syncXConnection() catch block below, once
 * `persistPulledOrders()` throws a {@link PartialOrderPersistFailureError}
 * instead of a generic `Error` -- see that class's own doc comment in
 * `@alltix/order-service` for the full "why this isn't a connection
 * failure" reasoning (CLAUDE.md §4.5's "Update" on the real Shopify
 * demo-order incident this closes out). Centralized here rather than
 * repeated at all six call sites, the same way recordSyncFailure()/
 * recordSyncSuccess() themselves are shared instead of six separate
 * per-channel UPDATE statements.
 *
 * Calls recordSyncSuccess() -- not recordSyncFailure() -- because every
 * order this batch pulled OTHER than the ones `err.failedOrders` names
 * already committed successfully, which is direct proof the connection and
 * its credentials are healthy right now. Returns a `success: true` result
 * carrying the real partial counts from the error (not the empty arrays a
 * genuine failure returns), so a caller's own logs/summary still reflect
 * what actually got persisted -- `error` stays non-null even though
 * `success` is `true`, since nothing downstream (every cron route's own
 * `results.filter((r) => r.success)`) reads `.error` at all when `.success`
 * is `true`; it's kept only for visibility if that ever changes.
 *
 * Deliberately does NOT touch `last_order_sync_at` -- the caller's own
 * `UPDATE ... SET last_order_sync_at` is simply never reached on this path
 * (same as any other throw), so a permanently-bad order keeps getting
 * re-pulled and re-failing every run until it's fixed at the source. That's
 * pre-existing, accepted behavior (persistPulledOrders()'s own "Known
 * residual behavior" comment) this function doesn't change -- only the
 * circuit-breaker misclassification is what's fixed here.
 *
 * Exported (along with the six catch-block call sites that use it
 * implicitly) purely so `packages/scheduler/test/partial-order-persist-
 * failure.test.ts` can drive it directly against a real
 * `channel_connections` row, the same way `recordSyncFailure`/
 * `recordSyncSuccess` are already exported for `sync-failure-tracking.test.ts`
 * to call directly rather than only ever indirectly through a full sync run.
 */
export async function recordPartialOrderPersistFailure(
  appPool: Pool,
  tenantId: string,
  channel: "amazon" | "shopify" | "walmart" | "ebay" | "temu" | "tiktok",
  err: PartialOrderPersistFailureError,
  connectionId?: string,
): Promise<TenantSyncResult> {
  console.warn(
    `${channel} order sync for tenant ${tenantId}${connectionId ? `, connection ${connectionId}` : ""}: ` +
      `${err.failedOrders.length} order(s) failed to persist on a data-quality problem, not a connection ` +
      `problem -- every other order in this batch persisted fine, so this run counts as a success, not a ` +
      `failure. Still-unresolved order(s): ${err.failedOrders.map((f) => `${f.externalOrderId} (${f.error})`).join("; ")}`,
  );
  await recordSyncSuccess(appPool, tenantId, channel, connectionId);
  return {
    tenantId,
    connectionId,
    success: true,
    insertedOrderIds: err.insertedOrderIds,
    skippedExternalOrderIds: err.skippedExternalOrderIds,
    error: err.message,
  };
}

/**
 * The cross-run half of CLAUDE.md §4.4's circuit breaker: called from a
 * syncXTenant()/syncShopifyCatalogForConnection() catch block specifically when
 * `err instanceof RateLimitExhaustedError` (i.e. fetchWithBackoff itself
 * already retried in-process and gave up -- this is not called for every
 * failure, only a confirmed-sustained one), it stamps
 * `rate_limited_until` far enough in the future that the next discovery
 * query skips this connection entirely rather than immediately re-hitting
 * a marketplace that just finished telling us to slow down.
 *
 * The cooldown is `max(RATE_LIMIT_COOLDOWN_MS, retryAfterMs ?? 0)` -- our
 * own default floor, unless the marketplace's own Retry-After (surfaced on
 * RateLimitExhaustedError.retryAfterMs, already the larger of the two by
 * the time fetchWithBackoff throws -- see its own doc comment) asked for
 * longer, in which case honoring what we were actually told beats our
 * generic default.
 *
 * Deliberately independent of consecutive_failures/status='error' --
 * RateLimitExhaustedError is a distinct failure mode from "this credential
 * is dead" (recordSyncFailure()'s doc comment), so a rate-limit trip does
 * NOT increment consecutive_failures or risk flipping status to 'error':
 * being throttled is not evidence the connection itself is broken, and a
 * healthy connection shouldn't lose its 'active' status over a marketplace
 * doing exactly what rate limits are supposed to do. The catch block below
 * still calls recordSyncFailure() too (this run IS a failed sync, and the
 * per-run console.error/skip-remaining-tenants behavior is unchanged) --
 * this function only adds the cooldown on top, it doesn't replace that call.
 *
 * Deliberately does NOT call notifyTenantUsers() the way recordSyncFailure()'s
 * threshold-crossing branch does, even though both are "[ALERT]"-tagged for
 * Sentry/log purposes. A rate-limit trip is self-healing (the cooldown
 * above expires on its own, and recordSyncSuccess() clears it early on the
 * next demonstrated success) and there is nothing actionable for a tenant
 * to *do* about it -- emailing them "you're being rate-limited" on what
 * could be a routine, recurring, healthy-account event would just be
 * inbox noise, exactly the kind of alert fatigue observability.ts's own
 * header comment already rejected a blanket console.error->Sentry hook
 * over. Sentry (for Arif, watching for a pattern across tenants) is the
 * right audience for this one, not the tenant themselves.
 *
 * `connectionId` (optional, defaults to null): same per-connection scoping
 * as recordSyncFailure()'s/recordSyncSuccess()'s own new parameter -- one
 * TikTok shop getting rate-limited must not also cool down an unrelated
 * shop that was never anywhere near a rate limit.
 */
export async function recordRateLimitTrip(
  appPool: Pool,
  tenantId: string,
  channel: "amazon" | "shopify" | "walmart" | "ebay" | "temu" | "tiktok",
  retryAfterMs: number | null,
  connectionId?: string | null,
): Promise<void> {
  const cooldownMs = Math.max(RATE_LIMIT_COOLDOWN_MS, retryAfterMs ?? 0);
  const rateLimitedUntil = new Date(Date.now() + cooldownMs);

  await withTenant(appPool, tenantId, (client) =>
    client.query(
      `UPDATE channel_connections
          SET rate_limited_until = $1, updated_at = now()
        WHERE tenant_id = $2 AND channel = $3 AND status = 'active'
          AND ($4::uuid IS NULL OR id = $4)`,
      [rateLimitedUntil, tenantId, channel, connectionId ?? null],
    ),
  );

  const alertMessage =
    `[ALERT] ${channel} channel_connections for tenant ${tenantId} is being rate-limited -- ` +
    `backing off until ${rateLimitedUntil.toISOString()} (${Math.round(cooldownMs / 1000)}s) before retrying.`;
  console.error(alertMessage);
  captureAlert(alertMessage, { tenantId, channel, rateLimitedUntil: rateLimitedUntil.toISOString() });
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
 * order-received-integration.test.ts's direct construction. UsageReporter
 * (@alltix/billing-service) is attached the same way, alongside RulesEngine
 * -- every real order.received event now has two independent subscribers,
 * neither aware of the other, exactly the decoupling CLAUDE.md §1's Event
 * Bus section describes.
 *
 * The discovery query below joins `tenants` and requires `'amazon' = ANY
 * (t.enabled_channels)` -- closing the gap CLAUDE.md §12 flagged: §15's
 * channel feature flags used to gate only *connecting* a new channel,
 * leaving an already-connected channel's sync running even after a tenant
 * turned its flag off. Every other channel's own discovery query below
 * (Shopify, Walmart, eBay, Temu, TikTok, plus the Shopify catalog sync) got
 * the identical one-line join for the same reason -- see CLAUDE.md's
 * "Channel Feature Flags" section for the updated scope note.
 */
export async function syncAmazonOrders(params: SyncAmazonOrdersParams): Promise<TenantSyncResult[]> {
  const { appPool, adminPool, eventBus } = params;

  const orderService = new OrderService(appPool, eventBus);
  const rulesEngine = new RulesEngine(appPool);
  rulesEngine.attach(eventBus);
  const usageReporter = new UsageReporter(appPool);
  usageReporter.attach(eventBus);

  const tenants = await adminPool.query<{ tenant_id: string }>(
    `SELECT DISTINCT cc.tenant_id FROM channel_connections cc
      JOIN tenants t ON t.id = cc.tenant_id
      WHERE cc.channel = 'amazon' AND cc.status = 'active'
        AND (cc.rate_limited_until IS NULL OR cc.rate_limited_until <= now())
        AND 'amazon' = ANY(t.enabled_channels)`,
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
    if (err instanceof PartialOrderPersistFailureError) {
      return recordPartialOrderPersistFailure(appPool, tenantId, "amazon", err);
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Amazon order sync failed for tenant ${tenantId}, continuing with remaining tenants:`, message);
    // Cross-run failure tracking/alerting -- see recordSyncFailure()'s doc
    // comment. This used to be a KNOWN GAP (a dead connection failing
    // silently forever, no signal anywhere beyond this one log line); it
    // no longer is.
    await recordSyncFailure(appPool, tenantId, "amazon", message);
    // CLAUDE.md §4.4's cross-run circuit breaker -- only when
    // fetchWithBackoff itself already exhausted its in-process retries (see
    // recordRateLimitTrip()'s doc comment for why this is additive to, not
    // a replacement for, the recordSyncFailure() call above).
    if (err instanceof RateLimitExhaustedError) {
      await recordRateLimitTrip(appPool, tenantId, "amazon", err.retryAfterMs);
    }
    return { tenantId, success: false, insertedOrderIds: [], skippedExternalOrderIds: [], error: message };
  }
}

/**
 * Shopify's channel #3 counterpart to {@link syncAmazonOrders} -- same
 * shape (discover every active connection of this channel, sync each
 * sequentially, never let one tenant's/store's failure stop the rest),
 * kept as a parallel function rather than a generic
 * "syncChannelOrders(channel)" abstraction: AmazonConnector's `isSandbox()`
 * lookback special-case (see syncTenant below) has no Shopify equivalent
 * (a Shopify dev store is a real store, not a separate sandbox environment
 * -- see ShopifyCredentials's own doc comment), and forcing that through a
 * shared function would need a channel-specific branch inside it anyway.
 * Revisit this duplication if/when a fourth channel makes the shared shape
 * actually pay for itself.
 *
 * Per-connection discovery, not per-tenant, mirroring TikTok Shop's own
 * true multi-shop CONNECT support (CLAUDE.md §4.8.1's "Update" paragraph):
 * a tenant with two active Shopify stores now gets two independent sync
 * attempts, each with its own cursor/failure count/rate-limit cooldown.
 */
export async function syncShopifyOrders(params: SyncAmazonOrdersParams): Promise<TenantSyncResult[]> {
  const { appPool, adminPool, eventBus } = params;

  const orderService = new OrderService(appPool, eventBus);
  const rulesEngine = new RulesEngine(appPool);
  rulesEngine.attach(eventBus);
  const usageReporter = new UsageReporter(appPool);
  usageReporter.attach(eventBus);

  const connections = await adminPool.query<{ id: string; tenant_id: string }>(
    `SELECT cc.id, cc.tenant_id FROM channel_connections cc
      JOIN tenants t ON t.id = cc.tenant_id
      WHERE cc.channel = 'shopify' AND cc.status = 'active'
        AND (cc.rate_limited_until IS NULL OR cc.rate_limited_until <= now())
        AND 'shopify' = ANY(t.enabled_channels)`,
  );

  const results: TenantSyncResult[] = [];
  for (const { id: connectionId, tenant_id: tenantId } of connections.rows) {
    results.push(await syncShopifyConnection(appPool, orderService, tenantId, connectionId));
  }
  return results;
}

/** Shopify counterpart to {@link runAmazonOrderSyncJob} -- see its doc comment. */
export async function runShopifyOrderSyncJob(appPool: Pool, adminPool: Pool): Promise<TenantSyncResult[]> {
  return syncShopifyOrders({ appPool, adminPool, eventBus: new InProcessEventBus() });
}

/**
 * Shopify counterpart to {@link syncTenant} -- identical error-isolation
 * contract (never throws; a bad token/connector error becomes a failed
 * result, not a stopped loop). No isSandbox()/canned-lookback branch here
 * -- ShopifyConnector has no sandbox concept to special-case (see
 * syncShopifyOrders's doc comment) -- `since` is always the real computed
 * value.
 *
 * Renamed from syncShopifyTenant (which it was until this pass) and given a
 * mandatory `connectionId`, the identical change TikTok's own
 * syncTikTokConnection already made (CLAUDE.md §4.8.1): every DB operation
 * below -- the last-sync-cursor read, credential loading, order persistence
 * (which now stamps `orders.channel_connection_id`, migration 0037), the
 * cursor UPDATE, and success/failure/rate-limit recording -- is scoped to
 * this ONE connection row, not "every active shopify row for this tenant"
 * the way it used to be. Two stores for the same tenant now genuinely sync
 * independently: each gets its own cursor, its own failure count, its own
 * rate-limit cooldown, and its own set of persisted orders correctly
 * attributed back to the store they actually came from.
 */
async function syncShopifyConnection(
  appPool: Pool,
  orderService: OrderService,
  tenantId: string,
  connectionId: string,
): Promise<TenantSyncResult> {
  const syncStartedAt = new Date();

  try {
    const lastSync = await withTenant(appPool, tenantId, (client) =>
      client.query<{ last_order_sync_at: string | null }>(
        `SELECT last_order_sync_at FROM channel_connections
          WHERE id = $1 AND tenant_id = $2 AND channel = 'shopify' AND status = 'active'`,
        [connectionId, tenantId],
      ),
    );
    const lastOrderSyncAt = lastSync.rows[0]?.last_order_sync_at;
    const since = lastOrderSyncAt ? new Date(lastOrderSyncAt) : new Date(syncStartedAt.getTime() - DEFAULT_LOOKBACK_MS);

    const connector = await createShopifyConnectorFromChannelConnection(appPool, tenantId, connectionId);
    const pulled = await connector.pullOrders(since);
    const persisted = await orderService.persistPulledOrders(tenantId, pulled, connectionId);

    // Same start-time-not-now reasoning as syncTenant() -- migration 0015's
    // comment applies identically here.
    await withTenant(appPool, tenantId, (client) =>
      client.query(
        `UPDATE channel_connections SET last_order_sync_at = $1, updated_at = now()
          WHERE id = $2 AND tenant_id = $3 AND channel = 'shopify' AND status = 'active'`,
        [syncStartedAt.toISOString(), connectionId, tenantId],
      ),
    );
    await recordSyncSuccess(appPool, tenantId, "shopify", connectionId);

    return { tenantId, connectionId, success: true, ...persisted, error: null };
  } catch (err) {
    if (err instanceof PartialOrderPersistFailureError) {
      return recordPartialOrderPersistFailure(appPool, tenantId, "shopify", err, connectionId);
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `Shopify order sync failed for tenant ${tenantId}, connection ${connectionId}, continuing with remaining stores/tenants:`,
      message,
    );
    // Same cross-run failure tracking as syncTenant() -- see
    // recordSyncFailure()'s doc comment. Scoped to this one connectionId, so
    // it can never flip a different, healthy store's status to 'error'.
    await recordSyncFailure(appPool, tenantId, "shopify", message, connectionId);
    // Same cross-run circuit breaker as syncTenant() -- see
    // recordRateLimitTrip()'s doc comment. Also scoped to this connectionId.
    if (err instanceof RateLimitExhaustedError) {
      await recordRateLimitTrip(appPool, tenantId, "shopify", err.retryAfterMs, connectionId);
    }
    return { tenantId, connectionId, success: false, insertedOrderIds: [], skippedExternalOrderIds: [], error: message };
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
  const usageReporter = new UsageReporter(appPool);
  usageReporter.attach(eventBus);

  const tenants = await adminPool.query<{ tenant_id: string }>(
    `SELECT DISTINCT cc.tenant_id FROM channel_connections cc
      JOIN tenants t ON t.id = cc.tenant_id
      WHERE cc.channel = 'walmart' AND cc.status = 'active'
        AND (cc.rate_limited_until IS NULL OR cc.rate_limited_until <= now())
        AND 'walmart' = ANY(t.enabled_channels)`,
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

/** Walmart counterpart to {@link syncTenant} (Shopify's own single-tenant
 *  equivalent, syncShopifyTenant, was renamed to the per-connection
 *  syncShopifyConnection when Shopify gained true multi-store support --
 *  Walmart itself has no multi-store concept, so this function's own shape
 *  is unchanged) -- identical error-isolation contract (never throws; a bad
 *  clientId/clientSecret pair or connector error becomes a failed result,
 *  not a stopped loop). No isSandbox()/canned-lookback branch here either --
 *  like Shopify, WalmartConnector always talks to the real computed `since`
 *  (see
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

    // Same start-time-not-now reasoning as syncShopifyConnection()/syncTenant()
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
    if (err instanceof PartialOrderPersistFailureError) {
      return recordPartialOrderPersistFailure(appPool, tenantId, "walmart", err);
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Walmart order sync failed for tenant ${tenantId}, continuing with remaining tenants:`, message);
    // Same cross-run failure tracking as syncTenant()/syncShopifyConnection()
    // -- see recordSyncFailure()'s doc comment. Doubly expected to fire
    // (and to flip status to 'error' within CONSECUTIVE_FAILURE_ERROR_THRESHOLD
    // runs) for every Walmart-connected tenant right now, given the
    // UNVERIFIED status above -- that's the correct, intended behavior,
    // not a bug: an unverified connection that's actually broken SHOULD
    // end up visibly in 'error' rather than failing invisibly forever.
    await recordSyncFailure(appPool, tenantId, "walmart", message);
    // Same cross-run circuit breaker as syncTenant() -- see
    // recordRateLimitTrip()'s doc comment.
    if (err instanceof RateLimitExhaustedError) {
      await recordRateLimitTrip(appPool, tenantId, "walmart", err.retryAfterMs);
    }
    return { tenantId, success: false, insertedOrderIds: [], skippedExternalOrderIds: [], error: message };
  }
}

/**
 * eBay's channel #4 counterpart to {@link syncWalmartOrders} -- same shape
 * again (discover every tenant with an active 'ebay' channel_connection,
 * sync each sequentially via adminPool/appPool, never let one tenant's
 * failure stop the rest). Kept as its own parallel function for the same
 * duplication-vs-abstraction call syncShopifyOrders's doc comment already
 * made, now with a fourth channel wired this way and still no shared shape
 * worth extracting.
 *
 * UNVERIFIED IN PRACTICE, more so even than Walmart's own wiring carried
 * before it had real credentials to try -- see EbayConnector's own class
 * doc comment: this environment's network policy blocks both eBay API
 * hosts entirely, so not even a sandbox call has been attempted from here.
 */
export async function syncEbayOrders(params: SyncAmazonOrdersParams): Promise<TenantSyncResult[]> {
  const { appPool, adminPool, eventBus } = params;

  const orderService = new OrderService(appPool, eventBus);
  const rulesEngine = new RulesEngine(appPool);
  rulesEngine.attach(eventBus);
  const usageReporter = new UsageReporter(appPool);
  usageReporter.attach(eventBus);

  const tenants = await adminPool.query<{ tenant_id: string }>(
    `SELECT DISTINCT cc.tenant_id FROM channel_connections cc
      JOIN tenants t ON t.id = cc.tenant_id
      WHERE cc.channel = 'ebay' AND cc.status = 'active'
        AND (cc.rate_limited_until IS NULL OR cc.rate_limited_until <= now())
        AND 'ebay' = ANY(t.enabled_channels)`,
  );

  const results: TenantSyncResult[] = [];
  for (const { tenant_id: tenantId } of tenants.rows) {
    results.push(await syncEbayTenant(appPool, orderService, tenantId));
  }
  return results;
}

/** eBay counterpart to {@link runWalmartOrderSyncJob} -- see its doc comment. */
export async function runEbayOrderSyncJob(appPool: Pool, adminPool: Pool): Promise<TenantSyncResult[]> {
  return syncEbayOrders({ appPool, adminPool, eventBus: new InProcessEventBus() });
}

/** eBay counterpart to {@link syncWalmartTenant} -- identical
 *  error-isolation contract (never throws; a bad/expired refresh token or
 *  connector error becomes a failed result, not a stopped loop). No
 *  isSandbox()/canned-lookback branch here either -- like Shopify/Walmart,
 *  EbayConnector always talks to the real computed `since`
 *  (createEbayConnectorFromChannelConnection is always constructed against
 *  EBAY_API_PRODUCTION_BASE_URL, a real tenant connecting their real seller
 *  account, never this repo's internal sandbox host). */
async function syncEbayTenant(appPool: Pool, orderService: OrderService, tenantId: string): Promise<TenantSyncResult> {
  const syncStartedAt = new Date();

  try {
    const lastSync = await withTenant(appPool, tenantId, (client) =>
      client.query<{ last_order_sync_at: string | null }>(
        `SELECT last_order_sync_at FROM channel_connections
          WHERE tenant_id = $1 AND channel = 'ebay' AND status = 'active'
          ORDER BY created_at DESC LIMIT 1`,
        [tenantId],
      ),
    );
    const lastOrderSyncAt = lastSync.rows[0]?.last_order_sync_at;
    const since = lastOrderSyncAt ? new Date(lastOrderSyncAt) : new Date(syncStartedAt.getTime() - DEFAULT_LOOKBACK_MS);

    const connector = await createEbayConnectorFromChannelConnection(appPool, tenantId);
    const pulled = await connector.pullOrders(since);
    const persisted = await orderService.persistPulledOrders(tenantId, pulled);

    // Same start-time-not-now reasoning as syncWalmartTenant()/syncTenant()
    // -- migration 0015's comment applies identically here.
    await withTenant(appPool, tenantId, (client) =>
      client.query(
        `UPDATE channel_connections SET last_order_sync_at = $1, updated_at = now()
          WHERE tenant_id = $2 AND channel = 'ebay' AND status = 'active'`,
        [syncStartedAt.toISOString(), tenantId],
      ),
    );
    await recordSyncSuccess(appPool, tenantId, "ebay");

    return { tenantId, success: true, ...persisted, error: null };
  } catch (err) {
    if (err instanceof PartialOrderPersistFailureError) {
      return recordPartialOrderPersistFailure(appPool, tenantId, "ebay", err);
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`eBay order sync failed for tenant ${tenantId}, continuing with remaining tenants:`, message);
    // Same cross-run failure tracking as syncWalmartTenant() -- see
    // recordSyncFailure()'s doc comment. Doubly expected to fire for every
    // eBay-connected tenant right now, given the UNVERIFIED status above --
    // that's the correct, intended behavior, same reasoning
    // syncWalmartTenant()'s own doc comment already gives for Walmart.
    await recordSyncFailure(appPool, tenantId, "ebay", message);
    // Same cross-run circuit breaker as syncTenant() -- see
    // recordRateLimitTrip()'s doc comment.
    if (err instanceof RateLimitExhaustedError) {
      await recordRateLimitTrip(appPool, tenantId, "ebay", err.retryAfterMs);
    }
    return { tenantId, success: false, insertedOrderIds: [], skippedExternalOrderIds: [], error: message };
  }
}

/**
 * Temu's channel #5 counterpart to {@link syncEbayOrders} -- same shape
 * again (discover every tenant with an active 'temu' channel_connection,
 * sync each sequentially via adminPool/appPool, never let one tenant's
 * failure stop the rest). Kept as its own parallel function for the same
 * duplication-vs-abstraction call syncShopifyOrders's doc comment already
 * made, now with a fifth channel wired this way and still no shared shape
 * worth extracting.
 *
 * UNVERIFIED IN PRACTICE, more so than any other channel wired here,
 * including eBay -- see TemuConnector's own class doc comment in
 * temu-connector.ts for the full research trail. No Temu credentials of
 * any kind exist anywhere in this codebase yet, so every tenant this
 * discovers (if any) will currently fail before ever reaching
 * createTemuConnectorFromChannelConnection() at all.
 */
export async function syncTemuOrders(params: SyncAmazonOrdersParams): Promise<TenantSyncResult[]> {
  const { appPool, adminPool, eventBus } = params;

  const orderService = new OrderService(appPool, eventBus);
  const rulesEngine = new RulesEngine(appPool);
  rulesEngine.attach(eventBus);
  const usageReporter = new UsageReporter(appPool);
  usageReporter.attach(eventBus);

  const tenants = await adminPool.query<{ tenant_id: string }>(
    `SELECT DISTINCT cc.tenant_id FROM channel_connections cc
      JOIN tenants t ON t.id = cc.tenant_id
      WHERE cc.channel = 'temu' AND cc.status = 'active'
        AND (cc.rate_limited_until IS NULL OR cc.rate_limited_until <= now())
        AND 'temu' = ANY(t.enabled_channels)`,
  );

  const results: TenantSyncResult[] = [];
  for (const { tenant_id: tenantId } of tenants.rows) {
    results.push(await syncTemuTenant(appPool, orderService, tenantId));
  }
  return results;
}

/** Temu counterpart to {@link runEbayOrderSyncJob} -- see its doc comment. */
export async function runTemuOrderSyncJob(appPool: Pool, adminPool: Pool): Promise<TenantSyncResult[]> {
  return syncTemuOrders({ appPool, adminPool, eventBus: new InProcessEventBus() });
}

/** Temu counterpart to {@link syncEbayTenant} -- identical error-isolation
 *  contract (never throws; a bad/missing credential or connector error
 *  becomes a failed result, not a stopped loop). No isSandbox()/canned-
 *  lookback branch here either -- like Shopify/Walmart/eBay,
 *  createTemuConnectorFromChannelConnection is always constructed against
 *  TEMU_API_PRODUCTION_BASE_URL (no distinct sandbox host was ever
 *  confirmed for Temu -- see TemuConnector's own class doc comment). */
async function syncTemuTenant(appPool: Pool, orderService: OrderService, tenantId: string): Promise<TenantSyncResult> {
  const syncStartedAt = new Date();

  try {
    const lastSync = await withTenant(appPool, tenantId, (client) =>
      client.query<{ last_order_sync_at: string | null }>(
        `SELECT last_order_sync_at FROM channel_connections
          WHERE tenant_id = $1 AND channel = 'temu' AND status = 'active'
          ORDER BY created_at DESC LIMIT 1`,
        [tenantId],
      ),
    );
    const lastOrderSyncAt = lastSync.rows[0]?.last_order_sync_at;
    const since = lastOrderSyncAt ? new Date(lastOrderSyncAt) : new Date(syncStartedAt.getTime() - DEFAULT_LOOKBACK_MS);

    const connector = await createTemuConnectorFromChannelConnection(appPool, tenantId);
    const pulled = await connector.pullOrders(since);
    const persisted = await orderService.persistPulledOrders(tenantId, pulled);

    // Same start-time-not-now reasoning as syncEbayTenant()/syncTenant() --
    // migration 0015's comment applies identically here.
    await withTenant(appPool, tenantId, (client) =>
      client.query(
        `UPDATE channel_connections SET last_order_sync_at = $1, updated_at = now()
          WHERE tenant_id = $2 AND channel = 'temu' AND status = 'active'`,
        [syncStartedAt.toISOString(), tenantId],
      ),
    );
    await recordSyncSuccess(appPool, tenantId, "temu");

    return { tenantId, success: true, ...persisted, error: null };
  } catch (err) {
    if (err instanceof PartialOrderPersistFailureError) {
      return recordPartialOrderPersistFailure(appPool, tenantId, "temu", err);
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Temu order sync failed for tenant ${tenantId}, continuing with remaining tenants:`, message);
    // Same cross-run failure tracking as syncEbayTenant() -- see
    // recordSyncFailure()'s doc comment. Doubly expected to fire for every
    // Temu-connected tenant right now, given the UNVERIFIED status above --
    // same intended behavior syncWalmartTenant()'s/syncEbayTenant()'s own
    // doc comments already give for an identical situation.
    await recordSyncFailure(appPool, tenantId, "temu", message);
    // Same cross-run circuit breaker as syncTenant() -- see
    // recordRateLimitTrip()'s doc comment.
    if (err instanceof RateLimitExhaustedError) {
      await recordRateLimitTrip(appPool, tenantId, "temu", err.retryAfterMs);
    }
    return { tenantId, success: false, insertedOrderIds: [], skippedExternalOrderIds: [], error: message };
  }
}

/**
 * TikTok Shop's channel #6 counterpart to {@link syncTemuOrders} -- same
 * shape again (discover every active 'tiktok' channel_connection, sync
 * each sequentially, never let one connection's failure stop the rest).
 * Kept as its own parallel function for the same duplication-vs-abstraction
 * call syncShopifyOrders's/syncTemuOrders's own doc comments already made,
 * now with a sixth channel wired this way and still no shared shape worth
 * extracting.
 *
 * **Closes CLAUDE.md §12's "TikTok Shop OAuth: no true multi-shop CONNECT"
 * gap**: every other channel's discovery query below deduplicates to one
 * row *per tenant* (`SELECT DISTINCT cc.tenant_id ...`) because none of
 * them can have more than one active connection per tenant. TikTok can --
 * §4.8.1's own multi-shop picker already lets a tenant connect several
 * shops, one at a time -- but until now this query still collapsed them
 * the same way, and syncTikTokTenant() (renamed {@link syncTikTokConnection}
 * below) always resolved credentials via "whichever row is most recently
 * created," so every shop beyond the newest one was silently never synced
 * at all. This now selects one row **per active connection**, not per
 * tenant -- a tenant with 3 connected shops gets 3 independent sync calls,
 * each its own `connectionId` threaded through credential loading, cursor
 * tracking, order persistence, and failure/success/rate-limit recording,
 * so one shop's problems (a revoked token, a rate limit) can never affect
 * another, unrelated shop for the same tenant.
 *
 * UNVERIFIED IN PRACTICE, same status Temu's own sync function carries and
 * for the same reason -- see TikTokConnector's own class doc comment in
 * tiktok-connector.ts for the full research trail. No TikTok credentials of
 * any kind exist anywhere in this codebase yet, so every connection this
 * discovers (if any) will currently fail before ever reaching
 * createTikTokConnectorFromChannelConnection() at all.
 */
export async function syncTikTokOrders(params: SyncAmazonOrdersParams): Promise<TenantSyncResult[]> {
  const { appPool, adminPool, eventBus } = params;

  const orderService = new OrderService(appPool, eventBus);
  const rulesEngine = new RulesEngine(appPool);
  rulesEngine.attach(eventBus);
  const usageReporter = new UsageReporter(appPool);
  usageReporter.attach(eventBus);

  const connections = await adminPool.query<{ id: string; tenant_id: string }>(
    `SELECT cc.id, cc.tenant_id FROM channel_connections cc
      JOIN tenants t ON t.id = cc.tenant_id
      WHERE cc.channel = 'tiktok' AND cc.status = 'active'
        AND (cc.rate_limited_until IS NULL OR cc.rate_limited_until <= now())
        AND 'tiktok' = ANY(t.enabled_channels)`,
  );

  const results: TenantSyncResult[] = [];
  for (const { id: connectionId, tenant_id: tenantId } of connections.rows) {
    results.push(await syncTikTokConnection(appPool, orderService, tenantId, connectionId));
  }
  return results;
}

/** TikTok counterpart to {@link runTemuOrderSyncJob} -- see its doc comment. */
export async function runTikTokOrderSyncJob(appPool: Pool, adminPool: Pool): Promise<TenantSyncResult[]> {
  return syncTikTokOrders({ appPool, adminPool, eventBus: new InProcessEventBus() });
}

/**
 * TikTok counterpart to {@link syncTemuTenant} -- identical error-isolation
 * contract (never throws; a bad/missing credential or connector error
 * becomes a failed result, not a stopped loop). No isSandbox()/canned-
 * lookback branch here either -- createTikTokConnectorFromChannelConnection
 * is always constructed against TIKTOK_API_BASE_URL (no confirmed sandbox
 * host exists for TikTok -- see TikTokConnector's own class doc comment).
 *
 * Renamed from syncTikTokTenant (which it was until this pass) and given a
 * mandatory `connectionId`, closing §12's own gap: every DB operation below
 * -- the last-sync-cursor read, credential loading, order persistence
 * (which now stamps `orders.channel_connection_id`, migration 0037), the
 * cursor UPDATE, and success/failure/rate-limit recording -- is scoped to
 * this ONE connection row, not "every active tiktok row for this tenant"
 * the way it used to be. Two shops for the same tenant now genuinely sync
 * independently: each gets its own cursor, its own failure count, its own
 * rate-limit cooldown, and its own set of persisted orders correctly
 * attributed back to the shop they actually came from.
 */
async function syncTikTokConnection(
  appPool: Pool,
  orderService: OrderService,
  tenantId: string,
  connectionId: string,
): Promise<TenantSyncResult> {
  const syncStartedAt = new Date();

  try {
    const lastSync = await withTenant(appPool, tenantId, (client) =>
      client.query<{ last_order_sync_at: string | null }>(
        `SELECT last_order_sync_at FROM channel_connections
          WHERE id = $1 AND tenant_id = $2 AND channel = 'tiktok' AND status = 'active'`,
        [connectionId, tenantId],
      ),
    );
    const lastOrderSyncAt = lastSync.rows[0]?.last_order_sync_at;
    const since = lastOrderSyncAt ? new Date(lastOrderSyncAt) : new Date(syncStartedAt.getTime() - DEFAULT_LOOKBACK_MS);

    const connector = await createTikTokConnectorFromChannelConnection(appPool, tenantId, connectionId);
    const pulled = await connector.pullOrders(since);
    const persisted = await orderService.persistPulledOrders(tenantId, pulled, connectionId);

    // Same start-time-not-now reasoning as syncTemuTenant()/syncTenant() --
    // migration 0015's comment applies identically here.
    await withTenant(appPool, tenantId, (client) =>
      client.query(
        `UPDATE channel_connections SET last_order_sync_at = $1, updated_at = now()
          WHERE id = $2 AND tenant_id = $3 AND channel = 'tiktok' AND status = 'active'`,
        [syncStartedAt.toISOString(), connectionId, tenantId],
      ),
    );
    await recordSyncSuccess(appPool, tenantId, "tiktok", connectionId);

    return { tenantId, connectionId, success: true, ...persisted, error: null };
  } catch (err) {
    if (err instanceof PartialOrderPersistFailureError) {
      return recordPartialOrderPersistFailure(appPool, tenantId, "tiktok", err, connectionId);
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `TikTok Shop order sync failed for tenant ${tenantId}, connection ${connectionId}, continuing with remaining shops/tenants:`,
      message,
    );
    // Same cross-run failure tracking as syncTemuTenant() -- see
    // recordSyncFailure()'s doc comment. Doubly expected to fire for every
    // TikTok-connected tenant right now, given the UNVERIFIED status above --
    // same intended behavior every other channel's own doc comment already
    // gives for an identical situation. Scoped to this one connectionId, so
    // it can never flip a different, healthy shop's status to 'error'.
    await recordSyncFailure(appPool, tenantId, "tiktok", message, connectionId);
    // Same cross-run circuit breaker as syncTenant() -- see
    // recordRateLimitTrip()'s doc comment. Also scoped to this connectionId.
    if (err instanceof RateLimitExhaustedError) {
      await recordRateLimitTrip(appPool, tenantId, "tiktok", err.retryAfterMs, connectionId);
    }
    return { tenantId, connectionId, success: false, insertedOrderIds: [], skippedExternalOrderIds: [], error: message };
  }
}

/** Every product/channel_listings row this catalog-sync job maintains uses
 *  this same location for its baseline stock -- see syncShopifyCatalogForConnection's
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
  /** Which specific channel_connections row this result is for -- populated
   *  now that catalog sync discovers per-connection, mirroring
   *  TenantSyncResult's own optional field (see its doc comment). */
  connectionId?: string;
  /** How many variants this run resolved via the SKU-namespace-collision
   *  path (resolveShopifyProductIdentity's own doc comment) instead of the
   *  ordinary merge-by-SKU path -- 0 for the overwhelming common case.
   *  Surfaced here, not just logged, so a real collision is visible in
   *  this job's own return value/reporting, not only in server logs. */
  skuCollisionsDetected: number;
}

export interface SyncShopifyCatalogParams {
  /** Same two-pool pattern as SyncAmazonOrdersParams -- see its doc comment. */
  appPool: Pool;
  adminPool: Pool;
}

/**
 * Closes the gap scripts/add-channel-listing.ts is a manual, one-SKU-at-a-time
 * stopgap for: pulls every connected Shopify store's full product catalog
 * (ShopifyConnector.pullProductCatalog) and upserts a products/
 * channel_listings row per SKU'd variant, exactly the shape that script
 * already creates by hand. Same discovery/per-connection-isolation shape as
 * syncShopifyOrders (enumerate active 'shopify' channel_connections rows via
 * adminPool, sync each one via appPool, one store's failure never stops the
 * rest) -- kept as its own function rather than folded into
 * syncShopifyOrders since catalog sync and order sync are genuinely
 * different operations with different failure/idempotency shapes, not just
 * a parameter away from each other.
 *
 * Per-connection discovery, not per-tenant, mirroring syncShopifyOrders' own
 * multi-store update above: a tenant with two active Shopify stores now gets
 * two independent catalog-sync attempts instead of only ever syncing
 * whichever store happens to be "most recent." See
 * syncShopifyCatalogForConnection's own doc comment for a real, deliberately
 * NOT closed gap this surfaces (a SKU string collision across two different
 * stores).
 */
export async function syncShopifyCatalog(params: SyncShopifyCatalogParams): Promise<CatalogSyncResult[]> {
  const { appPool, adminPool } = params;
  const inventoryService = new InventoryService(appPool);

  const connections = await adminPool.query<{ id: string; tenant_id: string }>(
    `SELECT cc.id, cc.tenant_id FROM channel_connections cc
      JOIN tenants t ON t.id = cc.tenant_id
      WHERE cc.channel = 'shopify' AND cc.status = 'active'
        AND (cc.rate_limited_until IS NULL OR cc.rate_limited_until <= now())
        AND 'shopify' = ANY(t.enabled_channels)`,
  );

  const results: CatalogSyncResult[] = [];
  for (const { id: connectionId, tenant_id: tenantId } of connections.rows) {
    results.push(await syncShopifyCatalogForConnection(appPool, inventoryService, tenantId, connectionId));
  }
  return results;
}

/** Convenience entrypoint mirroring {@link runAmazonOrderSyncJob} -- see its doc comment. */
export async function runShopifyCatalogSyncJob(appPool: Pool, adminPool: Pool): Promise<CatalogSyncResult[]> {
  return syncShopifyCatalog({ appPool, adminPool });
}

/**
 * Syncs one Shopify store's catalog. Never throws -- same per-connection
 * error isolation as syncShopifyConnection/syncTenant.
 *
 * Renamed from syncShopifyCatalogForTenant (which it was until this pass,
 * taking only a tenantId) and given a mandatory `connectionId`, the same
 * change syncShopifyOrders' own per-tenant sync function went through when
 * Shopify gained true multi-store support (see syncShopifyConnection's own
 * doc comment) -- `createShopifyConnectorFromChannelConnection` and
 * `recordRateLimitTrip` are now both scoped to this ONE connection, not
 * "whichever shopify row is most recent for this tenant."
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
 * **The SKU-namespace-collision gap this pass's own multi-store support
 * originally surfaced is now closed, see resolveShopifyProductIdentity's own
 * doc comment for the full mechanism (CLAUDE.md §4.5.1's own flagged gap,
 * closed via the redesign described there)**: `internal_sku` still defaults
 * to "shopify-<sku>" for the overwhelming common case (a single-store
 * tenant, or a second store that deliberately cross-lists the SAME physical
 * product under a shared SKU) -- unchanged, so nothing about an existing
 * single-store tenant's already-allocated inventory mapping moves. Only when
 * a genuine collision is DETECTED (a SKU already tied to a different,
 * active connection reports a materially different product title) does this
 * mint a new, connection-namespaced internal_sku instead of silently
 * merging two different products into one -- see
 * resolveShopifyProductIdentity's own doc comment for exactly how that
 * detection works and its own honest limits. `channel_listings` rows
 * themselves never collided either way (external_id is the variant's own
 * globally-unique gid) -- this was always specifically a
 * `products.internal_sku` risk, not a `channel_listings` one.
 *
 * Baseline stock is seeded via InventoryService.recordInventoryEvent with
 * idempotency_key = "catalog-onboarding:<tenantId>:shopify:<sku>" for the
 * ordinary (non-collision) case -- DELIBERATELY the same key prefix
 * scripts/add-channel-listing.ts's own manual seeding uses, not a separate
 * "catalog-sync:" prefix: idempotency_key is UNIQUE across the whole
 * inventory_events table regardless of which script or job wrote it, so a
 * SKU a human already onboarded by hand stays at whatever quantity they
 * entered -- this job's own attempt to seed a baseline for that same SKU
 * correctly becomes a no-op instead of adding a second, conflicting
 * "initial" receipt on top of real, already-allocated stock. Every
 * subsequent run of this job (for a SKU it or the manual script already
 * baselined) only re-upserts the product/listing rows -- cheap and
 * idempotent on their own UNIQUE constraints -- without touching inventory
 * again: this tenant's own ledger (orders, allocations, manual
 * pushInventory) is the ongoing source of truth after the first baseline,
 * not Shopify's currently-reported quantity. On the collision path, the
 * idempotency key is namespaced the identical way `internal_sku` itself
 * is (see resolveShopifyProductIdentity), so a genuinely distinct second
 * product gets its own real baseline instead of being silently treated as
 * "already baselined" under the first store's own key.
 */

/** Builds a short, SKU-safe slug from a Shopify store's own domain
 *  (channel_connections.external_account_id, e.g.
 *  "my-store.myshopify.com") -- only ever used on the genuine-collision
 *  path inside resolveShopifyProductIdentity, never for the common case,
 *  so a tenant who never hits a collision never sees this string anywhere.
 *  Strips the ".myshopify.com" suffix (redundant once "this is a Shopify
 *  store" is already implied), lowercases, and collapses every run of
 *  non-alphanumeric characters to a single "-". Deliberately permissive,
 *  not a strict domain validator -- a malformed value here should degrade
 *  to an ugly-but-stable slug, never throw and block a real sync; a blank
 *  result (a domain that's ALL punctuation, or missing) falls back to the
 *  literal word "store" rather than an empty string, so the namespaced SKU
 *  this feeds into is never left with a bare trailing/leading "shopify--sku". */
export function slugifyShopifyStoreDomain(externalAccountId: string): string {
  const withoutSuffix = externalAccountId.trim().toLowerCase().replace(/\.myshopify\.com$/, "");
  const slug = withoutSuffix.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "store";
}

/** True when two Shopify product titles should be treated as describing
 *  "the same product" for resolveShopifyProductIdentity's own
 *  collision-detection purposes -- exact match after trimming and
 *  lowercasing, deliberately NOT fuzzy. A near-miss title (a typo fix, a
 *  seasonal rename) is exactly the ambiguous case this function should
 *  surface as a possible collision rather than silently paper over by
 *  guessing "close enough" -- see resolveShopifyProductIdentity's own doc
 *  comment for how that ambiguity is actually resolved (a title match
 *  alone isn't sufficient either; a foreign-connection check gates it). */
export function titlesLikelySameProduct(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export interface ResolvedShopifyProductIdentity {
  internalSku: string;
  /** True when this resolution minted a NEW, connection-namespaced SKU
   *  because of a detected cross-store collision, rather than resolving to
   *  the ordinary "shopify-<sku>" default -- purely informational, used by
   *  the caller to log/count the occurrence (CatalogSyncResult's own
   *  skuCollisionsDetected field) so a real collision is visible, not
   *  silently invisible the way it was before this function existed. */
  isNamespacedForCollision: boolean;
}

/**
 * Resolves which `products.internal_sku` a given Shopify variant should be
 * upserted under -- closes CLAUDE.md §4.5.1's own flagged "SKU-namespace
 * collision" gap: two different connected Shopify stores sharing a literal
 * SKU string for two actually DIFFERENT products used to silently merge
 * into one products/inventory row, since `internal_sku` defaulted to
 * "shopify-<sku>" with no per-store namespacing at all.
 *
 * Deliberately does NOT namespace by connection for the overwhelming common
 * case -- a single-store tenant (the only case that existed before
 * multi-store support), or a second store that deliberately cross-lists the
 * SAME physical product under a shared SKU (a real, desirable pattern: one
 * inventory pool across both storefronts, not two). Namespacing
 * unconditionally would change `internal_sku` -- and therefore the
 * already-allocated inventory mapping -- for every existing tenant to guard
 * against a collision that can only happen once a tenant has genuinely
 * connected a second store, which is exactly the retrofit this function
 * avoids.
 *
 * **Why title comparison is the detection signal, and its own honest
 * limit**: there is no way to tell, from the SKU string alone, whether two
 * stores sharing a SKU means "the same physical product, deliberately
 * cross-listed" or "two unrelated products that happen to share a SKU
 * string." Shopify's own product TITLE is the best signal this codebase has
 * for telling those apart without asking the tenant directly: an exact
 * match (titlesLikelySameProduct, case/whitespace-insensitive) is treated
 * as the same product -- merge as before, no namespacing. A real mismatch
 * is treated as a genuine collision ONLY when that SKU is already tied to a
 * DIFFERENT, known `channel_connection_id` (a title that merely changed on
 * the SAME store, or a product with no connection attribution at all --
 * e.g. one seeded by scripts/add-channel-listing.ts before migration 0043
 * -- is not evidence of a cross-store collision, and keeps updating in
 * place exactly like before this function existed). This heuristic can
 * still be wrong in both directions -- two genuinely different products
 * that happen to share both a SKU AND an identical title would still
 * incorrectly merge, and a tenant who intentionally reuses a SKU across
 * stores for the same product but titles it slightly differently per store
 * would get unnecessarily namespaced into two products -- a perfect
 * disambiguation isn't possible from this data alone; this materially
 * narrows the real, non-theoretical risk CLAUDE.md §4.5.1 flagged, it
 * doesn't claim to eliminate it outright.
 *
 * Deliberately does NOT retroactively rename/split an already-merged
 * product -- this only changes what happens for a variant not yet resolved
 * to an existing product under the base SKU. A tenant who already has two
 * genuinely different products silently merged together (the exact
 * pre-existing bug this closes going forward) needs to split them by hand;
 * their `inventory_events`/`order_lines` already reference the shared
 * `product_id`, and safely un-merging an already-corrupted product is a
 * materially different, riskier piece of work than preventing a new one --
 * not attempted here.
 */
export async function resolveShopifyProductIdentity(
  client: PoolClient,
  tenantId: string,
  connectionId: string,
  connectionDomainSlug: string,
  externalSku: string,
  variantTitle: string,
): Promise<ResolvedShopifyProductIdentity> {
  const baseInternalSku = `shopify-${externalSku}`;
  const existing = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM products WHERE tenant_id = $1 AND internal_sku = $2`,
    [tenantId, baseInternalSku],
  );
  const existingProduct = existing.rows[0];
  if (!existingProduct || titlesLikelySameProduct(existingProduct.name, variantTitle)) {
    // No product under this SKU yet (nothing to collide with), or the
    // title matches -- same product, ordinary merge-by-SKU path.
    return { internalSku: baseInternalSku, isNamespacedForCollision: false };
  }
  // Titles differ. Only a genuine collision if that SKU is ALREADY tied to
  // a DIFFERENT, known connection -- see this function's own doc comment.
  const foreignConnection = await client.query(
    `SELECT 1 FROM channel_listings
      WHERE tenant_id = $1 AND product_id = $2 AND channel = 'shopify'
        AND channel_connection_id IS NOT NULL AND channel_connection_id != $3
      LIMIT 1`,
    [tenantId, existingProduct.id, connectionId],
  );
  if (foreignConnection.rows.length === 0) {
    return { internalSku: baseInternalSku, isNamespacedForCollision: false };
  }
  return {
    internalSku: `shopify-${connectionDomainSlug}-${externalSku}`,
    isNamespacedForCollision: true,
  };
}

async function syncShopifyCatalogForConnection(
  appPool: Pool,
  inventoryService: InventoryService,
  tenantId: string,
  connectionId: string,
): Promise<CatalogSyncResult> {
  let variants: NormalizedShopifyProductVariant[];
  try {
    const connector = await createShopifyConnectorFromChannelConnection(appPool, tenantId, connectionId);
    variants = await connector.pullProductCatalog();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `Shopify catalog sync failed for tenant ${tenantId}, connection ${connectionId}, continuing with remaining stores/tenants:`,
      message,
    );
    // Unlike recordSyncFailure() (deliberately skipped here, see below),
    // recordRateLimitTrip() IS called for a catalog-sync rate limit --
    // rate_limited_until lives on the same channel_connections row
    // syncShopifyOrders' discovery query also filters on, and a store
    // that's actively throttling this tenant's GraphQL calls is throttling
    // the same underlying API order sync also calls, regardless of which
    // job tripped it first. Skipping this would mean a sustained catalog
    // rate-limit gets silently retried every run forever, the exact
    // "no cross-run signal anywhere" gap recordSyncFailure() itself was
    // built to close. Scoped to this one connectionId, same as
    // syncShopifyConnection's own call.
    if (err instanceof RateLimitExhaustedError) {
      await recordRateLimitTrip(appPool, tenantId, "shopify", err.retryAfterMs, connectionId);
    }
    // Deliberately NOT wired into recordSyncFailure()/the shared
    // consecutive_failures counter that syncTenant()/syncShopifyConnection()/
    // syncWalmartTenant() now use (see recordSyncFailure()'s doc comment)
    // -- catalog sync and order sync are genuinely different operations
    // sharing the same channel_connections row (this function's own doc
    // comment above already makes that "different failure/idempotency
    // shapes" point), and pullProductCatalog() failing for reasons that
    // have nothing to do with pullOrders() (e.g. a GraphQL-only schema
    // quirk) should never flip a store's connection to 'error' and cut off
    // order sync, which may be working perfectly. This still logs every
    // failure, same as before -- it's cross-run tracking/alerting
    // specifically that's still an open gap here, deliberately, not fixed
    // by this change.
    return { tenantId, connectionId, success: false, variantsUpserted: 0, error: message, skuCollisionsDetected: 0 };
  }

  // Fetched once per connection, not per variant -- only used by
  // resolveShopifyProductIdentity's own collision-detection path below, so
  // a tenant who never hits a collision pays no extra per-variant cost for
  // it beyond this one query. withTenant (not a bare appPool.query) since
  // channel_connections' own RLS policy requires app.tenant_id to be set.
  const connectionDomainSlug = await withTenant(appPool, tenantId, async (client) => {
    const row = await client.query<{ external_account_id: string }>(
      `SELECT external_account_id FROM channel_connections WHERE id = $1 AND channel = 'shopify'`,
      [connectionId],
    );
    return slugifyShopifyStoreDomain(row.rows[0]?.external_account_id ?? connectionId);
  });

  let variantsUpserted = 0;
  let skuCollisionsDetected = 0;
  for (const variant of variants) {
    try {
      const { productId, locationId, internalSku, isNamespacedForCollision } = await withTenant(appPool, tenantId, async (client) => {
        const resolved = await resolveShopifyProductIdentity(
          client,
          tenantId,
          connectionId,
          connectionDomainSlug,
          variant.externalSku,
          variant.title,
        );

        const product = await client.query<{ id: string }>(
          `INSERT INTO products (tenant_id, internal_sku, name)
           VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, internal_sku) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [tenantId, resolved.internalSku, variant.title],
        );
        const productId = product.rows[0]!.id;

        // channel_connection_id (migration 0043) -- stamped here so a
        // product pulled in by ONE store's catalog sync doesn't read as a
        // store-unknown "legacy" row to the outbound listings route's own
        // duplicate-create guard (CLAUDE.md §4.5.5), which would otherwise
        // block that product from ever being listed on a SECOND store via
        // /products. Also updated on conflict, not just insert -- a variant
        // that already exists (a re-sync, or one originally seeded by
        // scripts/add-channel-listing.ts before this column existed) still
        // gets a correct, current connectionId rather than staying NULL
        // forever.
        await client.query(
          `INSERT INTO channel_listings
             (tenant_id, product_id, channel, channel_marketplace, external_id, external_sku, listing_status, channel_connection_id)
           VALUES ($1, $2, 'shopify', '', $3, $4, 'active', $5)
           ON CONFLICT (tenant_id, channel, channel_marketplace, external_id) DO UPDATE SET
             product_id = EXCLUDED.product_id,
             external_sku = EXCLUDED.external_sku,
             listing_status = 'active',
             channel_connection_id = EXCLUDED.channel_connection_id,
             updated_at = now()`,
          [tenantId, productId, variant.inventoryItemId, variant.externalSku, connectionId],
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

        return { productId, locationId, internalSku: resolved.internalSku, isNamespacedForCollision: resolved.isNamespacedForCollision };
      });

      if (isNamespacedForCollision) {
        skuCollisionsDetected++;
        console.warn(
          `Shopify catalog sync: SKU collision detected for tenant ${tenantId}, connection ${connectionId} -- ` +
            `sku '${variant.externalSku}' has a different product title than the existing 'shopify-${variant.externalSku}' ` +
            `product from another connected store, so it was onboarded separately as '${internalSku}' instead of merged. ` +
            "If this is actually the SAME physical product, rename one store's SKU to match, or merge the product records by hand.",
        );
      }

      // Namespaced identically to internalSku itself on the collision path
      // -- see resolveShopifyProductIdentity's own doc comment and this
      // function's own doc comment on why the ordinary (non-collision) key
      // stays byte-for-byte unchanged from before this pass.
      const idempotencyKey = isNamespacedForCollision
        ? `catalog-onboarding:${tenantId}:shopify:${connectionDomainSlug}:${variant.externalSku}`
        : `catalog-onboarding:${tenantId}:shopify:${variant.externalSku}`;

      await inventoryService.recordInventoryEvent({
        tenantId,
        productId,
        locationId,
        eventType: "receipt",
        quantityDelta: variant.totalAvailable,
        referenceType: "manual",
        idempotencyKey,
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
    connectionId,
    success: true,
    variantsUpserted,
    error: null,
    skuCollisionsDetected,
  };
}

/** How long an `api_rate_limit_windows` row (migration 0033) is kept before
 *  {@link cleanupRateLimitWindows} deletes it. A full day, not the 1-minute
 *  window itself -- a window's own doc comment/CLAUDE.md's "Audit Log" and
 *  reporting pages keep no comparable retention story, so there's no
 *  pressure to delete aggressively; a day of history is cheap and useful
 *  if this table is ever eyeballed for "was a tenant actually rate-limited
 *  recently," and this job runs daily (see the cron route this backs). */
const RATE_LIMIT_WINDOW_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes every expired row from BOTH of this app's rate-limit window
 * tables, older than `retentionMs`: `api_rate_limit_windows` (migration
 * 0033, tenant-scoped) and `public_ip_rate_limit_windows` (migration 0036,
 * IP-scoped, added when CLAUDE.md §16's own "fourth pass" note closed the
 * `leads/demo-request` gap). Migration 0033's own comment named this exact
 * cleanup as deferred, cheap future work "once it's worth writing" -- it's
 * worth writing now that CLAUDE.md §16's rate limiting covers every
 * mutation route in the app (originally nine, not just the order/picklist/
 * inventory hot path), so this table grows meaningfully faster than when
 * that deferral was written. Extended to the IP-scoped table rather than
 * standing up a second daily cron for it -- same "one rate-limit window
 * table, one shape, one retention story" reasoning that table's own
 * migration comment gives for reusing this job instead of a second one.
 *
 * Uses `adminPool`, not a per-tenant `withTenant` loop: this is a single
 * global maintenance sweep across every tenant's (or, for the IP-scoped
 * table, every requester's) rows by `window_start` alone, the same kind of
 * inherently cross-tenant operation `SyncAmazonOrdersParams.adminPool`'s
 * own doc comment justifies the admin connection for elsewhere in this
 * file -- RLS's per-tenant scoping has nothing to offer a query that isn't
 * about any one tenant, and `public_ip_rate_limit_windows` has no tenant
 * scoping to begin with (its own migration's `USING (true)` policy).
 * Returns the total number of rows deleted across both tables, for the cron
 * route's own response body/logging.
 */
export async function cleanupRateLimitWindows(
  adminPool: Pool,
  retentionMs: number = RATE_LIMIT_WINDOW_RETENTION_MS,
): Promise<number> {
  const cutoff = new Date(Date.now() - retentionMs);
  const tenantScoped = await adminPool.query("DELETE FROM api_rate_limit_windows WHERE window_start < $1", [cutoff]);
  const ipScoped = await adminPool.query("DELETE FROM public_ip_rate_limit_windows WHERE window_start < $1", [cutoff]);
  return (tenantScoped.rowCount ?? 0) + (ipScoped.rowCount ?? 0);
}

/** How many months past "now" to keep a real monthly partition of
 *  `inventory_events` (migration 0044) ready for. Migration 0044's own
 *  DEFAULT partition is a safety net, not the primary mechanism (see that
 *  migration's own doc comment) -- this job is what's actually supposed to
 *  keep every real insert landing in a proper monthly partition, never the
 *  DEFAULT one, under ordinary operation. 3 months of runway means even if
 *  this job's own daily cron were somehow down for weeks, there would still
 *  be a real partition waiting when it recovers. */
const INVENTORY_EVENT_PARTITION_MONTHS_AHEAD = 3;

/**
 * Ensures a real monthly range partition of `inventory_events` (migration
 * 0044_inventory_events_partitioning.sql) exists for every month from the
 * current one through `monthsAhead` months out. Naturally idempotent --
 * checks each month via `to_regclass` before creating it, so running this
 * daily creates, at most, one new partition (the month that just rolled
 * into the window) on most days and none on the rest; re-running it against
 * an already-fully-covered window is a safe no-op, same "idempotent by
 * construction" shape {@link cleanupRateLimitWindows} already has.
 *
 * Runs via `adminPool` (the schema-owning `DATABASE_URL` role, not
 * `app_user`) -- creating a partition is DDL (`CREATE TABLE ... PARTITION
 * OF ...`), which `app_user`'s own least-privilege grants (migration 0001)
 * were never meant to allow, the same reasoning every migration in this
 * codebase already runs as the schema owner rather than the app's own
 * runtime role.
 *
 * Returns the list of partition table names actually created this run
 * (empty on an ordinary day, once the current window is already covered).
 */
export async function ensureInventoryEventPartitions(
  adminPool: Pool,
  monthsAhead: number = INVENTORY_EVENT_PARTITION_MONTHS_AHEAD,
): Promise<string[]> {
  const created: string[] = [];
  const now = new Date();
  const startYear = now.getUTCFullYear();
  const startMonthIndex = now.getUTCMonth();

  for (let i = 0; i <= monthsAhead; i++) {
    const monthStart = new Date(Date.UTC(startYear, startMonthIndex + i, 1));
    const monthEnd = new Date(Date.UTC(startYear, startMonthIndex + i + 1, 1));
    const partitionName = `inventory_events_${monthStart.getUTCFullYear()}_${String(monthStart.getUTCMonth() + 1).padStart(2, "0")}`;

    const existing = await adminPool.query<{ existing: string | null }>("SELECT to_regclass($1)::text AS existing", [
      partitionName,
    ]);
    if (existing.rows[0]?.existing) {
      continue;
    }

    // Bounds are computed Date objects, never external input -- safe to
    // inline as ISO literals here the same way migration 0044's own DO
    // block builds its partition DDL via format(%L, ...), since neither
    // approach supports genuine $-parameter binding for a partition
    // bound's own literal syntax.
    await adminPool.query(
      `CREATE TABLE IF NOT EXISTS "${partitionName}" PARTITION OF inventory_events
         FOR VALUES FROM ('${monthStart.toISOString()}') TO ('${monthEnd.toISOString()}')`,
    );
    created.push(partitionName);
  }

  return created;
}

/** How many trailing UTC calendar days the nightly rollup job recomputes on
 *  every run, not just "yesterday." A day's own aggregate can change after
 *  it was first rolled up -- an order cancelled a day or two later, a
 *  backdated channel sync landing an order whose `placed_at` is slightly in
 *  the past -- so recomputing a short trailing window absorbs the common
 *  case for free. Deliberately NOT unlimited: a cancellation of an order
 *  placed further back than this window won't be reflected until a manual
 *  full recompute (`scripts/backfill-sales-rollups.ts`) is run -- a real,
 *  documented limitation, not silently assumed away. 3 days covers same-day
 *  and next-day cancellations/backdated syncs, the overwhelming majority of
 *  real-world cases, without turning every cron run into a full-history
 *  scan. */
const SALES_ROLLUP_RECOMPUTE_DAYS = 3;

/** Result of one {@link rollupDailySales} run -- row counts, not table
 *  contents, since this is a cron/backfill-script return value meant for
 *  logging, not a caller that needs the rows themselves (a caller wanting
 *  the actual numbers reads `daily_channel_sales_rollups`/
 *  `daily_product_sales_rollups` directly, the same tables /reports itself
 *  reads). */
export interface SalesRollupResult {
  channelRowsWritten: number;
  productRowsWritten: number;
  sinceDate: string;
  throughDate: string;
}

/**
 * Recomputes `daily_channel_sales_rollups`/`daily_product_sales_rollups`
 * (migration 0045) for every UTC calendar day in `[sinceDate, throughDate)`
 * -- CLAUDE.md §8 Phase 4's own pragmatic v1 of the deferred CDC-fed
 * reporting store, see that migration's own header comment for the full
 * reasoning (why this instead of standing up Debezium + ClickHouse/BigQuery
 * sight-unseen).
 *
 * Defaults to the trailing {@link SALES_ROLLUP_RECOMPUTE_DAYS} days ending
 * "today" (UTC) when no explicit range is given -- what the daily cron
 * route actually calls with. A caller doing a one-time historical backfill
 * (`scripts/backfill-sales-rollups.ts`) passes an explicit, much wider
 * `sinceDate` instead; the function itself doesn't know or care which case
 * it's in, it just recomputes whatever range it's given.
 *
 * DELETE-then-INSERT per table, not an upsert: an upsert (`ON CONFLICT ...
 * DO UPDATE`) can only ever raise or correct a group's own numbers, never
 * remove a row whose underlying orders have ALL since become cancelled
 * (that query now returns zero rows for that group, and an upsert has
 * nothing to reconcile against) -- exactly the failure mode that would
 * silently leave a stale, too-high rollup behind. DELETE-then-INSERT
 * against the same date range fixes that at the cost of a brief window
 * (between the DELETE and the following INSERT completing) where a
 * concurrent read of `/reports` could see an incomplete day -- the same
 * non-transactional two-statement shape {@link cleanupRateLimitWindows}
 * already uses for the identical reason (a rollup/cleanup table, not the
 * transactional order/inventory path CLAUDE.md §9's blue/green guidance is
 * actually protecting), and this only ever touches the trailing few days'
 * rows, never a day a report reader is likely to be summing at the exact
 * millisecond this job runs.
 *
 * Runs via `adminPool` (bypasses RLS) for the same reason every other
 * cross-tenant maintenance sweep in this file does (see
 * `SyncAmazonOrdersParams.adminPool`'s own doc comment): this aggregates
 * across every tenant in one query, not one tenant at a time, and
 * `app_user` has no INSERT/UPDATE/DELETE grant on either rollup table at
 * all (migration 0045's own comment) -- only this admin-run job ever
 * writes them.
 */
export async function rollupDailySales(
  adminPool: Pool,
  options?: { sinceDate?: Date; throughDate?: Date },
): Promise<SalesRollupResult> {
  const now = options?.throughDate ?? new Date();
  const throughDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const sinceDate =
    options?.sinceDate ??
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - SALES_ROLLUP_RECOMPUTE_DAYS));

  const channelDeleted = await adminPool.query(
    `DELETE FROM daily_channel_sales_rollups
      WHERE sale_date >= ($1::timestamptz AT TIME ZONE 'UTC')::date
        AND sale_date < ($2::timestamptz AT TIME ZONE 'UTC')::date`,
    [sinceDate.toISOString(), throughDate.toISOString()],
  );
  void channelDeleted; // row count not reported -- only the freshly-written count is, below

  const channelInserted = await adminPool.query(
    `INSERT INTO daily_channel_sales_rollups (tenant_id, sale_date, channel, order_count, units_sold, revenue, updated_at)
     SELECT o.tenant_id,
            (o.placed_at AT TIME ZONE 'UTC')::date AS sale_date,
            o.channel,
            count(DISTINCT o.id),
            coalesce(sum(ol.quantity), 0),
            coalesce(sum(ol.quantity * ol.unit_price), 0),
            now()
       FROM orders o
       JOIN order_lines ol ON ol.order_id = o.id
      WHERE o.status <> 'cancelled'
        AND o.placed_at >= $1 AND o.placed_at < $2
      GROUP BY o.tenant_id, (o.placed_at AT TIME ZONE 'UTC')::date, o.channel
     ON CONFLICT (tenant_id, sale_date, channel) DO UPDATE SET
       order_count = EXCLUDED.order_count, units_sold = EXCLUDED.units_sold,
       revenue = EXCLUDED.revenue, updated_at = EXCLUDED.updated_at`,
    [sinceDate.toISOString(), throughDate.toISOString()],
  );

  await adminPool.query(
    `DELETE FROM daily_product_sales_rollups
      WHERE sale_date >= ($1::timestamptz AT TIME ZONE 'UTC')::date
        AND sale_date < ($2::timestamptz AT TIME ZONE 'UTC')::date`,
    [sinceDate.toISOString(), throughDate.toISOString()],
  );

  const productInserted = await adminPool.query(
    `INSERT INTO daily_product_sales_rollups (tenant_id, sale_date, product_id, units_sold, revenue, updated_at)
     SELECT o.tenant_id,
            (o.placed_at AT TIME ZONE 'UTC')::date AS sale_date,
            ol.product_id,
            sum(ol.quantity),
            sum(ol.quantity * ol.unit_price),
            now()
       FROM order_lines ol
       JOIN orders o ON o.id = ol.order_id
      WHERE o.status <> 'cancelled'
        AND o.placed_at >= $1 AND o.placed_at < $2
      GROUP BY o.tenant_id, (o.placed_at AT TIME ZONE 'UTC')::date, ol.product_id
     ON CONFLICT (tenant_id, sale_date, product_id) DO UPDATE SET
       units_sold = EXCLUDED.units_sold, revenue = EXCLUDED.revenue, updated_at = EXCLUDED.updated_at`,
    [sinceDate.toISOString(), throughDate.toISOString()],
  );

  return {
    channelRowsWritten: channelInserted.rowCount ?? 0,
    productRowsWritten: productInserted.rowCount ?? 0,
    sinceDate: sinceDate.toISOString(),
    throughDate: throughDate.toISOString(),
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
  startEbayOrderSyncScheduler,
  runEbayOnceWithRetry,
  startTemuOrderSyncScheduler,
  runTemuOnceWithRetry,
  startTikTokOrderSyncScheduler,
  runTikTokOnceWithRetry,
  type AmazonOrderSyncSchedulerOptions,
  type ShopifyOrderSyncSchedulerOptions,
  type WalmartOrderSyncSchedulerOptions,
  type EbayOrderSyncSchedulerOptions,
  type TemuOrderSyncSchedulerOptions,
  type TikTokOrderSyncSchedulerOptions,
} from "./cron-runner.js";
