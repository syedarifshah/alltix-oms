import type { NextRequest } from "next/server";
import { withTenant, encryptChannelSecret } from "@alltix/db";
import { ShopifyConnector } from "@alltix/channel-connectors";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

/**
 * POST /api/channels/shopify/connect -- persists a tenant's Shopify custom-app
 * credentials from the /settings/channels "Connect Shopify" form.
 *
 * Structurally different from Amazon's connect/callback pair
 * (src/app/api/channels/amazon/{connect,callback}/route.ts): Shopify's
 * custom-app auth model has no OAuth redirect/consent screen at all (see
 * ShopifyCredentials's own doc comment in shopify-connector.ts) -- a shop
 * domain and a pre-generated Admin API access token are the entire
 * credential, typed directly into a plain HTML form and submitted here in
 * one step, mirroring src/app/api/rules/route.ts's form-POST pattern rather
 * than Amazon's two-route redirect dance.
 *
 * Not wrapped in withTenantAuth (which opens a `withTenant` transaction
 * before the handler runs at all): this handler's first real step is a
 * network round trip to Shopify (verifyConnection()) to validate the
 * submitted credentials, and holding a Postgres transaction open for the
 * duration of an external HTTP call is exactly what withTenantAuth's own doc
 * comment warns against for a delegating handler. requireCurrentUser does
 * the identical auth/tenant-resolution steps without opening one; withTenant
 * is then opened separately, only around the actual persist.
 *
 * Webhook signing secret (optional): a custom app's Dev Dashboard API
 * credentials page shows an "API secret key" alongside the Admin API access
 * token -- a *different* credential, never sent to Shopify on any API call
 * this connector makes, used only to verify the `X-Shopify-Hmac-Sha256`
 * header on an *inbound* webhook delivery (ShopifyConnector.
 * verifyShopifyWebhookHmac, called from /api/webhooks/shopify). It's stored
 * in `channel_connections.encrypted_client_secret` -- reusing the column
 * migration 0019 relaxed to nullable for exactly the opposite reason (a
 * Shopify row had nothing to put there): now that webhooks exist, a
 * per-tenant custom app's client secret is a legitimate, semantically
 * correct value for a column literally named encrypted_client_secret, so no
 * new migration/column was added for it. Left blank, the field is simply
 * never persisted or overwritten (see the COALESCE below) and
 * registerWebhooks() is skipped -- a tenant can connect and sync via the
 * daily cron (packages/scheduler) without ever entering one; there is no
 * way to validate a client secret's correctness up front the way
 * verifyConnection() validates the access token (Shopify exposes no "check
 * this secret" API), so a mistyped one just means every real webhook
 * delivery gets rejected with 401 at the route, logged, until it's
 * corrected -- the cron sync is unaffected either way.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const pool = getAppPool();
  const user = await requireCurrentUser(req, pool);
  if (!user) {
    return redirectWithError(req, "/settings/channels", "not signed in");
  }

  const formData = await req.formData();
  const shopDomain = normalizeShopDomain(String(formData.get("shopDomain") ?? ""));
  const accessToken = String(formData.get("accessToken") ?? "").trim();
  const clientSecret = String(formData.get("clientSecret") ?? "").trim();

  if (!shopDomain || !accessToken) {
    return redirectWithError(req, "/settings/channels", "shopify_missing_fields");
  }

  // Prove the pair actually authenticates against a real store before
  // persisting anything -- ShopifyConnector.verifyConnection()'s whole
  // purpose (see its doc comment) is catching a wrong domain or a
  // revoked/mistyped token here, at submit time, rather than silently
  // storing a connection that will fail on its first real pullOrders().
  // Declared outside the try so the webhook-registration step below (which
  // needs the same access-token-authenticated connector) can reuse it
  // instead of constructing a second instance from the same credentials.
  const connector = new ShopifyConnector({ shopDomain, accessToken });
  let shopName: string;
  try {
    ({ shopName } = await connector.verifyConnection());
  } catch (err) {
    return redirectWithError(req, "/settings/channels", `shopify_verify_failed:${errorMessage(err)}`);
  }

  try {
    await withTenant(pool, user.tenantId, async (client) => {
      const encryptedAccessToken = await encryptChannelSecret(client, accessToken);
      // Only encrypted when actually submitted -- see this route's own doc
      // comment on the webhook signing secret being optional. The COALESCE
      // in the UPDATE below means leaving this blank on a reconnect keeps
      // whatever secret (if any) was stored previously, rather than wiping
      // it out.
      const encryptedClientSecret = clientSecret ? await encryptChannelSecret(client, clientSecret) : null;

      // marketplace is stored as '' for every Shopify row -- one connected
      // store is one connection, full stop (see
      // migrations/0019_channel_connections_shopify.sql's header comment
      // and normalizeShopifyOrder's identical channelMarketplace: ""
      // convention) -- so (tenant_id, channel, marketplace,
      // external_account_id)'s existing UNIQUE constraint (0012) still
      // correctly keys one row per tenant per connected shop domain, and
      // reconnecting the same shop with a fresh token updates that row
      // instead of creating a duplicate. lwa_client_id/
      // encrypted_refresh_token are left NULL -- Amazon-OAuth concepts a
      // Shopify row has nothing to put in (0019). encrypted_client_secret
      // is the one 0019-relaxed column that DOES now get a real Shopify
      // value -- see this route's header comment.
      await client.query(
        `INSERT INTO channel_connections
           (tenant_id, channel, marketplace, external_account_id, encrypted_access_token, encrypted_client_secret, status)
         VALUES ($1, 'shopify', '', $2, $3, $4, 'active')
         ON CONFLICT (tenant_id, channel, marketplace, external_account_id)
         DO UPDATE SET
           encrypted_access_token = EXCLUDED.encrypted_access_token,
           encrypted_client_secret = COALESCE(EXCLUDED.encrypted_client_secret, channel_connections.encrypted_client_secret),
           status = 'active',
           updated_at = now()`,
        [user.tenantId, shopDomain, encryptedAccessToken, encryptedClientSecret],
      );
    });
  } catch (err) {
    return redirectWithError(req, "/settings/channels", `shopify_save_failed:${errorMessage(err)}`);
  }

  console.info(`Shopify connected for tenant ${user.tenantId}: ${shopName} (${shopDomain})`);

  // Webhook registration: only attempted when this submission actually
  // included a client secret (see this route's header comment) AND the
  // deployment has a public callback URL configured -- neither is a hard
  // requirement to connect at all, so a missing one just means "webhooks
  // aren't enabled for this tenant yet," not a connect failure. Never
  // throws (ShopifyConnector.registerWebhooks isolates per-topic failures
  // already); any thrown error here would still be a bug worth surfacing,
  // so it's caught and folded into the summary rather than left to bubble
  // past a connection that already persisted successfully.
  let webhookSummary: string | null = null;
  const webhookCallbackUrl = process.env.SHOPIFY_WEBHOOK_CALLBACK_URL;
  if (clientSecret && webhookCallbackUrl) {
    try {
      const results = await connector.registerWebhooks(webhookCallbackUrl);
      const succeeded = results.filter((r) => r.success).length;
      webhookSummary = `${succeeded}/${results.length}`;
      for (const result of results) {
        if (!result.success) {
          console.error(
            `Shopify webhook registration failed for tenant ${user.tenantId}, topic ${result.topic}: ${result.error}`,
          );
        }
      }
    } catch (err) {
      console.error(`Shopify webhook registration threw for tenant ${user.tenantId}:`, errorMessage(err));
      webhookSummary = "error";
    }
  } else if (clientSecret && !webhookCallbackUrl) {
    console.warn(
      `Shopify webhook signing secret was submitted for tenant ${user.tenantId} but SHOPIFY_WEBHOOK_CALLBACK_URL is not set -- skipping webhook registration (see .env.example).`,
    );
    webhookSummary = "not_configured";
  }

  const redirectPath = webhookSummary
    ? `/settings/channels?connected=shopify&webhooks=${encodeURIComponent(webhookSummary)}`
    : "/settings/channels?connected=shopify";
  return redirectTo(req, redirectPath);
}

/** Strips a pasted protocol/trailing slash and lowercases the domain --
 *  forgiving of a user pasting "https://foo.myshopify.com/" (a natural copy
 *  from a browser address bar) even though ShopifyCredentials.shopDomain
 *  itself documents the bare-domain form as what every Admin API call
 *  actually needs. Does not validate the "*.myshopify.com" shape beyond
 *  that -- verifyConnection()'s real API call is the actual validation. */
function normalizeShopDomain(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}
