import "dotenv/config";
import { createAppPool } from "../packages/db/src/index.js";
import { runShopifyCatalogSyncJob } from "../packages/scheduler/src/index.js";
import { initObservability, captureError, flushObservability } from "../packages/shared/src/index.js";

// One-shot entrypoint for packages/scheduler's syncShopifyCatalog -- the
// automatic counterpart to scripts/add-channel-listing.ts's manual,
// one-SKU-at-a-time stopgap. See that function's own doc comment for the
// full idempotency contract. In production this runs via Vercel Cron
// (packages/web/src/app/api/cron/shopify-catalog-sync/route.ts +
// vercel.json's crons entry); this script is for a local/manual run, same
// role scripts/shopify-order-sync-job.ts plays for order sync.
//
// Run with: npm run shopify:catalog-sync-job

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  }
  return value;
}

async function main(): Promise<void> {
  initObservability("scheduler:shopify-catalog");
  const appPool = createAppPool({ connectionString: readRequiredEnv("APP_DATABASE_URL") });
  const adminPool = createAppPool({ connectionString: readRequiredEnv("DATABASE_URL") });

  try {
    const results = await runShopifyCatalogSyncJob(appPool, adminPool);

    if (results.length === 0) {
      console.log("No tenants with an active Shopify connection -- nothing to sync.");
      return;
    }

    let anySucceeded = false;
    for (const result of results) {
      if (result.success) {
        anySucceeded = true;
        console.log(`Tenant ${result.tenantId}: synced -- ${result.variantsUpserted} variant(s) upserted.`);
      } else {
        console.error(`Tenant ${result.tenantId}: catalog sync FAILED -- ${result.error}`);
      }
    }

    if (!anySucceeded) {
      process.exitCode = 1;
    }
  } finally {
    await appPool.end();
    await adminPool.end();
  }
}

main().catch(async (err: unknown) => {
  console.error("Shopify catalog sync job crashed:", err instanceof Error ? err.message : err);
  captureError(err, { event: "shopify_catalog_sync_job_crashed" });
  await flushObservability();
  process.exitCode = 1;
});
