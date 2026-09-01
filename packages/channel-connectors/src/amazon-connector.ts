import type { AuthToken } from "./connector.js";

// SP-API auth has been LWA-only since Oct 2023 -- no AWS IAM/SigV4 signing
// required (CLAUDE.md §4.1). This is a smoke-test-only implementation:
// authenticate() plus one real sandbox call, to prove the credential chain
// works end to end before pullOrders/pushInventory/pushListing are built
// (CLAUDE.md §11.5: sandbox-first, one channel at a time).

const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";

// EU sandbox host, for a UK/EU seller account (CLAUDE.md §4.1 marketplace
// regions: NA/EU/FE each have their own SP-API host).
export const SP_API_EU_SANDBOX_BASE_URL = "https://sandbox.sellingpartnerapi-eu.amazon.com";

// Refresh ahead of actual expiry so an in-flight request never races a token
// that expires mid-call.
const TOKEN_REFRESH_SKEW_MS = 60_000;

export interface AmazonSandboxCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

export interface MarketplaceParticipation {
  marketplace: {
    id: string;
    countryCode: string;
    defaultCurrencyCode: string;
    defaultLanguageCode: string;
    domainName: string;
  };
  participation: {
    isParticipating: boolean;
    hasSuspendedListings: boolean;
  };
}

interface MarketplaceParticipationsResponse {
  payload?: MarketplaceParticipation[];
  errors?: Array<{ code: string; message: string; details?: string }>;
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name} (see .env.example)`,
    );
  }
  return value;
}

/** Reads the three AMAZON_SANDBOX_* keys from process.env, failing fast if any are missing. */
export function loadAmazonSandboxCredentialsFromEnv(): AmazonSandboxCredentials {
  return {
    clientId: readRequiredEnv("AMAZON_SANDBOX_CLIENT_ID"),
    clientSecret: readRequiredEnv("AMAZON_SANDBOX_CLIENT_SECRET"),
    refreshToken: readRequiredEnv("AMAZON_SANDBOX_REFRESH_TOKEN"),
  };
}

/**
 * Amazon SP-API connector -- currently implements only authenticate() and
 * one sandbox smoke-test call (getMarketplaceParticipations). Does NOT
 * implement the full ChannelConnector interface yet; pullOrders /
 * pushInventory / pushListing are separate, later work.
 */
export class AmazonConnector {
  private readonly credentials: AmazonSandboxCredentials;
  private readonly baseUrl: string;
  private cachedToken: CachedToken | null = null;

  constructor(
    credentials: AmazonSandboxCredentials = loadAmazonSandboxCredentialsFromEnv(),
    baseUrl: string = SP_API_EU_SANDBOX_BASE_URL,
  ) {
    this.credentials = credentials;
    this.baseUrl = baseUrl;
  }

  /**
   * Exchanges the refresh token for an LWA access token, caching it in
   * memory and transparently refreshing near expiry. The access token is
   * never logged, printed, or persisted -- it lives only on this instance.
   */
  async authenticate(): Promise<AuthToken> {
    const cached = this.cachedToken;
    if (cached && cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS > Date.now()) {
      return {
        accessToken: cached.accessToken,
        expiresAt: new Date(cached.expiresAtMs).toISOString(),
      };
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.credentials.refreshToken,
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
    });

    const response = await fetch(LWA_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!response.ok) {
      // Deliberately not including the response body: LWA error responses
      // don't echo secrets back, but there's no upside to risking it.
      throw new Error(
        `LWA token exchange failed: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
      token_type: string;
    };

    const expiresAtMs = Date.now() + data.expires_in * 1000;
    this.cachedToken = { accessToken: data.access_token, expiresAtMs };

    return {
      accessToken: data.access_token,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  /** GET /sellers/v1/marketplaceParticipations -- the sandbox smoke test call. */
  async getMarketplaceParticipations(): Promise<MarketplaceParticipation[]> {
    const { accessToken } = await this.authenticate();

    const response = await fetch(
      `${this.baseUrl}/sellers/v1/marketplaceParticipations`,
      {
        method: "GET",
        headers: {
          "x-amz-access-token": accessToken,
          "Content-Type": "application/json",
        },
      },
    );

    const data = (await response.json()) as MarketplaceParticipationsResponse;

    if (!response.ok) {
      const message =
        data.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ??
        response.statusText;
      throw new Error(
        `SP-API marketplaceParticipations failed: ${response.status} ${message}`,
      );
    }

    return data.payload ?? [];
  }
}
