// Pure-logic coverage for src/lib/tiktok-oauth-state.ts -- no DB, no
// network, no TikTok involved. Literal mirror of amazon-oauth-state.test.ts
// (itself the pattern ebay-oauth-state.ts's own module would use too, had
// one been written -- see that module's own header comment on why none
// exists yet). This is the one piece of the "Connect TikTok Shop via OAuth"
// flow that's actually fully verifiable in this repo today: everything past
// it needs a real code from TikTok's own consent screen, which is
// unreachable without a registered TikTok Shop Open Platform application
// (see tiktok-oauth.ts's own header comment).
//
// Run with: npm run test:tiktok-oauth-state --workspace=@alltix/web

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.TIKTOK_OAUTH_STATE_SECRET ??= "test-only-state-secret-do-not-use-in-prod";

let createOAuthState: typeof import("../src/lib/tiktok-oauth-state.js").createOAuthState;
let verifyOAuthState: typeof import("../src/lib/tiktok-oauth-state.js").verifyOAuthState;

before(async () => {
  // Imported after the env var above is set, since the module reads it lazily inside sign()/readStateSecret() -- not at import time -- but this keeps intent explicit regardless.
  ({ createOAuthState, verifyOAuthState } = await import("../src/lib/tiktok-oauth-state.js"));
});

test("a freshly created state round-trips to the tenant_id it was created for", () => {
  const tenantId = randomUUID();
  const state = createOAuthState(tenantId);
  assert.equal(verifyOAuthState(state), tenantId);
});

test("two states for the same tenant are not identical (nonce prevents replay-by-inspection)", () => {
  const tenantId = randomUUID();
  assert.notEqual(createOAuthState(tenantId), createOAuthState(tenantId));
});

test("a state with a tampered payload is rejected", () => {
  const state = createOAuthState(randomUUID());
  const [encodedPayload, signature] = state.split(".");
  const forgedPayload = Buffer.from(
    JSON.stringify({ tenantId: randomUUID(), nonce: "x", exp: Date.now() + 60_000 }),
  ).toString("base64url");
  assert.equal(verifyOAuthState(`${forgedPayload}.${signature}`), null);
  void encodedPayload;
});

test("a state with a tampered signature is rejected", () => {
  const state = createOAuthState(randomUUID());
  const [encodedPayload] = state.split(".");
  assert.equal(verifyOAuthState(`${encodedPayload}.not-the-real-signature`), null);
});

test("an expired state is rejected even with a valid signature", () => {
  const tenantId = randomUUID();
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() - 11 * 60 * 1000; // 11 minutes in the past -- past the 10-minute TTL
    const state = createOAuthState(tenantId);
    Date.now = originalNow;
    assert.equal(verifyOAuthState(state), null);
  } finally {
    Date.now = originalNow;
  }
});

test("garbage input is rejected without throwing", () => {
  assert.equal(verifyOAuthState(""), null);
  assert.equal(verifyOAuthState("not-a-state-token"), null);
  assert.equal(verifyOAuthState("..."), null);
});

test("a state signed with a different secret is rejected", () => {
  const tenantId = randomUUID();
  const state = createOAuthState(tenantId);

  const originalSecret = process.env.TIKTOK_OAUTH_STATE_SECRET;
  process.env.TIKTOK_OAUTH_STATE_SECRET = "a-different-secret";
  try {
    assert.equal(verifyOAuthState(state), null);
  } finally {
    process.env.TIKTOK_OAUTH_STATE_SECRET = originalSecret;
  }
});
