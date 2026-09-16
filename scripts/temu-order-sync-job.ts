import "dotenv/config";
import { createAppPool } from "../packages/db/src/index.js";
import { runTemuOrderSyncJob } from "../packages/scheduler/src/index.js";
import { initObservability, captureError, flushObservability } from "../packages/shared/src/index.js";

// Temu counterpart to scripts/ebay-order-sync-job.ts -- same one-shot
// entrypoint shape a real cron / ECS scheduled task / EventBridge rule
// would invoke on a cadence. See that file's header comment and
// packages/scheduler/src/index.ts's for why this is a plain scheduled
// poller rather than a BullMQ-backed queue.
//
// UNVERIFIED IN PRACTICE, more so than any other channel's job script --
// see TemuConnector's own class doc comment in
// packages/channel-connectors/src/temu-connector.ts.
//
// Run with: npm run temu:order-sync-job

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  }
  return value;
}

async function main(): Promise<void> {
  initObservability("scheduler:temu");
  const appPool = createAppPool({ connectionString: readRequiredEnv("APP_DATABASE_URL") });
  const adminPool = createAppPool({ connectionString: readRequiredEnv("DATABASE_URL") });

  try {
    const results = await runTemuOrderSyncJob(appPool, adminPool);

    if (results.length === 0) {
      console.log("No tenants with an active Temu connection -- nothing to sync.");
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
    // other four channels' job scripts) -- only fail the whole run's exit
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
  console.error("Temu order sync job crashed:", err instanceof Error ? err.message : err);
  captureError(err, { event: "temu_order_sync_job_crashed" });
  await flushObservability();
  process.exitCode = 1;
});
