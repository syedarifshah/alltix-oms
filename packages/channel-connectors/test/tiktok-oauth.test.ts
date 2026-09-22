// Covers tiktok-oauth.ts: the pure URL-building/parsing helpers (same
// no-network scope ebay-connector.test.ts's own buildEbayAuthorizeUrl/
// parseEbayOAuthCallback tests carry), PLUS fetch-intercepted coverage for
// exchangeTikTokAuthorizationCode()/getTikTokAuthorizedShops() -- neither of
// which has an eBay-side analog anywhere in this package (eBay's own
// exchangeEbayAuthorizationCode is untested). Added here anyway since the
// interception pattern is cheap and already established elsewhere in this
// codebase (rules-engine's webhook-integration.test.ts,
// billing-service's usage-reporter.test.ts).
//
// Run with: npm run test --workspace=@alltix/channel-connectors -- tiktok-oauth

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTikTokAuthorizeUrl,
  parseTikTokOAuthCallback,
  exchangeTikTokAuthorizationCode,
  getTikTokAuthorizedShops,
} from "../src/tiktok-oauth.js";

test("buildTikTokAuthorizeUrl targets the services.tiktokshop.com host", () => {
  const url = new URL(buildTikTokAuthorizeUrl("app-key", "state-token"));
  assert.equal(url.origin, "https://services.tiktokshop.com");
  assert.equal(url.pathname, "/open/authorize");
});

test("buildTikTokAuthorizeUrl includes app_key and state, and NO redirect_uri or scope", () => {
  const url = new URL(buildTikTokAuthorizeUrl("app-key", "state-token"));
  assert.equal(url.searchParams.get("app_key"), "app-key");
  assert.equal(url.searchParams.get("state"), "state-token");
  assert.equal(url.searchParams.get("redirect_uri"), null, "TikTok's callback URL is fixed in Partner Center, not passed here");
  assert.equal(url.searchParams.get("scope"), null);
});

test("parseTikTokOAuthCallback extracts code and state when both present", () => {
  const params = new URLSearchParams({ code: "auth-code-value", state: "state-token" });
  assert.deepEqual(parseTikTokOAuthCallback(params), { code: "auth-code-value", state: "state-token" });
});

test("parseTikTokOAuthCallback returns null when code is missing", () => {
  const params = new URLSearchParams({ state: "state-token" });
  assert.equal(parseTikTokOAuthCallback(params), null);
});

test("parseTikTokOAuthCallback returns null when state is missing", () => {
  const params = new URLSearchParams({ code: "auth-code-value" });
  assert.equal(parseTikTokOAuthCallback(params), null);
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("exchangeTikTokAuthorizationCode hits /api/v2/token/get with grant_type=authorized_code (not authorization_code) and no signing", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl: string | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requestedUrl = String(input);
    return jsonResponse(200, {
      code: 0,
      message: "success",
      data: { access_token: "fresh-access-token", refresh_token: "fresh-refresh-token", access_token_expire_in: 86400 },
    });
  }) as typeof fetch;

  try {
    const result = await exchangeTikTokAuthorizationCode("the-auth-code", { appKey: "app-key", appSecret: "app-secret" });
    assert.equal(result.accessToken, "fresh-access-token");
    assert.equal(result.refreshToken, "fresh-refresh-token");
    assert.ok(new Date(result.expiresAt).getTime() > Date.now());

    assert.ok(requestedUrl);
    const url = new URL(requestedUrl!);
    assert.equal(url.origin, "https://auth.tiktok-shops.com");
    assert.equal(url.pathname, "/api/v2/token/get");
    assert.equal(url.searchParams.get("app_key"), "app-key");
    assert.equal(url.searchParams.get("app_secret"), "app-secret");
    assert.equal(url.searchParams.get("auth_code"), "the-auth-code");
    assert.equal(url.searchParams.get("grant_type"), "authorized_code");
    assert.equal(url.searchParams.get("sign"), null, "the token exchange is an unsigned call, same as authenticate()'s own refresh");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exchangeTikTokAuthorizationCode falls back to a 7-day expiry when access_token_expire_in is absent", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    jsonResponse(200, { code: 0, data: { access_token: "a", refresh_token: "r" } })) as typeof fetch;

  try {
    const before = Date.now();
    const result = await exchangeTikTokAuthorizationCode("code", { appKey: "k", appSecret: "s" });
    const expiresInMs = new Date(result.expiresAt).getTime() - before;
    assert.ok(Math.abs(expiresInMs - 7 * 24 * 60 * 60 * 1000) < 5000, `expected ~7 days, got ${expiresInMs}ms`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exchangeTikTokAuthorizationCode throws on a non-zero code", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse(200, { code: 36004001, message: "invalid auth_code" })) as typeof fetch;

  try {
    await assert.rejects(
      () => exchangeTikTokAuthorizationCode("bad-code", { appKey: "k", appSecret: "s" }),
      /TikTok authorization-code exchange failed.*36004001.*invalid auth_code/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exchangeTikTokAuthorizationCode throws when the response is missing a refresh_token", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse(200, { code: 0, data: { access_token: "a" } })) as typeof fetch;

  try {
    await assert.rejects(() => exchangeTikTokAuthorizationCode("code", { appKey: "k", appSecret: "s" }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getTikTokAuthorizedShops hits the signed /authorization/202309/shops endpoint with no shop_cipher, and returns the shop list", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl: string | undefined;
  let requestedHeaders: HeadersInit | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestedUrl = String(input);
    requestedHeaders = init?.headers;
    return jsonResponse(200, {
      code: 0,
      data: { shops: [{ cipher: "shop-cipher-1", id: "1", name: "My Shop", region: "US" }] },
    });
  }) as typeof fetch;

  try {
    const shops = await getTikTokAuthorizedShops({ appKey: "app-key", appSecret: "app-secret", accessToken: "access-token" });
    assert.deepEqual(shops, [{ cipher: "shop-cipher-1", id: "1", name: "My Shop", region: "US" }]);

    assert.ok(requestedUrl);
    const url = new URL(requestedUrl!);
    assert.equal(url.origin, "https://open-api.tiktokglobalshop.com");
    assert.equal(url.pathname, "/authorization/202309/shops");
    assert.equal(url.searchParams.get("app_key"), "app-key");
    assert.ok(url.searchParams.get("timestamp"));
    assert.ok(url.searchParams.get("sign"));
    assert.equal(url.searchParams.get("shop_cipher"), null, "shop_cipher must never be signed/sent here -- it's what this call discovers");
    assert.equal(url.searchParams.get("access_token"), null, "the access token travels only in the header, never the query string");
    assert.deepEqual(requestedHeaders, { "x-tts-access-token": "access-token" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getTikTokAuthorizedShops returns an empty array when the tenant has authorized no shops", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse(200, { code: 0, data: { shops: [] } })) as typeof fetch;

  try {
    const shops = await getTikTokAuthorizedShops({ appKey: "k", appSecret: "s", accessToken: "t" });
    assert.deepEqual(shops, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getTikTokAuthorizedShops throws on a non-zero code", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse(200, { code: 10001, message: "invalid access_token" })) as typeof fetch;

  try {
    await assert.rejects(
      () => getTikTokAuthorizedShops({ appKey: "k", appSecret: "s", accessToken: "bad" }),
      /TikTok authorized-shops lookup failed.*10001.*invalid access_token/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
