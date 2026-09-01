import { withClerkUser, withTenant } from "@alltix/db";
import type { Pool, PoolClient } from "pg";
import { NextResponse, type NextRequest } from "next/server";
import { getAppPool } from "./db";
import { getAuthContext } from "./auth-context";

export interface TenantRequestContext {
  tenantId: string;
  clerkUserId: string;
  client: PoolClient;
}

type Handler = (req: NextRequest, ctx: TenantRequestContext) => Promise<Response>;

/**
 * Looks up the tenant_id for an already-authenticated Clerk user (via
 * withClerkUser, so the `users` self-lookup RLS policy applies). Exported
 * so a Server Component page -- which has no NextRequest/Response to hand
 * to {@link withTenantAuth} itself -- can still resolve tenant_id through
 * the identical query/RLS path a Route Handler uses, instead of a second,
 * parallel way of doing it.
 */
export async function resolveTenantId(pool: Pool, clerkUserId: string): Promise<string | null> {
  return withClerkUser(pool, clerkUserId, async (client) => {
    const result = await client.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM users WHERE clerk_user_id = $1",
      [clerkUserId],
    );
    return result.rows[0]?.tenant_id ?? null;
  });
}

/**
 * Wraps a Route Handler with the request-level tenant isolation contract:
 *
 *   1. Authenticate the caller via Clerk (or the test-only header bypass,
 *      see getAuthContext).
 *   2. Resolve their tenant_id by looking up `users` scoped to their own
 *      clerk_user_id (see withClerkUser / the `users` RLS policy).
 *   3. Open a transaction against Postgres on the `app_user` connection and
 *      run `SET LOCAL app.tenant_id = '<uuid>'` (via set_config(..., true)
 *      in withTenant) before the handler runs any query.
 *
 * SET LOCAL specifically -- not SET -- so the tenant context is scoped to
 * this one transaction and can never leak into a later request that reuses
 * the same pooled connection: once withTenant's transaction commits or rolls
 * back, Postgres discards the local setting even though the underlying TCP
 * connection returns to the pool for reuse.
 *
 * This is the logical equivalent of "auth middleware on every API request"
 * for this app. It doesn't live in src/proxy.ts (Next's Proxy convention,
 * formerly middleware.ts) even though Proxy defaults to the Node.js runtime
 * in this Next.js version and could reach Postgres: Proxy and a Route
 * Handler are separate invocations with no way to hand a live `pg`
 * transaction between them, so a transaction opened in Proxy wouldn't
 * actually wrap the handler's queries. src/proxy.ts only gates
 * unauthenticated access at the edge; every route handler under
 * src/app/api MUST be wrapped in this instead of querying the database
 * directly.
 */
export function withTenantAuth(handler: Handler) {
  return async function wrapped(req: NextRequest): Promise<Response> {
    const authContext = await getAuthContext(req.headers);
    if (!authContext) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }

    const pool = getAppPool();
    const tenantId = await resolveTenantId(pool, authContext.clerkUserId);

    if (!tenantId) {
      return NextResponse.json({ error: "no tenant associated with this user" }, { status: 403 });
    }

    return withTenant(pool, tenantId, (client) =>
      handler(req, { tenantId, clerkUserId: authContext.clerkUserId, client }),
    );
  };
}
