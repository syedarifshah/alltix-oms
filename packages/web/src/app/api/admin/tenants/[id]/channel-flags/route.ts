import type { NextRequest } from "next/server";
import { withTenant, recordAuditEvent } from "@alltix/db";
import { getAppPool } from "@/lib/db";
import { requirePlatformOperatorFromRequest } from "@/lib/platform-operator";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";
import { checkRateLimit, RATE_LIMIT_ERROR_MESSAGE } from "@/lib/rate-limit";
import { filterKnownChannels } from "@/lib/channel-flags";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/tenants/[id]/channel-flags -- the UI equivalent of
 * `npm run platform:set-channel-flags` (scripts/set-channel-flags.ts),
 * closing CLAUDE.md §12's own "No operator UI for channel flags" gap.
 * Gated by {@link requirePlatformOperatorFromRequest}, not
 * requireCurrentUser/withTenantAuth -- this is the one place in the app a
 * signed-in user is allowed to mutate a TENANT OTHER THAN THEIR OWN
 * (`[id]` is the target tenant, resolved from the /admin page's own form,
 * not from the caller's session).
 *
 * Same "REPLACES the tenant's enabled list wholesale, pass every channel
 * that should stay enabled" contract set-channel-flags.ts's own header
 * comment documents -- the /admin page's own checkbox form always submits
 * every checked channel, so a plain "toggle one off" click from that page
 * still round-trips correctly; this route has no notion of an
 * add/remove diff.
 *
 * Deliberately uses the ordinary `app_user` pool + withTenant(pool,
 * targetTenantId, ...) -- exactly like set-channel-flags.ts's own
 * setChannelFlags(), not getAdminPool() -- because the target tenant id is
 * already known (from the URL param, chosen on /admin from a cross-tenant
 * LIST that itself needed getAdminPool(), see that page's own doc comment)
 * rather than being discovered here. Only a genuinely cross-tenant
 * ENUMERATION needs the admin pool; a mutation against one already-known
 * tenant id is a completely ordinary withTenant() call, same reasoning
 * lib/db.ts's own getAdminPool() doc comment gives for "every subsequent
 * per-tenant operation still goes through getAppPool() via withTenant()".
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const pool = getAppPool();
  const operator = await requirePlatformOperatorFromRequest(req, pool);
  if (!operator) {
    return redirectWithError(req, "/admin", "not_authorized");
  }

  // Rate-limited against the OPERATOR's own tenant, not the target tenant
  // -- this route's caller is always the operator acting from their own
  // session, same "the acting party's own budget, not the affected
  // resource's" reasoning every other rate-limited route in this app
  // already applies (e.g. inventory.transfer is limited per the tenant
  // making the transfer, not per location).
  if (await checkRateLimit(pool, operator.tenantId, "admin.tenants.channel_flags")) {
    return redirectWithError(req, "/admin", RATE_LIMIT_ERROR_MESSAGE);
  }

  const { id: targetTenantId } = await ctx.params;
  const formData = await req.formData();
  const selected = filterKnownChannels(formData.getAll("channels").map(String));

  try {
    await withTenant(pool, targetTenantId, async (client) => {
      const result = await client.query("UPDATE tenants SET enabled_channels = $2 WHERE id = $1", [
        targetTenantId,
        selected,
      ]);
      if (result.rowCount === 0) {
        throw new Error("tenant_not_found");
      }
      // Same transaction as the UPDATE above -- see recordAuditEvent's own
      // doc comment for why that matters. userId is the OPERATOR's own
      // users.id (from their own tenant, not the target's) -- audit_log.
      // user_id has no same-tenant FK constraint (a plain FK to users(id)
      // only, see migration 0034's own schema comment), so this write
      // itself is schema-legal and the row is stored correctly.
      //
      // BUT: the target tenant's own /settings/activity page reads this
      // back via a `LEFT JOIN users` executed under THAT tenant's own
      // `app.tenant_id` (withTenant(pool, tenantId, ...)) -- and `users`
      // carries a real, tenant-scoped RLS policy
      // (tenant_scoped_select_users, migration 0030/0035) on top of the
      // self-lookup one. That policy means the join can only ever resolve
      // a users row whose OWN tenant_id matches the reading tenant's
      // app.tenant_id -- so for a cross-tenant actor like this one (the
      // operator's users row lives in the OPERATOR's tenant, not this
      // target tenant), the join is silently RLS-filtered to no match and
      // `actor_email` comes back NULL, not the operator's real email.
      // (Confirmed directly, not assumed: a smoke test exercising this
      // exact call shape against real seeded Postgres reproduced it.)
      //
      // `details.changedByOperatorEmail` below exists specifically to
      // survive that -- it's written in the SAME row, so it's visible
      // regardless of which tenant's own RLS context later reads it back.
      // /settings/activity's own page falls back to this field when
      // `actor_email` is NULL (see that page's own doc comment) rather
      // than rendering a plain "system (operator script)" for what was
      // actually a real, signed-in human platform operator.
      await recordAuditEvent(client, {
        tenantId: targetTenantId,
        userId: operator.id,
        action: "settings.channel_flags_changed",
        entityType: "tenant",
        entityId: targetTenantId,
        details: { enabledChannels: selected, changedByOperatorEmail: operator.email },
      });
    });
  } catch (err) {
    return redirectWithError(req, "/admin", `channel_flags_update_failed:${errorMessage(err)}`);
  }

  return redirectTo(req, "/admin?updated=channels");
}
