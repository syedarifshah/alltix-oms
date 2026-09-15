import "dotenv/config";
import { createAppPool } from "../packages/db/src/index.js";
import { runEbayOrderSyncJob } from "../packages/scheduler/src/index.js";

// eBay counterpart to scripts/walmart-order-sync-job.ts -- same one-shot
// entrypoint shape a real cron / ECS scheduled task / EventBridge rule
// would invoke on a cadence. See that file's header comment and
// packages/scheduler/src/index.ts's for why this is a plain scheduled
// poller rather than a BullMQ-backed queue.
//
// UNVERIFIED IN PRACTICE, more so even than Walmart's own wiring -- see
// api/cron/ebay-order-sync/route.ts's doc comment.
//
// Run with: npm run ebay:order-sync-job

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  }
  return value;
}

async function main(): Promise<void> {
  const appPool = createAppPool({ connectionString: readRequiredEnv("APP_DATABASE_URL") });
  const adminPool = createAppPool({ connectionString: readRequiredEnv("DATABASE_URL") });

  try {
    const results = await runEbayOrderSyncJob(appPool, adminPool);

    if (results.length === 0) {
      console.log("No tenants with an active eBay connection -- nothing to sync.");
      return;
    }

    let anySucceeded = false;
    for (const result of results) {
      if (result.success) {
        anySucceeded = true;
        console.log(
          `Tenant ${result.tenantId}: synced -- ${result.insertedOrderIds.length} new order(s), ` +
            `${result.skippedExternalOrderIds.length} already-seen order(s) skipped.`,
        );
      } else {
        console.error(`Tenant ${result.tenantId}: sync FAILED -- ${result.error}`);
      }
    }

    // Partial failure is expected/tolerated (same documented gap as the
    // other three channels' job scripts) -- only fail the whole run's exit
    // code if literally every tenant failed.
    if (!anySucceeded) {
      process.exitCode = 1;
    }
  } finally {
    await appPool.end();
    await adminPool.end();
  }
}

main().catch((err: unknown) => {
  console.error("eBay order sync job crashed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
