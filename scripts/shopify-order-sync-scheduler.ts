import "dotenv/config";
import { createAppPool } from "../packages/db/src/index.js";
import { startShopifyOrderSyncScheduler } from "../packages/scheduler/src/index.js";
import { initObservability } from "../packages/shared/src/index.js";

// Shopify counterpart to scripts/amazon-order-sync-scheduler.ts -- the
// long-running trigger for the Shopify order-sync job. Same node-cron
// in-process approach and same caveats (no Redis/BullMQ, no Dockerfile/
// Terraform/CI-CD deploy step yet) -- see that file's header comment.
//
// Run this as its own long-running process, independent of
// amazon-order-sync-scheduler.ts (`npm run shopify:order-sync-scheduler`
// locally) -- the two channels' schedulers are deliberately separate
// processes/node-cron tasks so either can run, restart, or have its
// cadence tuned without touching the other.
//
// Configurable via env, both optional:
//   SHOPIFY_ORDER_SYNC_CRON      -- cron expression (default: every 5 minutes)
//   SHOPIFY_ORDER_SYNC_TIMEZONE  -- IANA timezone (default: system timezone)

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  }
  return value;
}

function main(): void {
  initObservability("scheduler:shopify");
  const appPool = createAppPool({ connectionString: readRequiredEnv("APP_DATABASE_URL") });
  const adminPool = createAppPool({ connectionString: readRequiredEnv("DATABASE_URL") });

  const task = startShopifyOrderSyncScheduler({
    appPool,
    adminPool,
    cronExpression: process.env.SHOPIFY_ORDER_SYNC_CRON,
    timezone: process.env.SHOPIFY_ORDER_SYNC_TIMEZONE,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ event: "shopify_order_sync_scheduler_stopping", signal, at: new Date().toISOString() }));
    await task.stop();
    await appPool.end();
    await adminPool.end();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main();
