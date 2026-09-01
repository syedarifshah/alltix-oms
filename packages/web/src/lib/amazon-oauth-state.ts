import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";

// Signed, expiring, tenant-bound CSRF token for the Amazon "Connect" redirect
// flow (CLAUDE.md §6: application-layer defense-in-depth, never rely on
// Amazon's own `state` echo alone -- Amazon just reflects back whatever
// string it was given, it doesn't attest to who generated it). HMAC-SHA256
// over a base64url JSON payload, verified with a constant-time comparison so
// timing can't leak the correct signature.
//
// Deliberately a separate secret/module from packages/db/src/encryption.ts:
// that one encrypts long-lived secrets at rest with pgcrypto; this one signs
// a short-lived, non-secret token. Using a distinct
// AMAZON_OAUTH_STATE_SECRET means rotating one never requires touching the
// other.

// Amazon: exchange spapi_oauth_code within 5 min, whole authorize->callback
// round trip within 10 (see packages/channel-connectors/src/amazon-oauth.ts).
const STATE_TTL_MS = 10 * 60 * 1000;

interface StatePayload {
  tenantId: string;
  nonce: string;
  exp: number; // ms epoch
}

function readStateSecret(): string {
  const value = process.env.AMAZON_OAUTH_STATE_SECRET;
  if (!value) {
    throw new Error("Missing required environment variable: AMAZON_OAUTH_STATE_SECRET (see .env.example)");
  }
  return value;
}

function sign(encodedPayload: string): string {
  return createHmac("sha256", readStateSecret()).update(encodedPayload).digest("base64url");
}

/** Builds a signed, expiring, tenant-bound state token to pass as the Amazon authorize URL's `state` param. */
export function createOAuthState(tenantId: string): string {
  const payload: StatePayload = { tenantId, nonce: randomUUID(), exp: Date.now() + STATE_TTL_MS };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

/**
 * Verifies a state token from the callback: signature first (constant-time,
 * via timingSafeEqual), then expiry. Returns the bound tenant_id, or null if
 * the token is malformed, forged, or expired -- callers must treat null as
 * "reject the callback", never fall back to trusting selling_partner_id or
 * the caller's current session alone.
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
