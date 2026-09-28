import "dotenv/config";
import { createAppPool } from "../packages/db/src/index.js";
import { rollupDailySales } from "../packages/scheduler/src/index.js";
import { initObservability, captureError, flushObservability } from "../packages/shared/src/index.js";

// One-time historical backfill for `daily_channel_sales_rollups`/
// `daily_product_sales_rollups` (migration 0045) -- without this, the day
// /reports switched its sales-by-channel/top-SKUs sections over to reading
// those tables (see that page's own doc comment) would have silently lost
// every existing tenant's pre-migration order history from both sections,
// since the nightly `/api/cron/sales-rollup` job only ever recomputes a
// trailing SALES_ROLLUP_RECOMPUTE_DAYS-day window
// (packages/scheduler/src/index.ts), never the full history on its own.
//
// This is exactly the same `rollupDailySales()` function the cron route
// calls -- the function itself doesn't know or care whether it's being
// asked to recompute the trailing 3 days or several years; this script's
// only job is to pass it a wide enough explicit `sinceDate` to cover
// everything. Safe to re-run: `rollupDailySales` is DELETE-then-INSERT per
// date range (see its own doc comment), so running this twice over the same
// range just recomputes identical numbers, never duplicates rows.
//
// Run with:
//   BACKFILL_SINCE_DATE=2024-01-01 npm run db:backfill-sales-rollups
//
// Optional:
//   BACKFILL_SINCE_DATE   -- UTC calendar date (YYYY-MM-DD) to backfill from,
//                            inclusive. Defaults to 2020-01-01 -- well before
//                            this platform's own existence, deliberately
//                            wide rather than trying to guess a tenant's real
//                            earliest order date; rollupDailySales' own
//                            query only ever produces rows for dates that
//                            genuinely have orders; empty leading years cost
//                            one cheap no-op query each, not a real problem.
//   BACKFILL_THROUGH_DATE -- UTC calendar date (YYYY-MM-DD), exclusive.
//                            Defaults to tomorrow (UTC), so "today so far"
//                            is included -- matches rollupDailySales' own
//                            default `throughDate` when none is given.

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  }
  return value;
}

function parseUtcDateOrDefault(raw: string | undefined, fallback: Date): Date {
  if (!raw) {
    return fallback;
  }
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date "${raw}" -- expected YYYY-MM-DD (UTC)`);
  }
  return parsed;
}

async function main(): Promise<void> {
  initObservability("scheduler:sales-rollup-backfill");

  const now = new Date();
  const defaultSince = new Date(Date.UTC(2020, 0, 1));
  const defaultThrough = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));

  const sinceDate = parseUtcDateOrDefault(process.env.BACKFILL_SINCE_DATE, defaultSince);
  const throughDate = parseUtcDateOrDefault(process.env.BACKFILL_THROUGH_DATE, defaultThrough);

  const adminPool = createAppPool({ connectionString: readRequiredEnv("DATABASE_URL") });

  try {
    console.log(
      `Backfilling daily sales rollups for [${sinceDate.toISOString().slice(0, 10)}, ` +
        `${throughDate.toISOString().slice(0, 10)}) ...`,
    );
    const result = await rollupDailySales(adminPool, { sinceDate, throughDate });
    console.log(
      `Done -- ${result.channelRowsWritten} channel row(s), ${result.productRowsWritten} product row(s) written ` +
        `(range: ${result.sinceDate} to ${result.throughDate}).`,
    );
  } finally {
    await adminPool.end();
  }
}

main().catch(async (err: unknown) => {
  console.error("Sales rollup backfill failed:", err instanceof Error ? err.message : err);
  captureError(err, { event: "sales_rollup_backfill_failed" });
  await flushObservability();
  process.exitCode = 1;
});
