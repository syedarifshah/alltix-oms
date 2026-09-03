import "dotenv/config";
import { createAppPool } from "../packages/db/src/index.js";
import { runAmazonOrderSyncJob } from "../packages/scheduler/src/index.js";

// The directly-runnable entrypoint a real cron / ECS scheduled task /
// EventBridge rule would invoke on a cadence -- see
// packages/scheduler/src/index.ts's header comment for why this is a plain
// scheduled poller rather than a BullMQ-backed queue, and for the RLS
// exception adminPool represents. Provisioning an actual recurring trigger
// (cron, ECS scheduled task, etc.) is separate, later infrastructure work;
// this script is the thing that trigger would run.
//
// Run with: npm run amazon:order-sync-job

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
    const results = await runAmazonOrderSyncJob(appPool, adminPool);

    if (results.length === 0) {
      console.log("No tenants with an active Amazon connection -- nothing to sync.");
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

    // Partial failure is expected/tolerated (see this pass's documented
    // no-cross-run-failure-tracking gap) -- only fail the whole run's exit
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
  console.error("Amazon order sync job crashed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
