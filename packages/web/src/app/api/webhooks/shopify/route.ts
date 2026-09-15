import { NextResponse, type NextRequest } from "next/server";
import type { Pool } from "pg";
import { withTenant, decryptChannelSecret } from "@alltix/db";
import {
  normalizeShopifyOrderWebhookPayload,
  verifyShopifyWebhookHmac,
  type ShopifyOrderWebhookPayload,
} from "@alltix/channel-connectors";
import { InProcessEventBus, type OrderStatus } from "@alltix/shared";
import { OrderService } from "@alltix/order-service";
import { RulesEngine } from "@alltix/rules-engine";
import { getAppPool, getAdminPool } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/shopify -- receives the three deliveries
 * ShopifyConnector.registerWebhooks subscribes a store to (orders/create,
 * orders/cancelled, app/uninstalled; see SHOPIFY_WEBHOOK_TOPICS's own doc
 * comment for why exactly these three), registered from
 * /api/channels/shopify/connect when a tenant supplies a webhook signing
 * secret. This is what actually closes the "still cron-polling, once daily"
 * gap flagged when Shopify was first wired in -- packages/scheduler's
 * syncShopifyOrders keeps running as a same-day-latest fallback (a tenant
 * who never enters a client secret, or whose one delivery gets dropped,
 * still gets synced once a day), this route is what gets a real order into
 * the ledger within seconds instead.
 *
 * Multi-tenant credential resolution is the one genuinely new problem here
 * that neither the cron job nor the connect route has: a Shopify delivery
 * carries no tenant id, only X-Shopify-Shop-Domain -- so which tenant this
 * delivery belongs to, and which encrypted_client_secret to verify it
 * against, has to be resolved from the shop domain FIRST, before RLS can
 * scope anything. That's an inherently cross-tenant lookup, so
 * resolveShopifyWebhookTenant() below uses getAdminPool() (DATABASE_URL,
 * bypasses RLS) for exactly that one query+decrypt -- the same justified,
 * narrowly-scoped exception packages/scheduler's SyncAmazonOrdersParams.
 * adminPool and getAdminPool()'s own doc comment already document for
 * "which tenant owns X" queries a per-request web handler can't otherwise
 * do. Every subsequent read/write for the resolved tenantId goes through
 * getAppPool() via withTenant(), scoped exactly like the rest of the app --
 * nothing beyond that one lookup uses the admin pool.
 *
 * Raw body read via req.text() before anything else -- same reasoning as
 * the Stripe/Clerk webhook routes' own doc comments: the HMAC is computed
 * over the exact bytes Shopify sent, and JSON-parsing first can reorder or
 * reformat them and silently break verification.
 *
 * No CRON_SECRET-style bearer auth here (unlike /api/cron/*) -- Shopify
 * webhooks authenticate via the HMAC signature instead, which is the actual
 * per-request credential check (CLAUDE.md §6: "validate signatures on every
 * inbound webhook ... don't trust unsigned payloads").
 */
export async function POST(req: NextRequest): Promise<Response> {
  const rawBody = await req.text();
  const hmacHeader = req.headers.get("x-shopify-hmac-sha256");
  const topic = req.headers.get("x-shopify-topic");
  const shopDomain = req.headers.get("x-shopify-shop-domain");

  if (!hmacHeader || !topic || !shopDomain) {
    return NextResponse.json({ error: "missing required Shopify webhook headers" }, { status: 400 });
  }

  const resolved = await resolveShopifyWebhookTenant(getAdminPool(), shopDomain);
  if (!resolved) {
    console.warn(`Shopify webhook received for unrecognized/inactive shop domain '${shopDomain}' (topic ${topic}) -- ignoring.`);
    return NextResponse.json({ error: "unrecognized shop" }, { status: 404 });
  }
  const { tenantId, clientSecret } = resolved;

  if (!clientSecret) {
    console.error(
      `Shopify webhook received for tenant ${tenantId} (shop ${shopDomain}, topic ${topic}) but no webhook signing secret is on file -- cannot verify, refusing to process (CLAUDE.md §6: never trust an unsigned payload). Reconnect Shopify with the client secret filled in to enable webhooks.`,
    );
    return NextResponse.json({ error: "no webhook signing secret configured for this shop" }, { status: 401 });
  }

  if (!verifyShopifyWebhookHmac(rawBody, hmacHeader, clientSecret)) {
    console.error(`Shopify webhook HMAC verification failed for tenant ${tenantId} (shop ${shopDomain}, topic ${topic}) -- rejecting.`);
    return NextResponse.json({ error: "signature verification failed" }, { status: 401 });
  }

  const appPool = getAppPool();

  try {
    switch (topic) {
      case "orders/create":
        return await handleOrderCreate(appPool, tenantId, rawBody);
      case "orders/cancelled":
        return await handleOrderCancelled(appPool, tenantId, rawBody);
      case "app/uninstalled":
        return await handleAppUninstalled(appPool, tenantId, shopDomain);
      default:
        // Only the three topics registerWebhooks() subscribes to should
        // ever arrive here; anything else is unexpected but not harmful --
        // acknowledge it so Shopify doesn't retry forever.
        console.warn(`Shopify webhook: unhandled topic '${topic}' for tenant ${tenantId} -- ignoring.`);
        return NextResponse.json({ status: "ignored" });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Shopify webhook processing failed for tenant ${tenantId} (topic ${topic}):`, message);
    // A 500 here tells Shopify to retry with its own backoff -- appropriate
    // for a genuine transient failure (a DB hiccup, etc.); the alternative
    // (swallowing and returning 200) would silently drop an order.
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

interface ResolvedShopifyWebhookTenant {
  tenantId: string;
  /** null means a connection row was found but no signing secret is on
   *  file -- distinct from "no connection at all" (resolveShopifyWebhookTenant
   *  returns null itself for that case), since the caller needs to log/
   *  respond differently for each. */
  clientSecret: string | null;
}

/**
 * The one deliberately cross-tenant lookup this route needs -- see this
 * file's own header comment for why getAdminPool() is justified here. Uses
 * a single checked-out client (not adminPool.query() directly) because
 * decryptChannelSecret needs a real PoolClient, not just anything with a
 * compatible .query() method.
 */
async function resolveShopifyWebhookTenant(adminPool: Pool, shopDomain: string): Promise<ResolvedShopifyWebhookTenant | null> {
  const client = await adminPool.connect();
  try {
    const result = await client.query<{ tenant_id: string; encrypted_client_secret: Buffer | null }>(
      `SELECT tenant_id, encrypted_client_secret
         FROM channel_connections
        WHERE channel = 'shopify' AND external_account_id = $1 AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 1`,
      [shopDomain],
    );
    const row = result.rows[0];
    if (!row) return null;

    const clientSecret = row.encrypted_client_secret ? await decryptChannelSecret(client, row.encrypted_client_secret) : null;
    return { tenantId: row.tenant_id, clientSecret };
  } finally {
    client.release();
  }
}

/**
 * `orders/create`: normalizes Shopify's flat webhook payload the same way
 * pullOrders() normalizes the GraphQL shape (see
 * normalizeShopifyOrderWebhookPayload's own doc comment) and persists it
 * through the identical OrderService.persistPulledOrders() path the daily
 * cron uses -- same (tenant_id, channel, external_order_id) idempotency,
 * same received -> validated -> allocated walk, same RulesEngine
 * subscription opportunity for a routing rule. A fresh EventBus/RulesEngine
 * pair per delivery (rather than a shared singleton) mirrors
 * packages/scheduler's syncShopifyOrders -- both are stateless
 * orchestrators whose real work is already tenant-scoped internally, so
 * building them per call is cheap and avoids any cross-request state.
 */
async function handleOrderCreate(appPool: Pool, tenantId: string, rawBody: string): Promise<Response> {
  const payload = JSON.parse(rawBody) as ShopifyOrderWebhookPayload;
  const normalized = normalizeShopifyOrderWebhookPayload(payload);

  const eventBus = new InProcessEventBus();
  const orderService = new OrderService(appPool, eventBus);
  const rulesEngine = new RulesEngine(appPool);
  rulesEngine.attach(eventBus);

  const persisted = await orderService.persistPulledOrders(tenantId, [normalized]);
  return NextResponse.json({
    status: "ok",
    inserted: persisted.insertedOrderIds.length,
    skipped: persisted.skippedExternalOrderIds.length,
  });
}

/**
 * `orders/cancelled`: looks the order up by (tenant_id, channel='shopify',
 * external_order_id) -- the same GID normalizeShopifyOrderWebhookPayload
 * uses -- then transitions it to 'cancelled' via the existing
 * OrderService.transition/cancelOrder path (CLAUDE.md §3: "Cancellation
 * after allocation must emit a release inventory event, not just delete the
 * reservation"), the identical mechanism /api/orders/[id]/cancel already
 * uses for a human-initiated cancellation.
 *
 * ORDERING GAP -- narrowed, not fully closed (migration
 * 0025_early_channel_cancellations): if this delivery arrives before this
 * order has ever been created locally -- genuinely out-of-order delivery, or
 * a tenant enabling webhooks after an order was already placed *and*
 * cancelled on Shopify before the first cron catch-up ran -- there is
 * nothing here to cancel yet. Instead of just logging and dropping it (the
 * old behavior, which let a later orders/create delivery or cron pull insert
 * the order as normal and allocate real stock against it as if it were
 * never cancelled), this now records the cancellation in
 * early_channel_cancellations, keyed by the same (tenant_id, channel,
 * external_order_id) triple orders' own uniqueness uses.
 * OrderService.persistPulledOrders() -- the shared insert path both
 * handleOrderCreate below and packages/scheduler's cron pull go through --
 * consumes that row the moment it inserts this same order for the first
 * time, landing it straight in 'cancelled' instead of walking it through
 * validate/allocate (see persistPulledOrders()'s own doc comment for the
 * full mechanics). This closes the common case of the two deliveries
 * arriving sequentially, in either order; a genuine race between two
 * *concurrent* deliveries is still possible and is not what this closes.
 */
async function handleOrderCancelled(appPool: Pool, tenantId: string, rawBody: string): Promise<Response> {
  const payload = JSON.parse(rawBody) as ShopifyOrderWebhookPayload;
  const externalOrderId = payload.admin_graphql_api_id;

  const existing = await withTenant(appPool, tenantId, (client) =>
    client.query<{ id: string; status: OrderStatus }>(
      `SELECT id, status FROM orders WHERE tenant_id = $1 AND channel = 'shopify' AND external_order_id = $2`,
      [tenantId, externalOrderId],
    ),
  );
  const orderRow = existing.rows[0];
  if (!orderRow) {
    await withTenant(appPool, tenantId, (client) =>
      client.query(
        `INSERT INTO early_channel_cancellations (tenant_id, channel, external_order_id)
         VALUES ($1, 'shopify', $2)
         ON CONFLICT (tenant_id, channel, external_order_id) DO NOTHING`,
        [tenantId, externalOrderId],
      ),
    );
    console.warn(
      `Shopify orders/cancelled webhook for tenant ${tenantId}: order ${externalOrderId} not found locally yet -- staged in early_channel_cancellations so the order lands pre-cancelled once it's created (see handleOrderCancelled's own doc comment).`,
    );
    return NextResponse.json({ status: "ok", note: "order not found locally yet -- cancellation staged" });
  }

  if (orderRow.status === "cancelled") {
    // Redelivery of a webhook already processed -- Shopify's own
    // at-least-once delivery guarantee makes this expected, not an error;
    // treat it as the idempotent no-op it is rather than letting
    // OrderService.cancelOrder's guarded UPDATE throw "not in status X."
    return NextResponse.json({ status: "ok", note: "already cancelled" });
  }

  // A transition the state machine genuinely doesn't allow (e.g. this order
  // is already 'shipped'/'delivered' on our side by the time Shopify's
  // cancellation arrives) is a real conflict worth surfacing as a failure
  // -- CLAUDE.md §3 draws returned/refunded as the path off 'shipped', not
  // cancellation -- so it's left to throw up to the route's own catch
  // rather than swallowed here.
  await new OrderService(appPool).transition(tenantId, orderRow.id, orderRow.status, "cancelled");
  return NextResponse.json({ status: "ok" });
}

/**
 * `app/uninstalled`: flips this tenant's Shopify connection to
 * 'disconnected' the moment the merchant revokes access, instead of every
 * subsequent cron run/webhook delivery failing silently against a dead
 * token forever (the "no alerting" gap syncTenant's own doc comment in
 * packages/scheduler already flags for Amazon -- closed for real here, for
 * the one signal Shopify volunteers for free). Naturally idempotent: a
 * redelivered uninstall just re-runs a no-op UPDATE matching zero rows the
 * second time.
 */
async function handleAppUninstalled(appPool: Pool, tenantId: string, shopDomain: string): Promise<Response> {
  await withTenant(appPool, tenantId, (client) =>
    client.query(
      `UPDATE channel_connections SET status = 'disconnected', updated_at = now()
        WHERE tenant_id = $1 AND channel = 'shopify' AND external_account_id = $2 AND status = 'active'`,
      [tenantId, shopDomain],
    ),
  );
  console.info(`Shopify app uninstalled for tenant ${tenantId} (shop ${shopDomain}) -- connection marked disconnected.`);
  return NextResponse.json({ status: "ok" });
}
