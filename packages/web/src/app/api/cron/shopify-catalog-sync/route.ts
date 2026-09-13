import { NextResponse, type NextRequest } from "next/server";
import { runShopifyCatalogSyncJob, type CatalogSyncResult } from "@alltix/scheduler";
import { getAppPool, getAdminPool } from "@/lib/db";

export const dynamic = "force-dynamic";
// Same 60s ceiling reasoning as the order-sync cron routes.
export const maxDuration = 60;

/**
 * GET /api/cron/shopify-catalog-sync -- the automatic counterpart to
 * scripts/add-channel-listing.ts's manual, one-SKU-at-a-time stopgap.
 * Pulls every connected tenant's full Shopify product catalog
 * (ShopifyConnector.pullProductCatalog) and upserts a products/
 * channel_listings row (plus a one-time baseline stock receipt) per SKU'd
 * variant, via packages/scheduler's syncShopifyCatalog -- see that file's
 * doc comment for the full idempotency contract, in particular why the
 * baseline-stock idempotency key intentionally matches
 * scripts/add-channel-listing.ts's own key prefix (a SKU onboarded by hand
 * is never re-baselined by this job).
 *
 * A separate route/cron entry from shopify-order-sync (not a shared
 * "?job=" query param) for the same reason the scheduler keeps the two
 * sync functions separate -- different operation, different failure shape,
 * independently inspectable in Vercel's dashboard and logs. Same
 * CRON_SECRET Bearer-token auth as every other /api/cron/* route.
 *
 * Safe to invoke more than once concurrently or in quick succession: the
 * product/channel_listings upserts key on their own UNIQUE constraints,
 * and the baseline-stock receipt is idempotent on (tenant, channel, sku) --
 * see syncShopifyCatalogForTenant's doc comment.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let results: CatalogSyncResult[];
  try {
    results = await runShopifyCatalogSyncJob(getAppPool(), getAdminPool());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Shopify catalog sync cron run failed before any tenant was synced:", message);
    return NextResponse.json({ error: "sync run failed", message }, { status: 500 });
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success);
  for (const failure of failed) {
    console.error(`Shopify catalog sync cron: tenant ${failure.tenantId} failed:`, failure.error);
  }

  return NextResponse.json({
    tenantsSynced: results.length,
    succeeded,
    failed: failed.length,
    variantsUpserted: results.reduce((sum, r) => sum + r.variantsUpserted, 0),
  });
}
