import type { ReactElement } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { withTenant } from "@alltix/db";
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

  const { connection, shopifyConnection, walmartConnection } = await withTenant(pool, tenantId, async (client) => {
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
    return {
      connection: amazonResult.rows[0] ?? null,
      shopifyConnection: shopifyResult.rows[0] ?? null,
      walmartConnection: walmartResult.rows[0] ?? null,
    };
  });

  const isConnected = connection?.status === "active";
  const environment = connection ? classifyEnvironment(connection.lwa_client_id) : null;
  const isShopifyConnected = shopifyConnection?.status === "active";
  const isWalmartConnected = walmartConnection?.status === "active";

  return (
    <main className="page">
      <h1>Channels</h1>
      <p className="subtitle">
        Amazon, Shopify, and Walmart connectors — eBay isn&apos;t built yet. Walmart&apos;s wiring is complete but
        UNVERIFIED against real Walmart infrastructure (no self-serve sandbox exists the way Shopify/Amazon have
        one) — connecting will correctly fail here until a real clientId/clientSecret pair is entered.
      </p>

      {connected === "amazon" && <div className="alert alert-success">Amazon connected.</div>}
      {connected === "walmart" && <div className="alert alert-success">Walmart connected.</div>}
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
      {error && !error.startsWith("shopify_") && !error.startsWith("walmart_") && (
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
