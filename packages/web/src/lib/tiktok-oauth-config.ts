import type { TikTokOAuthAppConfig } from "@alltix/channel-connectors";

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  }
  return value;
}

/**
 * Reads this app's TikTok Shop Open Platform app credentials (app_key,
 * app_secret) for the OAuth connect/callback flow
 * (tiktok-oauth.ts/`/api/channels/tiktok/{connect,callback}`). Deliberately
 * reuses the SAME TIKTOK_APP_KEY/TIKTOK_APP_SECRET env vars
 * loadTikTokCredentialsFromEnv() already reads in tiktok-connector.ts, NOT
 * a TIKTOK_OAUTH_-prefixed pair the way readEbayOAuthAppConfig() has its own
 * EBAY_OAUTH_CLIENT_ID/SECRET distinct from EBAY_SANDBOX_CLIENT_ID/SECRET --
 * eBay genuinely has two separate keysets (a self-authorization sandbox
 * keyset vs. a registered OAuth application), TikTok Shop Open Platform
 * does not: one app registration, one app_key/app_secret pair, used both
 * for the .env-driven direct-connector path (scheduler syncs, sandbox-style
 * scripts) and for this OAuth flow. Unset (as it is in this repo today --
 * see .env.example's TIKTOK_* entries) makes /api/channels/tiktok/connect
 * fail loudly with a clear "missing env var" error rather than redirecting
 * somewhere broken, same honest-failure behavior readEbayOAuthAppConfig()/
 * readAmazonOAuthAppConfig() already establish.
 */
export function readTikTokOAuthAppConfig(): TikTokOAuthAppConfig {
  return {
    appKey: readRequiredEnv("TIKTOK_APP_KEY"),
    appSecret: readRequiredEnv("TIKTOK_APP_SECRET"),
  };
}
