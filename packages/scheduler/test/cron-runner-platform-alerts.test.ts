// Proves cron-runner.ts's notifyPlatformOperator() -- the platform-operator
// half of the alerting work (packages/scheduler/src/index.ts's
// notifyTenantUsers() is the tenant half, covered by its own test file --
// see sync-failure-tracking.test.ts's new "notifies the tenant's own users"
// test). notifyPlatformOperator() itself isn't exported (it's a private
// helper inside cron-runner.ts, same as every runXOnceWithRetry function's
// own captureError() call site isn't independently testable either) -- this
// file drives it the only way it's reachable: through the exported
// runXOnceWithRetry functions, forcing the exact systemic failure their own
// header comments describe (a whole-call failure, not a single tenant's).
//
// No real Postgres needed, unlike every other scheduler test file: the
// forced failure happens at adminPool.query() itself (the tenant-enumeration
// query every syncXOrders() function calls first, before ever touching
// appPool -- confirmed by reading index.ts), so a fake adminPool whose
// query() rejects synchronously is a deterministic, network-free, DB-free
// way to reach the `!willRetry` branch every runXOnceWithRetry function
// shares. global.fetch is stubbed the same save/restore-in-`finally` way
// packages/shared/test/email.test.ts and packages/channel-connectors/test/
// retry.test.ts already established.
//
// Run with: npm run test --workspace=@alltix/scheduler -- cron-runner-platform-alerts

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import {
  runOnceWithRetry,
  runEbayOnceWithRetry,
} from "../src/cron-runner.js";

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = vars[key];
    }
  }
  return fn().finally(() => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });
}

/** A Pool stand-in whose query() rejects synchronously -- reaches
 *  runXOrderSyncJob's own `!willRetry` branch without ever touching real
 *  Postgres or the network. appPool is never actually queried on this path
 *  (adminPool.query() is the very first await in syncAmazonOrders() et al.),
 *  so it's left as an inert stand-in too. */
function failingAdminPool(message: string): Pool {
  return { query: () => Promise.reject(new Error(message)) } as unknown as Pool;
}

/** A Pool stand-in whose query() resolves with zero tenant rows -- a
 *  genuinely successful (if empty) run, for proving the success path never
 *  notifies. */
function emptyAdminPool(): Pool {
  return { query: () => Promise.resolve({ rows: [] }) } as unknown as Pool;
}

const inertAppPool = {} as unknown as Pool;

test("notifyPlatformOperator is a no-op (no fetch call) when PLATFORM_ALERT_EMAIL is unset, even with RESEND_API_KEY set", async () => {
  await withEnv({ RESEND_API_KEY: "re_test_key", PLATFORM_ALERT_EMAIL: undefined }, async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      await runOnceWithRetry(inertAppPool, failingAdminPool("simulated systemic failure"), 0, 0);
      assert.equal(callCount, 0, "no PLATFORM_ALERT_EMAIL means notifyPlatformOperator must never reach sendEmail's fetch");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("a systemic failure that exhausts every retry emails the platform operator with the expected shape", async () => {
  await withEnv({ RESEND_API_KEY: "re_test_key", PLATFORM_ALERT_EMAIL: "ops@example.test" }, async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      callCount++;
      capturedInit = init;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      // maxRetries=0 -- fails on attempt 1, immediately hits `!willRetry`
      // (attempt <= maxRetries is false), no sleep() delay to wait out.
      await runOnceWithRetry(inertAppPool, failingAdminPool("DB is down"), 0, 0);
      assert.equal(callCount, 1, "must notify exactly once, not once per attempt");

      const body = JSON.parse(capturedInit?.body as string) as { to: string[]; subject: string; text: string };
      assert.deepEqual(body.to, ["ops@example.test"]);
      assert.match(body.subject, /amazon order sync failed/);
      assert.match(body.text, /exhausted all 1 attempt\(s\)/);
      assert.match(body.text, /DB is down/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("a run that succeeds on the first attempt never notifies the platform operator", async () => {
  await withEnv({ RESEND_API_KEY: "re_test_key", PLATFORM_ALERT_EMAIL: "ops@example.test" }, async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      await runOnceWithRetry(inertAppPool, emptyAdminPool(), 2, 0);
      assert.equal(callCount, 0, "a successful run (even an empty one) must never call notifyPlatformOperator");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("a failure that succeeds on a retry within budget never notifies the platform operator", async () => {
  await withEnv({ RESEND_API_KEY: "re_test_key", PLATFORM_ALERT_EMAIL: "ops@example.test" }, async () => {
    const originalFetch = globalThis.fetch;
    let fetchCallCount = 0;
    globalThis.fetch = (async () => {
      fetchCallCount++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    let queryCallCount = 0;
    const flakyThenOkAdminPool = {
      query: () => {
        queryCallCount++;
        if (queryCallCount === 1) {
          return Promise.reject(new Error("transient failure"));
        }
        return Promise.resolve({ rows: [] });
      },
    } as unknown as Pool;

    try {
      // maxRetries=1, retryDelayMs=0 -- attempt 1 fails (willRetry=true,
      // still under budget), attempt 2 succeeds. notifyPlatformOperator must
      // never fire, since the run as a whole succeeded.
      await runOnceWithRetry(inertAppPool, flakyThenOkAdminPool, 1, 0);
      assert.equal(queryCallCount, 2, "sanity check: attempt 1 failed, attempt 2 ran");
      assert.equal(fetchCallCount, 0, "a run that recovers within its retry budget must never notify");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("the platform-alert wiring isn't Amazon-specific -- eBay's own counterpart notifies the same way", async () => {
  await withEnv({ RESEND_API_KEY: "re_test_key", PLATFORM_ALERT_EMAIL: "ops@example.test" }, async () => {
    const originalFetch = globalThis.fetch;
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      await runEbayOnceWithRetry(inertAppPool, failingAdminPool("eBay token exchange failed"), 0, 0);
      const body = JSON.parse(capturedInit?.body as string) as { subject: string; text: string };
      assert.match(body.subject, /ebay order sync failed/);
      assert.match(body.text, /eBay token exchange failed/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
