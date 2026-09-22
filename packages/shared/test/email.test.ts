// Unit tests for sendEmail() -- no network, no real Resend account.
// global.fetch is stubbed per test (restored in a `finally`, same
// discipline packages/channel-connectors/test/retry.test.ts and
// ebay-connector.test.ts already established for this codebase). Also
// exercises RESEND_API_KEY/ALERT_FROM_EMAIL via process.env, saved and
// restored per test the same way, since sendEmail() reads them directly.
//
// Run with: npm run test --workspace=@alltix/shared

import { test } from "node:test";
import assert from "node:assert/strict";
import { sendEmail } from "../src/email.js";

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

test("sendEmail is a no-op (no network call) when RESEND_API_KEY is unset", async () => {
  await withEnv({ RESEND_API_KEY: undefined }, async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      const result = await sendEmail({ to: ["arif@example.test"], subject: "hi", text: "body" });
      assert.equal(result, false);
      assert.equal(callCount, 0, "sendEmail must not call fetch at all when unconfigured");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("sendEmail is a no-op when there are zero recipients, even if RESEND_API_KEY is set", async () => {
  await withEnv({ RESEND_API_KEY: "re_test_key" }, async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      const result = await sendEmail({ to: [], subject: "hi", text: "body" });
      assert.equal(result, false);
      assert.equal(callCount, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("sendEmail POSTs the expected request shape to Resend when configured", async () => {
  await withEnv({ RESEND_API_KEY: "re_test_key", ALERT_FROM_EMAIL: "Alerts <alerts@example.test>" }, async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      const result = await sendEmail({
        to: ["a@example.test", "b@example.test"],
        subject: "channel needs attention",
        text: "reconnect please",
      });
      assert.equal(result, true);
      assert.equal(capturedUrl, "https://api.resend.com/emails");
      assert.equal(capturedInit?.method, "POST");
      const headers = capturedInit?.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer re_test_key");
      assert.equal(headers["Content-Type"], "application/json");
      const body = JSON.parse(capturedInit?.body as string) as {
        from: string;
        to: string[];
        subject: string;
        text: string;
      };
      assert.deepEqual(body, {
        from: "Alerts <alerts@example.test>",
        to: ["a@example.test", "b@example.test"],
        subject: "channel needs attention",
        text: "reconnect please",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("sendEmail falls back to the Resend sandbox sender when no from address is configured", async () => {
  await withEnv({ RESEND_API_KEY: "re_test_key", ALERT_FROM_EMAIL: undefined }, async () => {
    const originalFetch = globalThis.fetch;
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      await sendEmail({ to: ["a@example.test"], subject: "hi", text: "body" });
      const body = JSON.parse(capturedInit?.body as string) as { from: string };
      assert.equal(body.from, "AlltixOMS <onboarding@resend.dev>");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("sendEmail returns false and swallows the error when Resend responds non-2xx", async () => {
  await withEnv({ RESEND_API_KEY: "re_test_key" }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("bad request", { status: 400 })) as typeof fetch;

    try {
      const result = await sendEmail({ to: ["a@example.test"], subject: "hi", text: "body" });
      assert.equal(result, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("sendEmail returns false and swallows a thrown network error, never throws", async () => {
  await withEnv({ RESEND_API_KEY: "re_test_key" }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("ECONNRESET");
    }) as typeof fetch;

    try {
      const result = await sendEmail({ to: ["a@example.test"], subject: "hi", text: "body" });
      assert.equal(result, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
