import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";

// Signed, expiring, tenant-bound CSRF token for the eBay "Connect" redirect
// flow -- same shape and reasoning as amazon-oauth-state.ts (CLAUDE.md §6:
// application-layer defense-in-depth, never rely on eBay's own `state` echo
// alone). Forked into its own module/secret rather than reusing
// amazon-oauth-state.ts directly, same "not enough shared shape yet, each
// channel wants its own distinguishable secret" reasoning
// packages/scheduler's per-channel sync functions already use -- rotating
// EBAY_OAUTH_STATE_SECRET should never require touching Amazon's flow or
// vice versa.

// No eBay-specific code exchange window was confirmed by any doc page
// fetched during this pass (unlike Amazon's documented 5-minute
// spapi_oauth_code / 10-minute round-trip window) -- 10 minutes is carried
// over from Amazon's own value as a reasonable, conservative default, not a
// confirmed eBay-specific figure.
const STATE_TTL_MS = 10 * 60 * 1000;

interface StatePayload {
  tenantId: string;
  nonce: string;
  exp: number; // ms epoch
}

function readStateSecret(): string {
  const value = process.env.EBAY_OAUTH_STATE_SECRET;
  if (!value) {
    throw new Error("Missing required environment variable: EBAY_OAUTH_STATE_SECRET (see .env.example)");
  }
  return value;
}

function sign(encodedPayload: string): string {
  return createHmac("sha256", readStateSecret()).update(encodedPayload).digest("base64url");
}

/** Builds a signed, expiring, tenant-bound state token to pass as the eBay authorize URL's `state` param. */
export function createOAuthState(tenantId: string): string {
  const payload: StatePayload = { tenantId, nonce: randomUUID(), exp: Date.now() + STATE_TTL_MS };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

/**
 * Verifies a state token from the callback: signature first (constant-time,
 * via timingSafeEqual), then expiry. Returns the bound tenant_id, or null if
 * the token is malformed, forged, or expired -- callers must treat null as
 * "reject the callback", never fall back to trusting the caller's current
 * session alone. Identical logic to amazon-oauth-state.ts's own
 * verifyOAuthState() -- kept as a literal duplicate rather than a shared
 * helper for the same reason the two modules exist separately at all (see
 * this file's header comment).
 */
export function verifyOAuthState(state: string): string | null {
  const dotIndex = state.indexOf(".");
  if (dotIndex < 0) {
    return null;
  }
  const encodedPayload = state.slice(0, dotIndex);
  const signature = state.slice(dotIndex + 1);

  const expected = Buffer.from(sign(encodedPayload));
  const provided = Buffer.from(signature);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }

  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as StatePayload;
  } catch {
    return null;
  }

  if (typeof payload.tenantId !== "string" || typeof payload.exp !== "number" || Date.now() > payload.exp) {
    return null;
  }
  return payload.tenantId;
}
