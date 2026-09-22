// Pure-logic coverage for src/lib/tiktok-oauth-pending.ts -- no DB, no
// network. Mirrors tiktok-oauth-state.test.ts's own shape (itself a mirror
// of amazon-oauth-state.test.ts), extended with a few cases specific to
// this token's richer payload (the shop list, the "encrypted secrets are
// opaque strings here, never decrypted by this module" boundary).
//
// Run with: npm run test:tiktok-oauth-pending --workspace=@alltix/web

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.TIKTOK_OAUTH_PENDING_SECRET ??= "test-only-pending-secret-do-not-use-in-prod";

let createPendingTikTokConnectionToken: typeof import("../src/lib/tiktok-oauth-pending.js").createPendingTikTokConnectionToken;
let verifyPendingTikTokConnectionToken: typeof import("../src/lib/tiktok-oauth-pending.js").verifyPendingTikTokConnectionToken;

before(async () => {
  ({ createPendingTikTokConnectionToken, verifyPendingTikTokConnectionToken } = await import(
    "../src/lib/tiktok-oauth-pending.js"
  ));
});

function samplePayload(overrides: Partial<Parameters<typeof createPendingTikTokConnectionToken>[0]> = {}) {
  return {
    tenantId: randomUUID(),
    appKey: "app-key",
    encryptedAppSecret: "ZmFrZS1lbmNyeXB0ZWQtc2VjcmV0", // opaque base64 -- this module never decrypts it
    encryptedAccessToken: "ZmFrZS1lbmNyeXB0ZWQtYWNjZXNz",
    encryptedRefreshToken: "ZmFrZS1lbmNyeXB0ZWQtcmVmcmVzaA==",
    shops: [
      { cipher: "shop-cipher-1", name: "Shop One", region: "US" },
      { cipher: "shop-cipher-2" },
    ],
    ...overrides,
  };
}

test("a freshly created token round-trips to the exact data it was created with", () => {
  const data = samplePayload();
  const token = createPendingTikTokConnectionToken(data);
  assert.deepEqual(verifyPendingTikTokConnectionToken(token), data);
});

test("two tokens for the same data are not identical (nonce prevents replay-by-inspection)", () => {
  const data = samplePayload();
  assert.notEqual(createPendingTikTokConnectionToken(data), createPendingTikTokConnectionToken(data));
});

test("a token with a tampered payload is rejected", () => {
  const token = createPendingTikTokConnectionToken(samplePayload());
  const [, signature] = token.split(".");
  const forgedPayload = Buffer.from(
    JSON.stringify({ ...samplePayload(), nonce: "x", exp: Date.now() + 60_000 }),
  ).toString("base64url");
  assert.equal(verifyPendingTikTokConnectionToken(`${forgedPayload}.${signature}`), null);
});

test("a token with a tampered signature is rejected", () => {
  const token = createPendingTikTokConnectionToken(samplePayload());
  const [encodedPayload] = token.split(".");
  assert.equal(verifyPendingTikTokConnectionToken(`${encodedPayload}.not-the-real-signature`), null);
});

test("an expired token is rejected even with a valid signature", () => {
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() - 11 * 60 * 1000; // 11 minutes in the past -- past the 10-minute TTL
    const token = createPendingTikTokConnectionToken(samplePayload());
    Date.now = originalNow;
    assert.equal(verifyPendingTikTokConnectionToken(token), null);
  } finally {
    Date.now = originalNow;
  }
});

test("garbage input is rejected without throwing", () => {
  assert.equal(verifyPendingTikTokConnectionToken(""), null);
  assert.equal(verifyPendingTikTokConnectionToken("not-a-token"), null);
  assert.equal(verifyPendingTikTokConnectionToken("..."), null);
});

test("a token signed with a different secret is rejected", () => {
  const token = createPendingTikTokConnectionToken(samplePayload());

  const originalSecret = process.env.TIKTOK_OAUTH_PENDING_SECRET;
  process.env.TIKTOK_OAUTH_PENDING_SECRET = "a-different-secret";
  try {
    assert.equal(verifyPendingTikTokConnectionToken(token), null);
  } finally {
    process.env.TIKTOK_OAUTH_PENDING_SECRET = originalSecret;
  }
});

test("the carried secrets are opaque strings, never decrypted or inspected by this module", () => {
  const data = samplePayload();
  const token = createPendingTikTokConnectionToken(data);
  const verified = verifyPendingTikTokConnectionToken(token);
  assert.equal(verified?.encryptedAppSecret, data.encryptedAppSecret);
  assert.equal(verified?.encryptedAccessToken, data.encryptedAccessToken);
  assert.equal(verified?.encryptedRefreshToken, data.encryptedRefreshToken);
});

test("the shop list round-trips in full, including a shop with no name/region", () => {
  const data = samplePayload();
  const token = createPendingTikTokConnectionToken(data);
  assert.deepEqual(verifyPendingTikTokConnectionToken(token)?.shops, data.shops);
});
