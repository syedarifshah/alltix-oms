import type { Pool } from "pg";
import { withTenant, decryptChannelSecret } from "@alltix/db";
import type { AuthToken, NormalizedOrder } from "./connector.js";

// SP-API auth has been LWA-only since Oct 2023 -- no AWS IAM/SigV4 signing
// required (CLAUDE.md §4.1). This is a smoke-test-only implementation:
// authenticate() plus one real sandbox call, to prove the credential chain
// works end to end before pullOrders/pushInventory/pushListing are built
// (CLAUDE.md §11.5: sandbox-first, one channel at a time).

const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";

// EU sandbox host, for a UK/EU seller account (CLAUDE.md §4.1 marketplace
// regions: NA/EU/FE each have their own SP-API host).
export const SP_API_EU_SANDBOX_BASE_URL = "https://sandbox.sellingpartnerapi-eu.amazon.com";

// The Orders API sandbox doesn't accept an arbitrary real CreatedAfter date
// the way marketplaceParticipations accepts arbitrary input -- it pattern-
// matches CreatedAfter against a fixed set of documented literal trigger
// strings to pick a canned response; anything else (including a real
// ISO8601 date) fails with "InvalidInput: Could not match input arguments".
// This is Amazon's own official onboarding-guide example value. See
// https://developer-docs.amazon.com/sp-api/docs/onboarding-step-5-make-your-first-call-to-the-sp-api-sandbox
export const SP_API_SANDBOX_TEST_CASE_CREATED_AFTER = "TEST_CASE_200";

// GET /orders/v0/orders requires at least one MarketplaceIds value and,
// unlike getMarketplaceParticipations, actually validates it against the
// seller account's real participations -- a mismatched id fails fast with
// "InvalidInput: Could not match input arguments" rather than falling back
// to canned data. This default (US, ATVPDKIKX0DER) is only correct for a
// sandbox account provisioned for the US marketplace; confirm via
// getMarketplaceParticipations() before assuming it for a different
// account, even one calling the EU sandbox host.
export const SP_API_SANDBOX_MARKETPLACE_ID = "ATVPDKIKX0DER";

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

/** Raw shape of one order from the SP-API sandbox's GET /orders/v0/orders --
 *  only the fields this connector actually maps are declared; the sandbox's
 *  canned responses carry more. */
export interface AmazonOrder {
  AmazonOrderId: string;
  PurchaseDate: string;
  OrderStatus: string;
  MarketplaceId?: string;
  ShippingAddress?: Record<string, unknown>;
  BuyerInfo?: Record<string, unknown>;
}

interface GetOrdersResponse {
  payload?: { Orders: AmazonOrder[]; NextToken?: string };
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
 * Reads the most recent active 'amazon' channel_connections row for a
 * tenant and decrypts its client_secret/refresh_token, via {@link withTenant}
 * so RLS scopes the lookup to `tenantId` (CLAUDE.md §2.4). Never logs the
 * decrypted values -- only returns them.
 */
export async function loadAmazonCredentialsFromChannelConnection(
  pool: Pool,
  tenantId: string,
): Promise<AmazonSandboxCredentials> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query<{
      lwa_client_id: string;
      encrypted_client_secret: Buffer;
      encrypted_refresh_token: Buffer;
    }>(
      `SELECT lwa_client_id, encrypted_client_secret, encrypted_refresh_token
         FROM channel_connections
        WHERE channel = 'amazon' AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 1`,
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(
        `No active 'amazon' channel_connections row found for tenant ${tenantId}`,
      );
    }

    const [clientSecret, refreshToken] = await Promise.all([
      decryptChannelSecret(client, row.encrypted_client_secret),
      decryptChannelSecret(client, row.encrypted_refresh_token),
    ]);

    return { clientId: row.lwa_client_id, clientSecret, refreshToken };
  });
}

/** Builds an {@link AmazonConnector} from a tenant's channel_connections row instead of process.env. */
export async function createAmazonConnectorFromChannelConnection(
  pool: Pool,
  tenantId: string,
  baseUrl: string = SP_API_EU_SANDBOX_BASE_URL,
  marketplaceIds: string[] = [SP_API_SANDBOX_MARKETPLACE_ID],
): Promise<AmazonConnector> {
  const credentials = await loadAmazonCredentialsFromChannelConnection(pool, tenantId);
  return new AmazonConnector(credentials, baseUrl, marketplaceIds);
}

/**
 * Amazon SP-API connector -- implements authenticate(), the
 * getMarketplaceParticipations sandbox smoke-test call, and pullOrders().
 * Does NOT implement the full ChannelConnector interface yet; pushInventory
 * / pushListing are separate, later work.
 *
 * Credentials come either from process.env (the default, via
 * {@link loadAmazonSandboxCredentialsFromEnv}, used by
 * scripts/amazon-sandbox-smoke-test.ts) or from a tenant's
 * channel_connections row (via {@link createAmazonConnectorFromChannelConnection}).
 */
export class AmazonConnector {
  private readonly credentials: AmazonSandboxCredentials;
  private readonly baseUrl: string;
  private readonly marketplaceIds: string[];
  private cachedToken: CachedToken | null = null;

  constructor(
    credentials: AmazonSandboxCredentials = loadAmazonSandboxCredentialsFromEnv(),
    baseUrl: string = SP_API_EU_SANDBOX_BASE_URL,
    marketplaceIds: string[] = [SP_API_SANDBOX_MARKETPLACE_ID],
  ) {
    this.credentials = credentials;
    this.baseUrl = baseUrl;
    this.marketplaceIds = marketplaceIds;
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

  /**
   * GET /orders/v0/orders with CreatedAfter=since -- pulls order headers
   * only and normalizes them. Order line items require a separate call
   * (GET /orders/v0/orders/{orderId}/orderItems, CLAUDE.md §4.1) that isn't
   * implemented yet, so every returned order's `lines` is empty for now.
   *
   * `since` accepts a real Date (production: converted to ISO8601) or a raw
   * string (sandbox: one of Amazon's documented literal trigger values, e.g.
   * {@link SP_API_SANDBOX_TEST_CASE_CREATED_AFTER}, which the real API would
   * reject as an invalid date but the sandbox requires instead of one).
   */
  async pullOrders(since: Date | string): Promise<NormalizedOrder[]> {
    const { accessToken } = await this.authenticate();

    const query = new URLSearchParams({
      MarketplaceIds: this.marketplaceIds.join(","),
      CreatedAfter: since instanceof Date ? since.toISOString() : since,
    });

    const response = await fetch(`${this.baseUrl}/orders/v0/orders?${query.toString()}`, {
      method: "GET",
      headers: {
        "x-amz-access-token": accessToken,
        "Content-Type": "application/json",
      },
    });

    const data = (await response.json()) as GetOrdersResponse;

    if (!response.ok) {
      const message =
        data.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ??
        response.statusText;
      throw new Error(`SP-API orders failed: ${response.status} ${message}`);
    }

    const orders = data.payload?.Orders ?? [];
    return orders.map(normalizeAmazonOrder);
  }
}

function normalizeAmazonOrder(order: AmazonOrder): NormalizedOrder {
  return {
    externalOrderId: order.AmazonOrderId,
    channel: "amazon",
    channelMarketplace: order.MarketplaceId ?? "",
    channelStatus: order.OrderStatus,
    placedAt: order.PurchaseDate,
    customer: order.BuyerInfo ?? {},
    shippingAddress: order.ShippingAddress ?? {},
    lines: [],
    rawPayload: order,
  };
}
