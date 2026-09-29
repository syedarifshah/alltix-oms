import type { NextRequest } from "next/server";
import { withTenant, recordAuditEvent } from "@alltix/db";
import { getAppPool } from "@/lib/db";
import { requirePlatformOperatorFromRequest } from "@/lib/platform-operator";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";
import { checkRateLimit, RATE_LIMIT_ERROR_MESSAGE } from "@/lib/rate-limit";
import { filterKnownCarriers } from "@/lib/carrier-flags";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/tenants/[id]/carrier-flags -- the carrier-layer twin of
 * ./channel-flags/route.ts (see that route's own doc comment for the full
 * reasoning, which this mirrors line for line): the UI equivalent of
 * `npm run platform:set-carrier-flags` (scripts/set-carrier-flags.ts),
 * closing CLAUDE.md §19.8's own "No operator UI" gap the same way
 * channel-flags/route.ts closed §12's. Gated by
 * {@link requirePlatformOperatorFromRequest}, not requireCurrentUser/
 * withTenantAuth -- same "the one place a signed-in user mutates a tenant
 * other than their own" exception.
 *
 * REPLACES the tenant's enabled-carriers list wholesale, same contract
 * set-carrier-flags.ts's own header comment documents. Uses the ordinary
 * `app_user` pool + withTenant(pool, targetTenantId, ...), not
 * getAdminPool() -- the target tenant id is already known from the URL,
 * same reasoning as the channel-flags route.
 *
 * `details.changedByOperatorEmail` exists for the identical RLS reason
 * documented at length on channel-flags/route.ts -- see that route's own
 * comment for the full trace (found and fixed via a real smoke test against
 * seeded Postgres, not assumed).
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const pool = getAppPool();
  const operator = await requirePlatformOperatorFromRequest(req, pool);
  if (!operator) {
    return redirectWithError(req, "/admin", "not_authorized");
  }

  // Rate-limited against the OPERATOR's own tenant, same reasoning as
  // channel-flags/route.ts.
  if (await checkRateLimit(pool, operator.tenantId, "admin.tenants.carrier_flags")) {
    return redirectWithError(req, "/admin", RATE_LIMIT_ERROR_MESSAGE);
  }

  const { id: targetTenantId } = await ctx.params;
  const formData = await req.formData();
  const selected = filterKnownCarriers(formData.getAll("carriers").map(String));

  try {
    await withTenant(pool, targetTenantId, async (client) => {
      const result = await client.query("UPDATE tenants SET enabled_carriers = $2 WHERE id = $1", [
        targetTenantId,
        selected,
      ]);
      if (result.rowCount === 0) {
        throw new Error("tenant_not_found");
      }
      // Same transaction as the UPDATE above; same RLS-caused NULL
      // actor_email issue documented at length in
      // ./channel-flags/route.ts's own doc comment -- changedByOperatorEmail
      // is the fallback /settings/activity's resolveActorDisplay() reads.
      await recordAuditEvent(client, {
        tenantId: targetTenantId,
        userId: operator.id,
        action: "settings.carrier_flags_changed",
        entityType: "tenant",
        entityId: targetTenantId,
        details: { enabledCarriers: selected, changedByOperatorEmail: operator.email },
      });
    });
  } catch (err) {
    return redirectWithError(req, "/admin", `carrier_flags_update_failed:${errorMessage(err)}`);
  }

  return redirectTo(req, "/admin?updated=carriers");
}
