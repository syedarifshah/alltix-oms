import type { Pool } from "pg";
import { withClerkUser } from "@alltix/db";
import type { NextRequest } from "next/server";
import { getAuthContext } from "./auth-context";

/**
 * Platform-operator authorization -- closes CLAUDE.md §12's own "No
 * operator UI for channel flags" gap and §19.8's identical carrier-layer
 * gap. Deliberately NOT a new roles/RBAC system: a real, signed-in Clerk
 * user is a platform operator if and only if their own `users.email`
 * appears on a plain, comma-separated `PLATFORM_OPERATOR_EMAILS` env var --
 * no `roles`/`organizations` table, no new migration. Same "don't stand up
 * infra a single-operator platform hasn't earned yet" call this codebase
 * already makes for BullMQ/Redis (§4.4), Kafka (§1), and the channel/
 * carrier flags this console exists to toggle (§15/§19.8).
 *
 * An empty/unset allowlist fails closed (parseOperatorAllowlist returns an
 * empty Set, matching nothing) rather than defaulting to "anyone" or
 * silently disabling the check -- same "deliberately narrow" posture
 * channel/carrier flags themselves already take.
 */

/** Comma-parse, trim, lowercase, drop empty entries -- pure, no DB/network,
 *  so it's unit-tested directly (see test/platform-operator.test.ts), same
 *  "extract the pure decision, test it directly" precedent channel-flags.ts's
 *  own filterKnownChannels/carrier-flags.ts's own filterKnownCarriers set. */
export function parseOperatorAllowlist(raw: string | undefined | null): Set<string> {
  if (!raw) {
    return new Set();
  }
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
}

/** Case-insensitive membership check against an already-parsed allowlist. */
export function isPlatformOperatorEmail(email: string, allowlist: Set<string>): boolean {
  return allowlist.has(email.trim().toLowerCase());
}

export interface PlatformOperator {
  id: string;
  email: string;
  tenantId: string;
}

/**
 * Looks up the signed-in Clerk user's own `users` row (via withClerkUser,
 * same self-lookup RLS path resolveCurrentUser/resolveTenantId already use
 * in with-tenant-auth.ts) and checks their email against
 * PLATFORM_OPERATOR_EMAILS. Returns null for "not signed in" (no matching
 * users row) and for "signed in, but not an operator" alike -- callers
 * (the /admin page, requirePlatformOperatorFromRequest below) redirect
 * either case the same way, so there's no separate "isOperator: false" case
 * worth distinguishing here.
 */
export async function requirePlatformOperator(pool: Pool, clerkUserId: string): Promise<PlatformOperator | null> {
  const allowlist = parseOperatorAllowlist(process.env.PLATFORM_OPERATOR_EMAILS);
  if (allowlist.size === 0) {
    return null;
  }

  return withClerkUser(pool, clerkUserId, async (client) => {
    const result = await client.query<{ id: string; email: string; tenant_id: string }>(
      "SELECT id, email, tenant_id FROM users WHERE clerk_user_id = $1",
      [clerkUserId],
    );
    const row = result.rows[0];
    if (!row || !isPlatformOperatorEmail(row.email, allowlist)) {
      return null;
    }
    return { id: row.id, email: row.email, tenantId: row.tenant_id };
  });
}

/** Route-Handler convenience mirroring requireCurrentUser's own shape in
 *  with-tenant-auth.ts -- resolves the caller via getAuthContext first,
 *  then delegates to requirePlatformOperator. */
export async function requirePlatformOperatorFromRequest(
  req: NextRequest,
  pool: Pool,
): Promise<PlatformOperator | null> {
  const authContext = await getAuthContext(req.headers);
  if (!authContext) {
    return null;
  }
  return requirePlatformOperator(pool, authContext.clerkUserId);
}
