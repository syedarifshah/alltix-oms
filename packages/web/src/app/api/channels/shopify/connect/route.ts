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

  if (!shopDomain || !accessToken) {
    return redirectWithError(req, "/settings/channels", "shopify_missing_fields");
  }

  // Prove the pair actually authenticates against a real store before
  // persisting anything -- ShopifyConnector.verifyConnection()'s whole
  // purpose (see its doc comment) is catching a wrong domain or a
  // revoked/mistyped token here, at submit time, rather than silently
  // storing a connection that will fail on its first real pullOrders().
  let shopName: string;
  try {
    const connector = new ShopifyConnector({ shopDomain, accessToken });
    ({ shopName } = await connector.verifyConnection());
  } catch (err) {
    return redirectWithError(req, "/settings/channels", `shopify_verify_failed:${errorMessage(err)}`);
  }

  try {
    await withTenant(pool, user.tenantId, async (client) => {
      const encryptedAccessToken = await encryptChannelSecret(client, accessToken);

      // marketplace is stored as '' for every Shopify row -- one connected
      // store is one connection, full stop (see
      // migrations/0019_channel_connections_shopify.sql's header comment
      // and normalizeShopifyOrder's identical channelMarketplace: ""
      // convention) -- so (tenant_id, channel, marketplace,
      // external_account_id)'s existing UNIQUE constraint (0012) still
      // correctly keys one row per tenant per connected shop domain, and
      // reconnecting the same shop with a fresh token updates that row
      // instead of creating a duplicate. lwa_client_id/
      // encrypted_client_secret/encrypted_refresh_token are left NULL --
      // Amazon-OAuth concepts a Shopify row has nothing to put in (0019).
      await client.query(
        `INSERT INTO channel_connections
           (tenant_id, channel, marketplace, external_account_id, encrypted_access_token, status)
         VALUES ($1, 'shopify', '', $2, $3, 'active')
         ON CONFLICT (tenant_id, channel, marketplace, external_account_id)
         DO UPDATE SET
           encrypted_access_token = EXCLUDED.encrypted_access_token,
           status = 'active',
           updated_at = now()`,
        [user.tenantId, shopDomain, encryptedAccessToken],
      );
    });
  } catch (err) {
    return redirectWithError(req, "/settings/channels", `shopify_save_failed:${errorMessage(err)}`);
  }

  console.info(`Shopify connected for tenant ${user.tenantId}: ${shopName} (${shopDomain})`);
  return redirectTo(req, "/settings/channels?connected=shopify");
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
