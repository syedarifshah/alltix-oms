import "dotenv/config";
import { createAppPool } from "../packages/db/src/index.js";
import { startAmazonOrderSyncScheduler } from "../packages/scheduler/src/index.js";
import { initObservability } from "../packages/shared/src/index.js";

// The long-running trigger for the Amazon order-sync job -- closes the gap
// flagged in scripts/amazon-order-sync-job.ts and packages/scheduler/src/
// index.ts's own header comments: the job logic and its one-shot
// entrypoint have existed (proven against sandbox + real Postgres) with
// nothing invoking either on a cadence. Checked before writing this: no
// Redis/BullMQ anywhere in this repo, no Dockerfile/Terraform/CI-CD deploy
// step -- so there's no ECS scheduled task or EventBridge rule to hand this
// to yet, and node-cron (zero dependencies, in-process) is the right amount
// of infrastructure for that stage, not a workaround for a missing one.
//
// Run this as the single long-running process in whatever container/host
// runs it (`npm run amazon:order-sync-scheduler` locally, or as a
// container's sole CMD later). It never exits on its own -- node-cron's
// internal timer keeps the event loop alive -- until SIGINT/SIGTERM.
//
// Swapping to real ECS/EventBridge scheduling later means deleting this
// script and packages/scheduler/src/cron-runner.ts, and pointing the
// external scheduler at scripts/amazon-order-sync-job.ts (the existing
// one-shot entrypoint) directly -- the sync logic itself
// (runAmazonOrderSyncJob) doesn't change either way.
//
// Configurable via env, both optional:
//   AMAZON_ORDER_SYNC_CRON      -- cron expression (default: every 5 minutes)
//   AMAZON_ORDER_SYNC_TIMEZONE  -- IANA timezone (default: system timezone)

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  }
  return value;
}

function main(): void {
  initObservability("scheduler:amazon");
  const appPool = createAppPool({ connectionString: readRequiredEnv("APP_DATABASE_URL") });
  const adminPool = createAppPool({ connectionString: readRequiredEnv("DATABASE_URL") });

  const task = startAmazonOrderSyncScheduler({
    appPool,
    adminPool,
    cronExpression: process.env.AMAZON_ORDER_SYNC_CRON,
    timezone: process.env.AMAZON_ORDER_SYNC_TIMEZONE,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ event: "amazon_order_sync_scheduler_stopping", signal, at: new Date().toISOString() }));
    await task.stop();
    await appPool.end();
    await adminPool.end();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main();
