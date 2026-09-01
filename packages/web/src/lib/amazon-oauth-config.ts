import type { AmazonOAuthAppConfig } from "@alltix/channel-connectors";

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  }
  return value;
}

/**
 * Reads this app's SP-API OAuth application config (application_id, LWA
 * client_id/secret, redirect_uri). Every one of these env vars is unset in
 * this repo today (see .env.example) because there is no Public SP-API
 * application registered yet -- see the header comment in
 * packages/channel-connectors/src/amazon-oauth.ts for why. This throws a
 * clear "missing env var" error rather than silently no-op'ing, which is
 * the honest behavior until that app exists: /api/channels/amazon/connect
 * fails loudly instead of redirecting somewhere broken.
 */
export function readAmazonOAuthAppConfig(): AmazonOAuthAppConfig {
  return {
    applicationId: readRequiredEnv("AMAZON_APP_ID"),
    clientId: readRequiredEnv("AMAZON_OAUTH_CLIENT_ID"),
    clientSecret: readRequiredEnv("AMAZON_OAUTH_CLIENT_SECRET"),
    redirectUri: readRequiredEnv("AMAZON_OAUTH_REDIRECT_URI"),
  };
}

/** Whether AMAZON_APP_ID currently refers to a Draft-status application (default true -- see .env.example). */
export function isAmazonOAuthAppDraft(): boolean {
  return process.env.AMAZON_APP_DRAFT !== "false";
}
