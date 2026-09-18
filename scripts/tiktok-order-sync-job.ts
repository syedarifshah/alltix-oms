import "dotenv/config";
import { createAppPool } from "../packages/db/src/index.js";
import { runTikTokOrderSyncJob } from "../packages/scheduler/src/index.js";
import { initObservability, captureError, flushObservability } from "../packages/shared/src/index.js";

// TikTok Shop counterpart to scripts/temu-order-sync-job.ts -- same one-shot
// entrypoint shape a real cron / ECS scheduled task / EventBridge rule
// would invoke on a cadence. See that file's header comment and
// packages/scheduler/src/index.ts's for why this is a plain scheduled
// poller rather than a BullMQ-backed queue.
//
// UNVERIFIED IN PRACTICE, more so than any other channel's job script --
// see TikTokConnector's own class doc comment in
// packages/channel-connectors/src/tiktok-connector.ts.
//
// Run with: npm run tiktok:order-sync-job

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  }
  return value;
}

async function main(): Promise<void> {
  initObservability("scheduler:tiktok");
  const appPool = createAppPool({ connectionString: readRequiredEnv("APP_DATABASE_URL") });
  const adminPool = createAppPool({ connectionString: readRequiredEnv("DATABASE_URL") });

  try {
    const results = await runTikTokOrderSyncJob(appPool, adminPool);

    if (results.length === 0) {
      console.log("No tenants with an active TikTok Shop connection -- nothing to sync.");
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
    // other five channels' job scripts) -- only fail the whole run's exit
    // code if literally every tenant failed.
    if (!anySucceeded) {
      process.exitCode = 1;
    }
  } finally {
    await appPool.end();
    await adminPool.end();
  }
}

main().catch(async (err: unknown) => {
  console.error("TikTok Shop order sync job crashed:", err instanceof Error ? err.message : err);
  captureError(err, { event: "tiktok_order_sync_job_crashed" });
  await flushObservability();
  process.exitCode = 1;
});
