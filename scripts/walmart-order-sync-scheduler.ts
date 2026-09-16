import "dotenv/config";
import { createAppPool } from "../packages/db/src/index.js";
import { startWalmartOrderSyncScheduler } from "../packages/scheduler/src/index.js";
import { initObservability } from "../packages/shared/src/index.js";

// Walmart counterpart to scripts/shopify-order-sync-scheduler.ts -- the
// long-running trigger for the Walmart order-sync job. Same node-cron
// in-process approach and same caveats (no Redis/BullMQ, no Dockerfile/
// Terraform/CI-CD deploy step yet) -- see that file's header comment.
//
// Run this as its own long-running process, independent of
// amazon-order-sync-scheduler.ts and shopify-order-sync-scheduler.ts
// (`npm run walmart:order-sync-scheduler` locally) -- all three channels'
// schedulers are deliberately separate processes/node-cron tasks so any one
// can run, restart, or have its cadence tuned without touching the others.
//
// UNVERIFIED IN PRACTICE along with the rest of the Walmart wiring -- see
// api/cron/walmart-order-sync/route.ts's doc comment.
//
// Configurable via env, both optional:
//   WALMART_ORDER_SYNC_CRON      -- cron expression (default: every 5 minutes)
//   WALMART_ORDER_SYNC_TIMEZONE  -- IANA timezone (default: system timezone)

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  }
  return value;
}

function main(): void {
  initObservability("scheduler:walmart");
  const appPool = createAppPool({ connectionString: readRequiredEnv("APP_DATABASE_URL") });
  const adminPool = createAppPool({ connectionString: readRequiredEnv("DATABASE_URL") });

  const task = startWalmartOrderSyncScheduler({
    appPool,
    adminPool,
    cronExpression: process.env.WALMART_ORDER_SYNC_CRON,
    timezone: process.env.WALMART_ORDER_SYNC_TIMEZONE,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ event: "walmart_order_sync_scheduler_stopping", signal, at: new Date().toISOString() }));
    await task.stop();
    await appPool.end();
    await adminPool.end();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main();
