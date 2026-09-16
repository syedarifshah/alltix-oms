import type { ReactElement } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { withTenant } from "@alltix/db";
import { createEbayConnectorFromChannelConnection, type EbayBusinessPolicies } from "@alltix/channel-connectors";
import { getAppPool } from "@/lib/db";
import { getAuthContext } from "@/lib/auth-context";
import { resolveTenantId } from "@/lib/with-tenant-auth";

export const dynamic = "force-dynamic";

/** consecutive_failures/last_failure_at/last_failure_message added by
 *  migrations/0021_channel_connections_failure_tracking.sql -- see that
 *  migration and packages/scheduler/src/index.ts's recordSyncFailure()/
 *  recordSyncSuccess() for how they're written. Present on every channel's
 *  row (all three interfaces below), never just Amazon's. */
interface FailureTrackingColumns {
  consecutive_failures: number;
  last_failure_at: string | null;
  last_failure_message: string | null;
}

interface ChannelConnectionRow extends FailureTrackingColumns {
  external_account_id: string;
  marketplace: string;
  status: string;
  created_at: string;
  last_order_sync_at: string | null;
  lwa_client_id: string;
}

/** Shopify's row has no lwa_client_id/marketplace to show (see
 *  migrations/0019_channel_connections_shopify.sql) -- external_account_id
 *  is the connected shop's *.myshopify.com domain instead of a seller id.
 *  has_webhook_secret reflects whether encrypted_client_secret is set --
 *  never the decrypted value itself, just whether real-time webhooks
 *  (see /api/webhooks/shopify) can possibly be verified for this
 *  connection or whether it's cron-only for now. */
interface ShopifyConnectionRow extends FailureTrackingColumns {
  external_account_id: string;
  status: string;
  created_at: string;
  last_order_sync_at: string | null;
  has_webhook_secret: boolean;
}

/** Walmart's row, like Shopify's, has no marketplace concept worth showing
 *  (stored as '' -- see loadWalmartCredentialsFromChannelConnection's own
 *  doc comment in walmart-connector.ts). external_account_id is the
 *  tenant's own Walmart clientId, not an independent seller id -- see the
 *  connect route's comment for why that reuse is deliberate. */
interface WalmartConnectionRow extends FailureTrackingColumns {
  external_account_id: string;
  status: string;
  created_at: string;
  last_order_sync_at: string | null;
}

/** eBay's row, like Walmart's, has no independent seller id and no
 *  marketplace concept worth showing -- external_account_id reuses the
 *  tenant's own eBay OAuth clientId (see the callback route's own comment
 *  for why). The four ebay_* columns (migration
 *  0026_channel_connections_ebay_selling_setup.sql) are the prerequisites
 *  EbayConnector.createListing() needs -- all nullable, since a freshly
 *  OAuth-connected row hasn't filled in the Selling Setup forms below yet. */
interface EbayConnectionRow extends FailureTrackingColumns {
  external_account_id: string;
  status: string;
  created_at: string;
  last_order_sync_at: string | null;
  ebay_fulfillment_policy_id: string | null;
  ebay_payment_policy_id: string | null;
  ebay_return_policy_id: string | null;
  ebay_merchant_location_key: string | null;
}

/** Temu's row, like Walmart's/eBay's, has no independent seller id and no
 *  marketplace concept worth showing -- external_account_id reuses the
 *  tenant's own Temu appKey (see the connect route's own comment for why). */
interface TemuConnectionRow extends FailureTrackingColumns {
  external_account_id: string;
  status: string;
  created_at: string;
  last_order_sync_at: string | null;
}

/** Sandbox vs. production is never stored as its own column (see
 *  packages/db/migrations/0012_channel_connections.sql) -- the connection's
 *  own lwa_client_id is compared against this process's known sandbox/
 *  production client ids to label it, entirely server-side. Only the label
 *  is ever rendered; the client id itself never reaches the page. */
function classifyEnvironment(lwaClientId: string): "Sandbox" | "Production" | "Unknown" {
  if (lwaClientId === process.env.AMAZON_SANDBOX_CLIENT_ID) return "Sandbox";
  if (lwaClientId === process.env.AMAZON_PRODUCTION_CLIENT_ID) return "Production";
  return "Unknown";
}

/**
 * Renders the sync-failure-tracking banner shared by all three channel
 * cards -- see migrations/0021_channel_connections_failure_tracking.sql
 * and recordSyncFailure()/recordSyncSuccess() in
 * packages/scheduler/src/index.ts for where these columns come from. Two
 * distinct states worth surfacing, one function so all three cards render
 * them identically:
 *
 *  - status === 'error': the connection has failed
 *    CONSECUTIVE_FAILURE_ERROR_THRESHOLD runs in a row and the scheduler has
 *    stopped retrying it automatically (see recordSyncFailure()'s doc
 *    comment) -- this is the "go reconnect this" case, shown as a danger
 *    alert with the last error message so a tenant doesn't have to guess
 *    what to fix.
 *  - status === 'active' but consecutive_failures > 0: currently healthy,
 *    but has failed at least once recently and hasn't yet failed enough
 *    times in a row to trip the threshold -- worth a quieter heads-up
 *    rather than silence, since a tenant one failure away from 'error' is
 *    useful to know about before it gets there.
 *
 * Returns null (renders nothing) for a healthy connection with no failure
 * history -- the common case shouldn't get a banner at all.
 */
function SyncFailureBanner({
  status,
  consecutive_failures: consecutiveFailures,
  last_failure_at: lastFailureAt,
  last_failure_message: lastFailureMessage,
}: FailureTrackingColumns & { status: string }): ReactElement | null {
  if (status === "error") {
    return (
      <div className="alert alert-danger" style={{ marginTop: 8, marginBottom: 0 }}>
        Sync stopped after {consecutiveFailures} consecutive failed runs
        {lastFailureAt && ` (last failure ${new Date(lastFailureAt).toISOString()})`}
        {lastFailureMessage && `: ${lastFailureMessage}`}. This connection will not be retried automatically --
        reconnect below once the underlying issue is fixed.
      </div>
    );
  }
  if (consecutiveFailures > 0) {
    return (
      <div className="alert alert-warning" style={{ marginTop: 8, marginBottom: 0 }}>
        {consecutiveFailures} sync failure{consecutiveFailures === 1 ? "" : "s"} in a row so far
        {lastFailureAt && ` (most recently ${new Date(lastFailureAt).toISOString()})`}
        {lastFailureMessage && `: ${lastFailureMessage}`}. Still syncing -- this is just a heads-up.
      </div>
    );
  }
  return null;
}

interface ChannelsSettingsPageProps {
  searchParams: Promise<{ connected?: string; error?: string; webhooks?: string }>;
}

/**
 * Shows whether Amazon is connected for the signed-in tenant, with a
 * "Connect Amazon" link to /api/channels/amazon/connect when it isn't.
 * Auth/tenant resolution mirrors src/app/orders/page.tsx exactly -- see that
 * file's comment for why this goes through getAuthContext/resolveTenantId
 * instead of calling Clerk's auth() directly.
 */
export default async function ChannelsSettingsPage({
  searchParams,
}: ChannelsSettingsPageProps): Promise<ReactElement> {
  const authContext = await getAuthContext(await headers());
  if (!authContext) {
    redirect("/sign-in");
  }

  const pool = getAppPool();
  const tenantId = await resolveTenantId(pool, authContext.clerkUserId);
  const { connected, error, webhooks } = await searchParams;

  if (!tenantId) {
    return (
      <main>
        <h1>Channels</h1>
        <p>No tenant is associated with this account yet.</p>
      </main>
    );
  }

  const { connection, shopifyConnection, walmartConnection, ebayConnection, temuConnection } = await withTenant(
    pool,
    tenantId,
    async (client) => {
      const amazonResult = await client.query<ChannelConnectionRow>(
        `SELECT external_account_id, marketplace, status, created_at, last_order_sync_at, lwa_client_id,
                consecutive_failures, last_failure_at, last_failure_message
           FROM channel_connections
          WHERE channel = 'amazon'
          ORDER BY created_at DESC
          LIMIT 1`,
      );
      const shopifyResult = await client.query<ShopifyConnectionRow>(
        `SELECT external_account_id, status, created_at, last_order_sync_at,
                (encrypted_client_secret IS NOT NULL) AS has_webhook_secret,
                consecutive_failures, last_failure_at, last_failure_message
           FROM channel_connections
          WHERE channel = 'shopify'
          ORDER BY created_at DESC
          LIMIT 1`,
      );
      const walmartResult = await client.query<WalmartConnectionRow>(
        `SELECT external_account_id, status, created_at, last_order_sync_at,
                consecutive_failures, last_failure_at, last_failure_message
           FROM channel_connections
          WHERE channel = 'walmart'
          ORDER BY created_at DESC
          LIMIT 1`,
      );
      const ebayResult = await client.query<EbayConnectionRow>(
        `SELECT external_account_id, status, created_at, last_order_sync_at,
                consecutive_failures, last_failure_at, last_failure_message,
                ebay_fulfillment_policy_id, ebay_payment_policy_id,
                ebay_return_policy_id, ebay_merchant_location_key
           FROM channel_connections
          WHERE channel = 'ebay'
          ORDER BY created_at DESC
          LIMIT 1`,
      );
      const temuResult = await client.query<TemuConnectionRow>(
        `SELECT external_account_id, status, created_at, last_order_sync_at,
                consecutive_failures, last_failure_at, last_failure_message
           FROM channel_connections
          WHERE channel = 'temu'
          ORDER BY created_at DESC
          LIMIT 1`,
      );
      return {
        connection: amazonResult.rows[0] ?? null,
        shopifyConnection: shopifyResult.rows[0] ?? null,
        walmartConnection: walmartResult.rows[0] ?? null,
        ebayConnection: ebayResult.rows[0] ?? null,
        temuConnection: temuResult.rows[0] ?? null,
      };
    },
  );

  const isConnected = connection?.status === "active";
  const environment = connection ? classifyEnvironment(connection.lwa_client_id) : null;
  const isShopifyConnected = shopifyConnection?.status === "active";
  const isWalmartConnected = walmartConnection?.status === "active";
  const isEbayConnected = ebayConnection?.status === "active";
  const isTemuConnected = temuConnection?.status === "active";
  const hasEbaySellingSetup =
    !!ebayConnection?.ebay_fulfillment_policy_id &&
    !!ebayConnection?.ebay_payment_policy_id &&
    !!ebayConnection?.ebay_return_policy_id &&
    !!ebayConnection?.ebay_merchant_location_key;

  // Business policies are fetched live from the tenant's own eBay account
  // (EbayConnector.fetchBusinessPolicies(), see its own doc comment for why
  // this app never creates policies itself) -- a real network call, unlike
  // every other query on this page, so it's wrapped in its own try/catch:
  // a tenant who's connected but whose token can't reach eBay right now
  // (this environment's own network block, an expired/revoked token) should
  // still see the rest of this page, just with an error message here
  // instead of a populated dropdown. Only attempted once setup isn't
  // already complete -- no reason to make this live call on every page
  // load once a tenant has already made their choice.
  let ebayPolicies: EbayBusinessPolicies | null = null;
  let ebayPoliciesError: string | null = null;
  if (isEbayConnected && !hasEbaySellingSetup) {
    try {
      const connector = await createEbayConnectorFromChannelConnection(pool, tenantId);
      ebayPolicies = await connector.fetchBusinessPolicies();
    } catch (err) {
      ebayPoliciesError = err instanceof Error ? err.message : String(err);
    }
  }

  return (
    <main className="page">
      <h1>Channels</h1>
      <p className="subtitle">
        Amazon, Shopify, Walmart, eBay, and Temu connectors. Walmart&apos;s, eBay&apos;s, and Temu&apos;s wiring is
        complete but UNVERIFIED against real infrastructure (no self-serve sandbox exists for any of the three the
        way Shopify/Amazon have one, this environment can&apos;t even reach eBay&apos;s API hosts at all, and
        Temu&apos;s own documentation could not be read by any method tried during its research pass) — connecting
        will correctly fail here until real credentials exist and a real round trip has happened.
      </p>

      {connected === "amazon" && <div className="alert alert-success">Amazon connected.</div>}
      {connected === "walmart" && <div className="alert alert-success">Walmart connected.</div>}
      {connected === "ebay" && <div className="alert alert-success">eBay connected.</div>}
      {connected === "temu" && <div className="alert alert-success">Temu connected.</div>}
      {connected === "ebay_policies" && <div className="alert alert-success">eBay business policies saved.</div>}
      {connected === "ebay_location" && <div className="alert alert-success">eBay merchant location created.</div>}
      {connected === "shopify" && (
        <div className="alert alert-success">
          Shopify connected.
          {webhooks === "not_configured" &&
            " A webhook signing secret was entered, but this deployment has no SHOPIFY_WEBHOOK_CALLBACK_URL configured yet -- syncing via the daily cron only."}
          {webhooks === "error" && " Webhook registration failed unexpectedly -- syncing via the daily cron only; check server logs."}
          {webhooks && /^\d+\/\d+$/.test(webhooks) &&
            (webhooks === "3/3"
              ? " Real-time webhooks registered (orders/create, orders/cancelled, app/uninstalled)."
              : ` Webhooks partially registered (${webhooks}) -- check server logs for which topic(s) failed.`)}
        </div>
      )}
      {error?.startsWith("shopify_") && <div className="alert alert-danger">Shopify connection failed ({error}).</div>}
      {error?.startsWith("walmart_") && <div className="alert alert-danger">Walmart connection failed ({error}).</div>}
      {error?.startsWith("ebay_policies_") && <div className="alert alert-danger">Saving eBay business policies failed ({error}).</div>}
      {error?.startsWith("ebay_location_") && <div className="alert alert-danger">Creating the eBay merchant location failed ({error}).</div>}
      {error?.startsWith("ebay_") && !error.startsWith("ebay_policies_") && !error.startsWith("ebay_location_") && (
        <div className="alert alert-danger">eBay connection failed ({error}).</div>
      )}
      {error?.startsWith("temu_") && <div className="alert alert-danger">Temu connection failed ({error}).</div>}
      {error &&
        !error.startsWith("shopify_") &&
        !error.startsWith("walmart_") &&
        !error.startsWith("ebay_") &&
        !error.startsWith("temu_") &&
        // Amazon's own error codes (e.g. "missing_callback_params",
        // "invalid_or_expired_state", "token_exchange_failed") were written
        // before any other channel had its own OAuth-redirect flow, so
        // unlike Shopify/Walmart/eBay they carry no distinguishing prefix
        // -- this catch-all stays Amazon-specific for exactly that reason,
        // not because it's a safe default for "anything unrecognized."
        // eBay's callback route deliberately prefixes every one of its own
        // error codes with "ebay_" (even where the underlying check is
        // conceptually identical to Amazon's, e.g. invalid/expired state)
        // specifically so they route to the eBay banner above instead of
        // falling into this catch-all -- see that route's own doc comment.
        (
          <div className="alert alert-danger">Amazon connection failed ({error}).</div>
        )}

      <h2>Amazon</h2>
      <div className="card">
        {connection ? (
          <div className="stack">
            <div className="row">
              <span className={isConnected ? "badge badge-success" : "badge badge-danger"}>{connection.status}</span>
              <span className="badge">{environment}</span>
              <span className="muted">seller {connection.external_account_id}</span>
              <span className="muted">marketplace {connection.marketplace}</span>
            </div>
            <div className="muted">Connected since {new Date(connection.created_at).toISOString()}</div>
            <div className="muted">
              Last order sync:{" "}
              {connection.last_order_sync_at ? new Date(connection.last_order_sync_at).toISOString() : "never synced yet"}
            </div>
            <SyncFailureBanner
              status={connection.status}
              consecutive_failures={connection.consecutive_failures}
              last_failure_at={connection.last_failure_at}
              last_failure_message={connection.last_failure_message}
            />
            {environment === "Production" && (
              <div className="alert alert-info" style={{ marginTop: 8, marginBottom: 0 }}>
                Production inventory/listing pushes are not enabled in this UI yet — pending Amazon&apos;s SP-API
                production role-grant review (see the production smoke test&apos;s 403 on
                marketplaceParticipations). Order pull and the pick/pack/ship workflow are unaffected.
              </div>
            )}
            {!isConnected && <a href="/api/channels/amazon/connect">Reconnect Amazon</a>}
          </div>
        ) : (
          <a href="/api/channels/amazon/connect">Connect Amazon</a>
        )}
      </div>

      <h2>Shopify</h2>
      <div className="card">
        {shopifyConnection ? (
          <div className="stack">
            <div className="row">
              <span className={isShopifyConnected ? "badge badge-success" : "badge badge-danger"}>
                {shopifyConnection.status}
              </span>
              <span className="muted">store {shopifyConnection.external_account_id}</span>
            </div>
            <div className="muted">Connected since {new Date(shopifyConnection.created_at).toISOString()}</div>
            <div className="muted">
              Last order sync:{" "}
              {shopifyConnection.last_order_sync_at
                ? new Date(shopifyConnection.last_order_sync_at).toISOString()
                : "never synced yet"}
            </div>
            <div className="muted">
              {shopifyConnection.has_webhook_secret
                ? "Real-time webhooks: signing secret on file (see /api/webhooks/shopify) -- orders/create, orders/cancelled, and app/uninstalled sync near-instantly; the daily cron still runs as a fallback."
                : "Real-time webhooks: not enabled -- no signing secret on file yet, syncing via the daily cron only. Enter the custom app's API secret key below to enable them."}
            </div>
            <SyncFailureBanner
              status={shopifyConnection.status}
              consecutive_failures={shopifyConnection.consecutive_failures}
              last_failure_at={shopifyConnection.last_failure_at}
              last_failure_message={shopifyConnection.last_failure_message}
            />
            {/* No OAuth reconnect redirect for Shopify (see the connect
                route's own doc comment) -- reconnecting means re-submitting
                the form below with a fresh token, so it's always shown
                rather than only when disconnected. */}
            <ShopifyConnectForm buttonLabel="Reconnect Shopify" />
          </div>
        ) : (
          <ShopifyConnectForm buttonLabel="Connect Shopify" />
        )}
      </div>

      <h2>Walmart</h2>
      <div className="card">
        {walmartConnection ? (
          <div className="stack">
            <div className="row">
              <span className={isWalmartConnected ? "badge badge-success" : "badge badge-danger"}>
                {walmartConnection.status}
              </span>
              <span className="muted">client id {walmartConnection.external_account_id}</span>
            </div>
            <div className="muted">Connected since {new Date(walmartConnection.created_at).toISOString()}</div>
            <div className="muted">
              Last order sync:{" "}
              {walmartConnection.last_order_sync_at
                ? new Date(walmartConnection.last_order_sync_at).toISOString()
                : "never synced yet"}
            </div>
            <div className="alert alert-info" style={{ marginTop: 8, marginBottom: 0 }}>
              UNVERIFIED against real Walmart infrastructure — this connection is wired the same way Amazon/Shopify
              are, but nothing has actually round-tripped against Walmart&apos;s live API yet (no self-serve
              sandbox exists to test against ahead of an approved seller account). Order sync failures are no
              longer silent, though — see below if this connection has started failing.
            </div>
            <SyncFailureBanner
              status={walmartConnection.status}
              consecutive_failures={walmartConnection.consecutive_failures}
              last_failure_at={walmartConnection.last_failure_at}
              last_failure_message={walmartConnection.last_failure_message}
            />
            {/* No OAuth reconnect redirect (same reasoning as Shopify's own
                form here) -- reconnecting means re-submitting this form with
                a fresh/corrected clientId+clientSecret pair. */}
            <WalmartConnectForm buttonLabel="Reconnect Walmart" />
          </div>
        ) : (
          <WalmartConnectForm buttonLabel="Connect Walmart" />
        )}
      </div>

      <h2>eBay</h2>
      <div className="card">
        {ebayConnection ? (
          <div className="stack">
            <div className="row">
              <span className={isEbayConnected ? "badge badge-success" : "badge badge-danger"}>
                {ebayConnection.status}
              </span>
              <span className="muted">client id {ebayConnection.external_account_id}</span>
            </div>
            <div className="muted">Connected since {new Date(ebayConnection.created_at).toISOString()}</div>
            <div className="muted">
              Last order sync:{" "}
              {ebayConnection.last_order_sync_at
                ? new Date(ebayConnection.last_order_sync_at).toISOString()
                : "never synced yet"}
            </div>
            <div className="alert alert-info" style={{ marginTop: 8, marginBottom: 0 }}>
              UNVERIFIED against real eBay infrastructure, more so even than Walmart&apos;s own connection above --
              this environment&apos;s network policy blocks eBay&apos;s API hosts outright, so nothing here has
              round-tripped against eBay at all, sandbox or production. Order sync failures are no longer silent,
              though — see below if this connection has started failing.
            </div>
            <SyncFailureBanner
              status={ebayConnection.status}
              consecutive_failures={ebayConnection.consecutive_failures}
              last_failure_at={ebayConnection.last_failure_at}
              last_failure_message={ebayConnection.last_failure_message}
            />
            {!isEbayConnected && <a href="/api/channels/ebay/connect">Reconnect eBay</a>}
            {isEbayConnected && !hasEbaySellingSetup && (
              <div className="stack" style={{ marginTop: 12 }}>
                <h3>Selling setup (required before creating eBay listings)</h3>
                <p className="muted">
                  eBay requires an offer to reference business policies and a merchant location already
                  set up on your own eBay account before it can publish — this app does not create business
                  policies on your behalf (create them once in Seller Hub if you haven&apos;t already, then
                  pick them here), but it does create the merchant location for you below.
                </p>
                {ebayPoliciesError && (
                  <div className="alert alert-danger">
                    Could not load business policies from eBay: {ebayPoliciesError}
                  </div>
                )}
                {ebayPolicies && <EbayBusinessPoliciesForm policies={ebayPolicies} />}
                <EbayMerchantLocationForm />
              </div>
            )}
            {isEbayConnected && hasEbaySellingSetup && (
              <div className="muted" style={{ marginTop: 8 }}>
                Selling setup complete — ready to create eBay listings from /products.
              </div>
            )}
          </div>
        ) : (
          <a href="/api/channels/ebay/connect">Connect eBay</a>
        )}
      </div>

      <h2>Temu</h2>
      <div className="card">
        {temuConnection ? (
          <div className="stack">
            <div className="row">
              <span className={isTemuConnected ? "badge badge-success" : "badge badge-danger"}>
                {temuConnection.status}
              </span>
              <span className="muted">app key {temuConnection.external_account_id}</span>
            </div>
            <div className="muted">Connected since {new Date(temuConnection.created_at).toISOString()}</div>
            <div className="muted">
              Last order sync:{" "}
              {temuConnection.last_order_sync_at
                ? new Date(temuConnection.last_order_sync_at).toISOString()
                : "never synced yet"}
            </div>
            <div className="alert alert-info" style={{ marginTop: 8, marginBottom: 0 }}>
              UNVERIFIED against real Temu infrastructure, more so than any other channel here -- Temu&apos;s own
              documentation could not be read by any method tried during this connector&apos;s research pass (see
              TemuConnector&apos;s own class doc comment), and no Temu credentials of any kind exist anywhere in
              this codebase yet. Order sync failures are no longer silent, though — see below if this connection
              has started failing.
            </div>
            <SyncFailureBanner
              status={temuConnection.status}
              consecutive_failures={temuConnection.consecutive_failures}
              last_failure_at={temuConnection.last_failure_at}
              last_failure_message={temuConnection.last_failure_message}
            />
            {/* No OAuth reconnect redirect (same reasoning as Walmart's own
                form here) -- reconnecting means re-submitting this form with
                a fresh/corrected appKey+appSecret+accessToken triple. */}
            <TemuConnectForm buttonLabel="Reconnect Temu" />
          </div>
        ) : (
          <TemuConnectForm buttonLabel="Connect Temu" />
        )}
      </div>
    </main>
  );
}

/**
 * Shopify has no OAuth consent screen to redirect to (unlike Amazon's
 * "Connect Amazon" link) -- a shop domain and a pre-generated custom-app
 * Admin API access token are typed directly into this plain HTML form and
 * POSTed to /api/channels/shopify/connect in one step, which validates the
 * pair live (ShopifyConnector.verifyConnection()) before persisting
 * anything. No client-side JS, consistent with every other mutation form in
 * this app (e.g. /rules's "New rule" form) -- CLAUDE.md's Next.js
 * conventions call for plain <form action method="POST"> submissions.
 *
 * The webhook signing secret field is optional (see the connect route's own
 * doc comment) -- left blank, the form still connects the store, it just
 * doesn't enable real-time webhooks (cron-only sync). Left blank on a
 * *reconnect*, an already-stored secret is preserved, not erased -- so a
 * tenant re-pasting a rotated access token doesn't have to also re-enter a
 * secret that hasn't changed.
 */
function ShopifyConnectForm({ buttonLabel }: { buttonLabel: string }): ReactElement {
  return (
    <form action="/api/channels/shopify/connect" method="POST" className="stack" style={{ marginTop: 8 }}>
      <label>
        Shop domain
        <input type="text" name="shopDomain" placeholder="your-store.myshopify.com" required />
      </label>
      <label>
        Admin API access token
        <input type="password" name="accessToken" placeholder="shpat_..." required />
      </label>
      <label>
        Webhook signing secret (optional -- enables real-time sync)
        <input type="password" name="clientSecret" placeholder="from the custom app's API credentials page" />
      </label>
      <button type="submit">{buttonLabel}</button>
    </form>
  );
}

/**
 * Walmart has no OAuth consent screen either (client_credentials grant, see
 * WalmartConnector's own class doc comment) -- a Client ID and Client Secret,
 * issued directly to the tenant's own Walmart seller/Solution Provider
 * account, are typed into this plain HTML form and POSTed to
 * /api/channels/walmart/connect in one step, which authenticates the pair
 * live before persisting anything (same "verify before persist" discipline
 * as ShopifyConnectForm above).
 *
 * Unlike Shopify's webhook secret, Walmart's clientSecret is not optional --
 * client_credentials has no separate cron-only fallback mode the way
 * webhooks-vs-cron does for Shopify, so both fields are required every
 * submission, including on reconnect (there's no "leave blank to keep the
 * existing secret" affordance here).
 */
function WalmartConnectForm({ buttonLabel }: { buttonLabel: string }): ReactElement {
  return (
    <form action="/api/channels/walmart/connect" method="POST" className="stack" style={{ marginTop: 8 }}>
      <label>
        Client ID
        <input type="text" name="clientId" placeholder="Walmart Marketplace API client ID" required />
      </label>
      <label>
        Client secret
        <input type="password" name="clientSecret" placeholder="Walmart Marketplace API client secret" required />
      </label>
      <button type="submit">{buttonLabel}</button>
    </form>
  );
}

/**
 * Lets a tenant pick, from business policies already fetched live from
 * their own eBay account (page-level `ebayPolicies`, see
 * EbayConnector.fetchBusinessPolicies()'s own doc comment), which one of
 * each type EbayConnector.createListing() should use. POSTs to
 * /api/channels/ebay/business-policies, which just persists the three
 * chosen ids -- no further validation happens there, since eBay itself is
 * the source of the option list a tenant is selecting from here.
 */
function EbayBusinessPoliciesForm({ policies }: { policies: EbayBusinessPolicies }): ReactElement {
  return (
    <form action="/api/channels/ebay/business-policies" method="POST" className="stack" style={{ marginTop: 8 }}>
      <label>
        Fulfillment policy
        <select name="fulfillmentPolicyId" required defaultValue="">
          <option value="" disabled>
            {policies.fulfillmentPolicies.length === 0 ? "No fulfillment policies found on your eBay account" : "Select a fulfillment policy"}
          </option>
          {policies.fulfillmentPolicies.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Payment policy
        <select name="paymentPolicyId" required defaultValue="">
          <option value="" disabled>
            {policies.paymentPolicies.length === 0 ? "No payment policies found on your eBay account" : "Select a payment policy"}
          </option>
          {policies.paymentPolicies.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Return policy
        <select name="returnPolicyId" required defaultValue="">
          <option value="" disabled>
            {policies.returnPolicies.length === 0 ? "No return policies found on your eBay account" : "Select a return policy"}
          </option>
          {policies.returnPolicies.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <button type="submit">Save business policies</button>
    </form>
  );
}

/**
 * Creates a real eBay merchant location (EbayConnector.createMerchantLocation(),
 * a genuine write against eBay's Inventory API, unlike the business
 * policies form above which only picks from what already exists) -- see
 * that method's own doc comment for the confirmed-vs-inferred field
 * breakdown. The merchant location key itself is generated by the API
 * route from the tenant id, not collected here -- a tenant only supplies
 * the address a real warehouse actually has.
 */
function EbayMerchantLocationForm(): ReactElement {
  return (
    <form action="/api/channels/ebay/location" method="POST" className="stack" style={{ marginTop: 8 }}>
      <label>
        Location name
        <input type="text" name="name" placeholder="Main Warehouse" required />
      </label>
      <label>
        Address line 1
        <input type="text" name="addressLine1" placeholder="123 Main St" required />
      </label>
      <label>
        City
        <input type="text" name="city" placeholder="Springfield" required />
      </label>
      <label>
        State/province
        <input type="text" name="stateOrProvince" placeholder="IL" required />
      </label>
      <label>
        Postal code
        <input type="text" name="postalCode" placeholder="62701" required />
      </label>
      <label>
        Country (2-letter code)
        <input type="text" name="country" placeholder="US" maxLength={2} required />
      </label>
      <button type="submit">Create merchant location</button>
    </form>
  );
}

/**
 * Temu has no OAuth consent screen either -- an App Key, App Secret, and
 * Access Token, issued directly to the tenant's own Temu Open Platform
 * application, are typed into this plain HTML form and POSTed to
 * /api/channels/temu/connect in one step, which authenticates the triple
 * live before persisting anything (same "verify before persist" discipline
 * as WalmartConnectForm above).
 *
 * All three fields are required every submission, including on reconnect --
 * same "no leave-blank-to-keep-the-existing-secret affordance" as
 * WalmartConnectForm, for the same reason (no separate cron-only fallback
 * mode to fall back to if one field is left out).
 */
function TemuConnectForm({ buttonLabel }: { buttonLabel: string }): ReactElement {
  return (
    <form action="/api/channels/temu/connect" method="POST" className="stack" style={{ marginTop: 8 }}>
      <label>
        App key
        <input type="text" name="appKey" placeholder="Temu Open Platform app key" required />
      </label>
      <label>
        App secret
        <input type="password" name="appSecret" placeholder="Temu Open Platform app secret" required />
      </label>
      <label>
        Access token
        <input type="password" name="accessToken" placeholder="Temu Open Platform access token" required />
      </label>
      <button type="submit">{buttonLabel}</button>
    </form>
  );
}
