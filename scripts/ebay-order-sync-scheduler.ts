import "dotenv/config";
import { createAppPool } from "../packages/db/src/index.js";
import { startEbayOrderSyncScheduler } from "../packages/scheduler/src/index.js";

// eBay counterpart to scripts/walmart-order-sync-scheduler.ts -- the
// long-running trigger for the eBay order-sync job. Same node-cron
// in-process approach and same caveats (no Redis/BullMQ, no Dockerfile/
// Terraform/CI-CD deploy step yet) -- see that file's header comment.
//
// Run this as its own long-running process, independent of the other three
// channels' schedulers (`npm run ebay:order-sync-scheduler` locally) -- all
// four channels' schedulers are deliberately separate processes/node-cron
// tasks so any one can run, restart, or have its cadence tuned without
// touching the others.
//
// UNVERIFIED IN PRACTICE, more so even than Walmart's own wiring -- see
// api/cron/ebay-order-sync/route.ts's doc comment.
//
// Configurable via env, both optional:
//   EBAY_ORDER_SYNC_CRON      -- cron expression (default: every 5 minutes)
//   EBAY_ORDER_SYNC_TIMEZONE  -- IANA timezone (default: system timezone)

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  }
  return value;
}

function main(): void {
  const appPool = createAppPool({ connectionString: readRequiredEnv("APP_DATABASE_URL") });
  const adminPool = createAppPool({ connectionString: readRequiredEnv("DATABASE_URL") });

  const task = startEbayOrderSyncScheduler({
    appPool,
    adminPool,
    cronExpression: process.env.EBAY_ORDER_SYNC_CRON,
    timezone: process.env.EBAY_ORDER_SYNC_TIMEZONE,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ event: "ebay_order_sync_scheduler_stopping", signal, at: new Date().toISOString() }));
    await task.stop();
    await appPool.end();
    await adminPool.end();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main();
