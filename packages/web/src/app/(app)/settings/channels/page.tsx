import type { ReactElement } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { withTenant } from "@alltix/db";
import { getAppPool } from "@/lib/db";
import { getAuthContext } from "@/lib/auth-context";
import { resolveTenantId } from "@/lib/with-tenant-auth";

export const dynamic = "force-dynamic";

interface ChannelConnectionRow {
  external_account_id: string;
  marketplace: string;
  status: string;
  created_at: string;
  last_order_sync_at: string | null;
  lwa_client_id: string;
}

/** Shopify's row has no lwa_client_id/marketplace to show (see
 *  migrations/0019_channel_connections_shopify.sql) -- external_account_id
 *  is the connected shop's *.myshopify.com domain instead of a seller id. */
interface ShopifyConnectionRow {
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

interface ChannelsSettingsPageProps {
  searchParams: Promise<{ connected?: string; error?: string }>;
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
  const { connected, error } = await searchParams;

  if (!tenantId) {
    return (
      <main>
        <h1>Channels</h1>
        <p>No tenant is associated with this account yet.</p>
      </main>
    );
  }

  const { connection, shopifyConnection } = await withTenant(pool, tenantId, async (client) => {
    const amazonResult = await client.query<ChannelConnectionRow>(
      `SELECT external_account_id, marketplace, status, created_at, last_order_sync_at, lwa_client_id
         FROM channel_connections
        WHERE channel = 'amazon'
        ORDER BY created_at DESC
        LIMIT 1`,
    );
    const shopifyResult = await client.query<ShopifyConnectionRow>(
      `SELECT external_account_id, status, created_at, last_order_sync_at
         FROM channel_connections
        WHERE channel = 'shopify'
        ORDER BY created_at DESC
        LIMIT 1`,
    );
    return { connection: amazonResult.rows[0] ?? null, shopifyConnection: shopifyResult.rows[0] ?? null };
  });

  const isConnected = connection?.status === "active";
  const environment = connection ? classifyEnvironment(connection.lwa_client_id) : null;
  const isShopifyConnected = shopifyConnection?.status === "active";

  return (
    <main className="page">
      <h1>Channels</h1>
      <p className="subtitle">Amazon and Shopify connectors — Walmart/eBay aren&apos;t built yet.</p>

      {connected === "amazon" && <div className="alert alert-success">Amazon connected.</div>}
      {connected === "shopify" && <div className="alert alert-success">Shopify connected.</div>}
      {error?.startsWith("shopify_") ? (
        <div className="alert alert-danger">Shopify connection failed ({error}).</div>
      ) : (
        error && <div className="alert alert-danger">Amazon connection failed ({error}).</div>
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
      <button type="submit">{buttonLabel}</button>
    </form>
  );
}
