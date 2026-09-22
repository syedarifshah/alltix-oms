import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import type { TikTokAuthorizedShop } from "@alltix/channel-connectors";

// Signed, expiring, tenant-bound token carrying a COMPLETED TikTok Shop OAuth
// exchange result across the extra redirect hop the multi-shop picker needs
// (CLAUDE.md's Known Follow-ups entry this closes: the callback used to
// connect only the FIRST shop an authorization returned; ../callback/route.ts
// now redirects to /settings/channels/tiktok-shops instead, whenever more
// than one shop comes back, so the tenant can choose).
//
// Structurally similar to tiktok-oauth-state.ts's own signed state token
// (same HMAC-signed, base64url-encoded-payload-plus-signature shape,
// timingSafeEqual verification, expiry), but a DIFFERENT secret
// (TIKTOK_OAUTH_STATE_SECRET is the one-time CSRF token for the FIRST
// redirect to TikTok; this is a second, later hop after TikTok's own part of
// the flow is already done) and carrying materially more -- the completed
// access/refresh token pair and app secret, not just a tenant id.
//
// Those three secrets travel through this token ALREADY ENCRYPTED (via
// @alltix/db's encryptChannelSecret, the exact same pgcrypto encryption
// channel_connections stores them under at rest -- see
// tiktok-connection.ts's own persistTikTokConnection, which decrypts them
// back with decryptChannelSecret once a shop is chosen) rather than in the
// clear the way a bare tenant_id is on the state token above. This token
// round-trips through the tenant's own browser (a redirect + a hidden form
// field) on its way to /api/channels/tiktok/select-shop -- the HMAC
// signature alone makes it tamper-evident, but tamper-evidence is not
// confidentiality, and an access/refresh token/app secret sitting in
// plaintext in a URL or hidden form field is a real exposure (browser
// history, referrer headers, proxy/server access logs) this codebase
// doesn't take for any other secret. Encrypting first, the same way these
// values will be stored at rest a few seconds later regardless of which
// shop gets picked, closes that gap without inventing a new key or a new
// piece of infrastructure (no new table, no session store) -- it reuses
// CHANNEL_CREDENTIALS_ENCRYPTION_KEY, already required for every other
// channel's stored secrets.
const PENDING_TTL_MS = 10 * 60 * 1000;

export interface PendingTikTokShopChoice {
  cipher: string;
  name?: string;
  region?: string;
}

export interface PendingTikTokConnection {
  tenantId: string;
  appKey: string;
  /** base64 of an @alltix/db encryptChannelSecret(...) Buffer -- never the
   *  plaintext app secret, see this file's header comment. */
  encryptedAppSecret: string;
  /** Same encoding as {@link encryptedAppSecret}. */
  encryptedAccessToken: string;
  /** Same encoding as {@link encryptedAppSecret}. */
  encryptedRefreshToken: string;
  /** Sanitized down to cipher/name/region -- deliberately not the full,
   *  unconfirmed-shape TikTokAuthorizedShop (see that type's own doc
   *  comment in tiktok-oauth.ts) passed through into a token the tenant's
   *  browser will hold onto for up to 10 minutes. */
  shops: PendingTikTokShopChoice[];
}

interface PendingPayload extends PendingTikTokConnection {
  nonce: string;
  exp: number; // ms epoch
}

function readPendingSecret(): string {
  const value = process.env.TIKTOK_OAUTH_PENDING_SECRET;
  if (!value) {
    throw new Error("Missing required environment variable: TIKTOK_OAUTH_PENDING_SECRET (see .env.example)");
  }
  return value;
}

function sign(encodedPayload: string): string {
  return createHmac("sha256", readPendingSecret()).update(encodedPayload).digest("base64url");
}

/** Builds a signed, expiring token carrying a completed TikTok OAuth
 *  exchange's result, for the "pick a shop" redirect hop. `shops` must have
 *  at least 2 entries in the only real caller (the callback route) -- a
 *  single shop is connected directly, without ever creating one of these
 *  (see ../callback's own doc comment) -- but this function itself doesn't
 *  enforce that; it's a plain data-carrying token, the caller decides when
 *  to use it. */
export function createPendingTikTokConnectionToken(data: PendingTikTokConnection): string {
  const payload: PendingPayload = { ...data, nonce: randomUUID(), exp: Date.now() + PENDING_TTL_MS };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

/**
 * Verifies a pending-connection token from the shop-picker page/its POST
 * target: signature first (constant-time), then expiry. Returns the carried
 * data (still holding ENCRYPTED secrets -- see this file's header comment;
 * callers must decrypt via @alltix/db's decryptChannelSecret before using
 * them), or null if the token is malformed, forged, or expired. Identical
 * verification logic to tiktok-oauth-state.ts's own verifyOAuthState() --
 * kept as its own copy rather than a shared helper for the same "each
 * token/secret pair rotates independently" reasoning that module's own
 * header comment gives for not sharing with ebay-oauth-state.ts/
 * amazon-oauth-state.ts.
 */
export function verifyPendingTikTokConnectionToken(token: string): PendingTikTokConnection | null {
  const dotIndex = token.indexOf(".");
  if (dotIndex < 0) {
    return null;
  }
  const encodedPayload = token.slice(0, dotIndex);
  const signature = token.slice(dotIndex + 1);

  const expected = Buffer.from(sign(encodedPayload));
  const provided = Buffer.from(signature);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }

  let payload: PendingPayload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as PendingPayload;
  } catch {
    return null;
  }

  if (
    typeof payload.tenantId !== "string" ||
    typeof payload.appKey !== "string" ||
    typeof payload.encryptedAppSecret !== "string" ||
    typeof payload.encryptedAccessToken !== "string" ||
    typeof payload.encryptedRefreshToken !== "string" ||
    !Array.isArray(payload.shops) ||
    typeof payload.exp !== "number" ||
    Date.now() > payload.exp
  ) {
    return null;
  }

  const { nonce: _nonce, exp: _exp, ...data } = payload;
  return data;
}
