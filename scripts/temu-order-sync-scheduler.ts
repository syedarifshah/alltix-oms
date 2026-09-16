import "dotenv/config";
import { createAppPool } from "../packages/db/src/index.js";
import { startTemuOrderSyncScheduler } from "../packages/scheduler/src/index.js";
import { initObservability } from "../packages/shared/src/index.js";

// Temu counterpart to scripts/ebay-order-sync-scheduler.ts -- the
// long-running trigger for the Temu order-sync job. Same node-cron
// in-process approach and same caveats (no Redis/BullMQ, no Dockerfile/
// Terraform/CI-CD deploy step yet) -- see that file's header comment.
//
// Run this as its own long-running process, independent of the other four
// channels' schedulers (`npm run temu:order-sync-scheduler` locally) -- all
// five channels' schedulers are deliberately separate processes/node-cron
// tasks so any one can run, restart, or have its cadence tuned without
// touching the others.
//
// UNVERIFIED IN PRACTICE, more so than any other channel's scheduler --
// see TemuConnector's own class doc comment.
//
// Configurable via env, both optional:
//   TEMU_ORDER_SYNC_CRON      -- cron expression (default: every 5 minutes)
//   TEMU_ORDER_SYNC_TIMEZONE  -- IANA timezone (default: system timezone)

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  }
  return value;
}

function main(): void {
  initObservability("scheduler:temu");
  const appPool = createAppPool({ connectionString: readRequiredEnv("APP_DATABASE_URL") });
  const adminPool = createAppPool({ connectionString: readRequiredEnv("DATABASE_URL") });

  const task = startTemuOrderSyncScheduler({
    appPool,
    adminPool,
    cronExpression: process.env.TEMU_ORDER_SYNC_CRON,
    timezone: process.env.TEMU_ORDER_SYNC_TIMEZONE,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ event: "temu_order_sync_scheduler_stopping", signal, at: new Date().toISOString() }));
    await task.stop();
    await appPool.end();
    await adminPool.end();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main();
