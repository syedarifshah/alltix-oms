import type { EbayOAuthAppConfig } from "@alltix/channel-connectors";

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  }
  return value;
}

/**
 * Reads this app's eBay OAuth application config (client_id, client_secret,
 * RuName). Mirrors readAmazonOAuthAppConfig() exactly, minus
 * applicationId -- eBay has no separate SP-API-style "application_id"
 * distinct from client_id the way Amazon does; the client_id itself is
 * both the OAuth credential and the value passed on the authorize URL. All
 * three env vars below are unset in this repo today (see .env.example)
 * because there is no registered eBay application yet -- this throws a
 * clear "missing env var" error rather than silently no-op'ing, the same
 * honest-failure behavior readAmazonOAuthAppConfig() already established:
 * /api/channels/ebay/connect fails loudly instead of redirecting somewhere
 * broken.
 */
export function readEbayOAuthAppConfig(): EbayOAuthAppConfig {
  return {
    clientId: readRequiredEnv("EBAY_OAUTH_CLIENT_ID"),
    clientSecret: readRequiredEnv("EBAY_OAUTH_CLIENT_SECRET"),
    redirectUri: readRequiredEnv("EBAY_OAUTH_REDIRECT_URI"),
  };
}

/** Whether to send the tenant to eBay's sandbox consent screen/token host
 *  rather than production -- unlike Amazon's AMAZON_APP_DRAFT (a property
 *  of the registered application itself), eBay sandbox vs. production is
 *  purely a "which keyset/host" choice, so this defaults to false
 *  (production) rather than true -- there's no safer-by-default "Draft"
 *  state to mirror the way Amazon's does. */
export function isEbayOAuthSandbox(): boolean {
  return process.env.EBAY_OAUTH_SANDBOX === "true";
}
