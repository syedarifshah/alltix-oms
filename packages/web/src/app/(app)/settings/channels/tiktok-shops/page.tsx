import type { ReactElement } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAppPool } from "@/lib/db";
import { getAuthContext } from "@/lib/auth-context";
import { resolveTenantId } from "@/lib/with-tenant-auth";
import { verifyPendingTikTokConnectionToken } from "@/lib/tiktok-oauth-pending";

export const dynamic = "force-dynamic";

interface TikTokShopPickerPageProps {
  searchParams: Promise<{ token?: string }>;
}

/**
 * The multi-shop picker page /api/channels/tiktok/callback redirects to
 * when a completed TikTok OAuth authorization covers more than one shop
 * (see that route's own doc comment, and CLAUDE.md's TikTok OAuth section).
 * Not linked from anywhere in the UI directly -- only ever reached via that
 * redirect's own signed `token` query param, verified here the same way
 * every OAuth callback in this codebase verifies its own state token.
 *
 * A single, deliberately minimal plain <form method="POST"> to
 * /api/channels/tiktok/select-shop, same "no client JS" convention every
 * other mutation form in this app follows (CLAUDE.md's Next.js
 * conventions) -- one radio button per shop, the pending token carried
 * along as a hidden field so the POST target can re-verify it rather than
 * trusting this page's own already-completed verification.
 *
 * Auth/tenant resolution mirrors ../page.tsx exactly, with one extra check:
 * the signed-in tenant must match the token's OWN embedded tenantId, not
 * just be signed in at all -- the same defense-in-depth every OAuth
 * callback route in this codebase applies on top of its state/pending
 * token's own signature.
 */
export default async function TikTokShopPickerPage({ searchParams }: TikTokShopPickerPageProps): Promise<ReactElement> {
  const authContext = await getAuthContext(await headers());
  if (!authContext) {
    redirect("/sign-in");
  }

  const { token } = await searchParams;
  if (!token) {
    redirect("/settings/channels?error=tiktok_missing_pending_token");
  }

  const pending = verifyPendingTikTokConnectionToken(token);
  if (!pending) {
    redirect("/settings/channels?error=tiktok_invalid_or_expired_pending_token");
  }

  const pool = getAppPool();
  const tenantId = await resolveTenantId(pool, authContext.clerkUserId);
  if (!tenantId || tenantId !== pending.tenantId) {
    redirect("/settings/channels?error=tiktok_tenant_mismatch");
  }

  return (
    <main className="page">
      <h1>Choose a TikTok Shop</h1>
      <p className="subtitle">
        This TikTok Shop authorization covers {pending.shops.length} shops. Pick the one to connect to this
        account -- you can run this flow again later to connect another.
      </p>
      <div className="card">
        <form action="/api/channels/tiktok/select-shop" method="POST" className="stack">
          <input type="hidden" name="token" value={token} />
          {pending.shops.map((shop) => (
            <label key={shop.cipher} className="row">
              <input type="radio" name="cipher" value={shop.cipher} required />
              <span>
                {shop.name ?? shop.cipher}
                {shop.region ? ` (${shop.region})` : ""}
                {shop.name ? <span className="muted"> -- {shop.cipher}</span> : null}
              </span>
            </label>
          ))}
          <button type="submit">Connect selected shop</button>
        </form>
      </div>
    </main>
  );
}
