import type { NextRequest } from "next/server";
import { withTenant, decryptChannelSecret } from "@alltix/db";
import { getAppPool } from "@/lib/db";
import { getAuthContext } from "@/lib/auth-context";
import { resolveTenantId } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";
import { verifyPendingTikTokConnectionToken } from "@/lib/tiktok-oauth-pending";
import { persistTikTokConnection } from "@/lib/tiktok-connection";

export const dynamic = "force-dynamic";

/**
 * POST /api/channels/tiktok/select-shop -- the "Connect selected shop"
 * form target on /settings/channels/tiktok-shops (the multi-shop picker
 * page ../callback/route.ts redirects to when a TikTok OAuth authorization
 * covers more than one shop). Takes the signed pending-connection token
 * that page rendered as a hidden field, plus the tenant's chosen `cipher`,
 * verifies both, decrypts the token's carried secrets (see
 * tiktok-oauth-pending.ts's own header comment for why they traveled
 * encrypted rather than in the clear), and persists the connection via the
 * exact same persistTikTokConnection() the manual-paste form and the
 * single-shop OAuth fast path both use.
 *
 * The chosen `cipher` is validated against the token's OWN embedded shop
 * list, never trusted as an arbitrary client-supplied string -- a tampered
 * or hand-crafted cipher that wasn't actually one of this authorization's
 * real shops is rejected the same way a tampered token itself is, before
 * anything is decrypted or persisted.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const formData = await req.formData();
  const token = String(formData.get("token") ?? "");
  const cipher = String(formData.get("cipher") ?? "");

  const pending = verifyPendingTikTokConnectionToken(token);
  if (!pending) {
    return redirectWithError(req, "/settings/channels", "tiktok_invalid_or_expired_pending_token");
  }

  // Application-layer defense-in-depth on top of the signed token, same
  // reasoning as every OAuth callback's own session-vs-state check in this
  // codebase.
  const authContext = await getAuthContext(req.headers);
  if (!authContext) {
    return redirectWithError(req, "/settings/channels", "tiktok_not_signed_in");
  }
  const pool = getAppPool();
  const tenantIdFromSession = await resolveTenantId(pool, authContext.clerkUserId);
  if (!tenantIdFromSession || tenantIdFromSession !== pending.tenantId) {
    return redirectWithError(req, "/settings/channels", "tiktok_tenant_mismatch");
  }

  const chosenShop = pending.shops.find((shop) => shop.cipher === cipher);
  if (!chosenShop) {
    return redirectWithError(req, "/settings/channels", "tiktok_invalid_shop_selection");
  }

  try {
    const { appSecret, accessToken, refreshToken } = await withTenant(pool, pending.tenantId, async (client) => ({
      appSecret: await decryptChannelSecret(client, Buffer.from(pending.encryptedAppSecret, "base64")),
      accessToken: await decryptChannelSecret(client, Buffer.from(pending.encryptedAccessToken, "base64")),
      refreshToken: await decryptChannelSecret(client, Buffer.from(pending.encryptedRefreshToken, "base64")),
    }));

    await persistTikTokConnection(pool, pending.tenantId, {
      appKey: pending.appKey,
      appSecret,
      accessToken,
      refreshToken,
      shopCipher: chosenShop.cipher,
    });
  } catch (err) {
    return redirectWithError(req, "/settings/channels", `tiktok_save_failed:${errorMessage(err)}`);
  }

  return redirectTo(req, "/settings/channels?connected=tiktok");
}
