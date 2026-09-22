import type { NextRequest } from "next/server";
import { withTenant, recordAuditEvent } from "@alltix/db";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError } from "@/lib/route-helpers";
import { parseReorderThresholdDays } from "@/lib/reorder-threshold";

export const dynamic = "force-dynamic";

/**
 * POST /api/inventory/reorder-threshold -- the /inventory page's "Reorder
 * threshold" settings form. Updates `tenants.reorder_threshold_days`
 * (migration 0031), the value `/inventory` and `/reports` both now pass
 * into @alltix/inventory-service's `assessStockForecast()` instead of its
 * own hardcoded `DEFAULT_REORDER_THRESHOLD_DAYS`, closing the gap that
 * constant's own doc comment already flagged as open.
 *
 * Same plain-form-POST-then-redirect-with-?error= shape as every other
 * page-driven mutation in this app (e.g. ../transfer/route.ts right next to
 * this one) -- no client JS, per CLAUDE.md's Next.js conventions.
 * `parseReorderThresholdDays()` is the same validation
 * migrations/0031_tenants_reorder_threshold_days.sql's own CHECK constraint
 * mirrors -- a value this route would reject can never reach the DB layer
 * to test that constraint at all, so it's genuinely defense-in-depth, not
 * dead code.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireCurrentUser(req, getAppPool());
  if (!user) {
    return redirectWithError(req, "/inventory", "not signed in");
  }

  const formData = await req.formData();
  const raw = String(formData.get("reorderThresholdDays") ?? "");
  const parsed = parseReorderThresholdDays(raw);
  if (parsed === null) {
    return redirectWithError(req, "/inventory", "inventory_reorder_threshold_invalid");
  }

  await withTenant(getAppPool(), user.tenantId, async (client) => {
    await client.query(`UPDATE tenants SET reorder_threshold_days = $1, updated_at = now() WHERE id = $2`, [parsed, user.tenantId]);
    // Same transaction as the UPDATE above -- see recordAuditEvent's own
    // doc comment for why that matters.
    await recordAuditEvent(client, {
      tenantId: user.tenantId,
      userId: user.id,
      action: "settings.reorder_threshold_changed",
      entityType: "tenant",
      entityId: user.tenantId,
      details: { reorderThresholdDays: parsed },
    });
  });

  return redirectTo(req, "/inventory?reorderThresholdUpdated=1");
}
