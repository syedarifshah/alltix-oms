// Pure-function unit tests for the eBay connector's mapping logic -- no
// network, no live seller account required, same split as
// amazon-connector.test.ts's parsePurchaseDate/isSandbox tests and
// walmart-connector.test.ts's normalizeWalmartOrder tests use. There is no
// eBay sandbox smoke-test script yet (unlike Amazon's/Walmart's) --
// EbayConnector's authenticate()/pushInventory()/confirmShipment() stay
// UNVERIFIED IN PRACTICE beyond what's provable here (see the class's own
// doc comment: this environment can't even reach api.sandbox.ebay.com to
// try). These tests cover the parts of this connector that are genuinely
// provable without live credentials: the pure order/line-item mapping, plus
// -- see the "pullOrders() pagination" section below -- pullOrders()'s own
// pagination loop, exercised against a stubbed global.fetch the same way
// retry.test.ts already proves fetchWithBackoff without live network.
//
// Run with: npm run test --workspace=@alltix/channel-connectors

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeEbayOrder,
  normalizeEbayOrderLine,
  buildEbayInventoryItemBody,
  buildEbayOfferBody,
  EbayConnector,
  EBAY_API_SANDBOX_BASE_URL,
  EBAY_ORDERS_PAGE_SIZE,
  EBAY_ORDERS_MAX_PAGES,
  type EbayOrder,
  type EbayLineItem,
  type EbayListingSubmission,
} from "../src/ebay-connector.js";
import { buildEbayAuthorizeUrl, parseEbayOAuthCallback, EBAY_OAUTH_SCOPES } from "../src/ebay-oauth.js";

function makeLineItem(overrides: Partial<EbayLineItem> = {}): EbayLineItem {
  return {
    lineItemId: "111222333444",
    sku: "SKU-001",
    legacyItemId: "999888777",
    title: "Test Product",
    quantity: 2,
    lineItemCost: { value: "39.98", currency: "USD" },
    ...overrides,
  };
}

test("normalizeEbayOrderLine divides lineItemCost (a line TOTAL, not a per-unit price) by quantity", () => {
  const normalized = normalizeEbayOrderLine(makeLineItem({ quantity: 2, lineItemCost: { value: "39.98", currency: "USD" } }));
  assert.equal(normalized.unitPrice, "19.99");
});

test("normalizeEbayOrderLine handles quantity 1 (line total equals unit price)", () => {
  const normalized = normalizeEbayOrderLine(makeLineItem({ quantity: 1, lineItemCost: { value: "9.99", currency: "USD" } }));
  assert.equal(normalized.unitPrice, "9.99");
});

test("normalizeEbayOrderLine defaults unitPrice to 0.00 when lineItemCost is absent", () => {
  const normalized = normalizeEbayOrderLine(makeLineItem({ lineItemCost: undefined }));
  assert.equal(normalized.unitPrice, "0.00");
});

test("normalizeEbayOrderLine defaults unitPrice to 0.00 rather than dividing by zero when quantity is 0", () => {
  const normalized = normalizeEbayOrderLine(makeLineItem({ quantity: 0, lineItemCost: { value: "10.00", currency: "USD" } }));
  assert.equal(normalized.unitPrice, "0.00");
});

test("normalizeEbayOrderLine prefers sku over legacyItemId when both are present", () => {
  const normalized = normalizeEbayOrderLine(makeLineItem({ sku: "SKU-001", legacyItemId: "999888777" }));
  assert.equal(normalized.externalSku, "SKU-001");
});

test("normalizeEbayOrderLine falls back to legacyItemId when sku is absent (real eBay responses omit it)", () => {
  const normalized = normalizeEbayOrderLine(makeLineItem({ sku: undefined, legacyItemId: "999888777" }));
  assert.equal(normalized.externalSku, "999888777");
});

test("normalizeEbayOrderLine falls back to lineItemId when neither sku nor legacyItemId is present", () => {
  const normalized = normalizeEbayOrderLine(makeLineItem({ sku: undefined, legacyItemId: undefined, lineItemId: "L1" }));
  assert.equal(normalized.externalSku, "L1");
});

test("normalizeEbayOrderLine always maps to fulfillmentType 'seller_fulfilled'", () => {
  const normalized = normalizeEbayOrderLine(makeLineItem());
  assert.equal(normalized.fulfillmentType, "seller_fulfilled");
});

test("normalizeEbayOrderLine threads lineItemId through as externalLineId", () => {
  const normalized = normalizeEbayOrderLine(makeLineItem({ lineItemId: "abc123" }));
  assert.equal(normalized.externalLineId, "abc123");
});

function makeOrder(overrides: Partial<EbayOrder> = {}): EbayOrder {
  return {
    orderId: "13-08587-19644",
    creationDate: "2024-03-15T10:30:00.000Z",
    orderFulfillmentStatus: "NOT_STARTED",
    buyer: { username: "test_buyer" },
    fulfillmentStartInstructions: [{ shippingStep: { shipTo: { fullName: "Jane Doe", contactAddress: { postalCode: "72712" } } } }],
    lineItems: [makeLineItem()],
    ...overrides,
  };
}

test("normalizeEbayOrder uses orderId as externalOrderId", () => {
  const normalized = normalizeEbayOrder(makeOrder());
  assert.equal(normalized.externalOrderId, "13-08587-19644");
});

test("normalizeEbayOrder always sets channel='ebay' and channelMarketplace=''", () => {
  const normalized = normalizeEbayOrder(makeOrder());
  assert.equal(normalized.channel, "ebay");
  assert.equal(normalized.channelMarketplace, "");
});

test("normalizeEbayOrder passes creationDate through as placedAt unchanged", () => {
  const normalized = normalizeEbayOrder(makeOrder({ creationDate: "2024-03-15T10:30:00.000Z" }));
  assert.equal(normalized.placedAt, "2024-03-15T10:30:00.000Z");
});

test("normalizeEbayOrder maps orderFulfillmentStatus to channelStatus", () => {
  const normalized = normalizeEbayOrder(makeOrder({ orderFulfillmentStatus: "IN_PROGRESS" }));
  assert.equal(normalized.channelStatus, "IN_PROGRESS");
});

test("normalizeEbayOrder maps buyer through to customer", () => {
  const normalized = normalizeEbayOrder(makeOrder({ buyer: { username: "jdoe99" } }));
  assert.deepEqual(normalized.customer, { username: "jdoe99" });
});

test("normalizeEbayOrder falls back to an empty customer object when buyer is absent", () => {
  const normalized = normalizeEbayOrder(makeOrder({ buyer: undefined }));
  assert.deepEqual(normalized.customer, {});
});

test("normalizeEbayOrder resolves shippingAddress from fulfillmentStartInstructions[0].shippingStep.shipTo", () => {
  const normalized = normalizeEbayOrder(
    makeOrder({
      fulfillmentStartInstructions: [{ shippingStep: { shipTo: { fullName: "John Smith" } } }],
    }),
  );
  assert.deepEqual(normalized.shippingAddress, { fullName: "John Smith" });
});

test("normalizeEbayOrder falls back to an empty shippingAddress when fulfillmentStartInstructions is absent", () => {
  const normalized = normalizeEbayOrder(makeOrder({ fulfillmentStartInstructions: undefined }));
  assert.deepEqual(normalized.shippingAddress, {});
});

test("normalizeEbayOrder falls back to an empty shippingAddress when shipTo itself is absent", () => {
  const normalized = normalizeEbayOrder(makeOrder({ fulfillmentStartInstructions: [{ shippingStep: {} }] }));
  assert.deepEqual(normalized.shippingAddress, {});
});

test("normalizeEbayOrder maps every lineItem", () => {
  const normalized = normalizeEbayOrder(
    makeOrder({
      lineItems: [makeLineItem({ lineItemId: "1" }), makeLineItem({ lineItemId: "2", sku: "SKU-002" })],
    }),
  );
  assert.equal(normalized.lines.length, 2);
  assert.equal(normalized.lines[1]!.externalSku, "SKU-002");
});

test("normalizeEbayOrder preserves the raw order as rawPayload for debugging/replay", () => {
  const order = makeOrder();
  const normalized = normalizeEbayOrder(order);
  assert.deepEqual(normalized.rawPayload, order);
});

// EbayConnector.isSandbox() -- same host-comparison shape as
// AmazonConnector's own isSandbox() tests.
const FAKE_CREDENTIALS = { clientId: "x", clientSecret: "x", refreshToken: "x" };

test("isSandbox() is true for the sandbox host", () => {
  assert.equal(new EbayConnector(FAKE_CREDENTIALS, EBAY_API_SANDBOX_BASE_URL).isSandbox(), true);
});

test("isSandbox() is false for the production host", () => {
  assert.equal(new EbayConnector(FAKE_CREDENTIALS, "https://api.ebay.com").isSandbox(), false);
});

// ebay-oauth.ts -- pure URL-building/parsing, same shape as this file's own
// EbayConnector tests above (no network).

test("buildEbayAuthorizeUrl targets the production host by default", () => {
  const url = buildEbayAuthorizeUrl("client-id", "My-RuName", "state-token");
  assert.match(url, /^https:\/\/auth\.ebay\.com\/oauth2\/authorize\?/);
});

test("buildEbayAuthorizeUrl targets the sandbox host when sandbox=true", () => {
  const url = buildEbayAuthorizeUrl("client-id", "My-RuName", "state-token", true);
  assert.match(url, /^https:\/\/auth\.sandbox\.ebay\.com\/oauth2\/authorize\?/);
});

test("buildEbayAuthorizeUrl includes client_id, redirect_uri, response_type=code, state, and both default scopes", () => {
  const url = new URL(buildEbayAuthorizeUrl("client-id", "My-RuName", "state-token"));
  assert.equal(url.searchParams.get("client_id"), "client-id");
  assert.equal(url.searchParams.get("redirect_uri"), "My-RuName");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("state"), "state-token");
  assert.equal(url.searchParams.get("scope"), EBAY_OAUTH_SCOPES.join(" "));
});

test("parseEbayOAuthCallback extracts code and state when both present", () => {
  const params = new URLSearchParams({ code: "auth-code-value", state: "state-token" });
  assert.deepEqual(parseEbayOAuthCallback(params), { code: "auth-code-value", state: "state-token" });
});

test("parseEbayOAuthCallback returns null when code is missing", () => {
  const params = new URLSearchParams({ state: "state-token" });
  assert.equal(parseEbayOAuthCallback(params), null);
});

test("parseEbayOAuthCallback returns null when state is missing", () => {
  const params = new URLSearchParams({ code: "auth-code-value" });
  assert.equal(parseEbayOAuthCallback(params), null);
});

function makeListingSubmission(overrides: Partial<EbayListingSubmission> = {}): EbayListingSubmission {
  return {
    sellerSku: "SKU-001",
    title: "Test Product",
    description: "A test product description.",
    imageUrl: "https://example.com/image.jpg",
    categoryId: "12345",
    price: "19.99",
    quantity: 10,
    ...overrides,
  };
}

test("buildEbayInventoryItemBody fixes condition to NEW and wraps imageUrl in a single-element array", () => {
  const body = buildEbayInventoryItemBody(makeListingSubmission());
  assert.equal(body.condition, "NEW");
  assert.deepEqual(body.product, {
    title: "Test Product",
    description: "A test product description.",
    imageUrls: ["https://example.com/image.jpg"],
  });
  assert.equal(body.availability.shipToLocationAvailability.quantity, 10);
});

test("buildEbayOfferBody hardcodes marketplaceId/format/currency and threads through the listing policies + merchant location key", () => {
  const body = buildEbayOfferBody(
    makeListingSubmission({ price: "29.99" }),
    { fulfillmentPolicyId: "fp-1", paymentPolicyId: "pp-1", returnPolicyId: "rp-1" },
    "warehouse-key-1",
  );
  assert.equal(body.sku, "SKU-001");
  assert.equal(body.marketplaceId, "EBAY_US");
  assert.equal(body.format, "FIXED_PRICE");
  assert.equal(body.categoryId, "12345");
  assert.equal(body.availableQuantity, 10);
  assert.deepEqual(body.listingPolicies, { fulfillmentPolicyId: "fp-1", paymentPolicyId: "pp-1", returnPolicyId: "rp-1" });
  assert.equal(body.merchantLocationKey, "warehouse-key-1");
  assert.deepEqual(body.pricingSummary, { price: { value: "29.99", currency: "USD" } });
});

// pullOrders() pagination -- regression coverage for the real (not
// theoretical) gap CLAUDE.md's eBay update describes: this method used to
// fetch only the first EBAY_ORDERS_PAGE_SIZE-order page and ignore the
// response's own `next` field, silently dropping the rest of a tenant's
// orders past page 1. global.fetch is stubbed per test and restored in a
// `finally` -- same discipline retry.test.ts's own header comment
// documents -- and every stub must also answer the token-refresh POST
// authorizedFetch() makes before its first real call (EbayConnector caches
// the token in-memory per instance, so one token response per test covers
// however many order-page requests follow).

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const TOKEN_RESPONSE_BODY = { access_token: "fake-token", expires_in: 7200, token_type: "Application Access Token" };

/** Thin wrapper over this file's own makeOrder(overrides) -- just pins
 *  orderId, since these pagination tests care about which orders came back
 *  and in what order, not the rest of an order's shape (already covered by
 *  the normalizeEbayOrder tests above). */
function makePageOrder(orderId: string): EbayOrder {
  return makeOrder({ orderId });
}

/** Pulls the `offset` query param off a stubbed fetch call's URL, for
 *  asserting each page request advanced it correctly. */
function offsetOf(url: string): string | null {
  return new URL(url).searchParams.get("offset");
}

test("pullOrders collects every order across multiple pages, following `next` until it's absent", async () => {
  const originalFetch = globalThis.fetch;
  const requestedOffsets: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/identity/v1/oauth2/token")) {
      return jsonResponse(200, TOKEN_RESPONSE_BODY);
    }
    const offset = offsetOf(url);
    requestedOffsets.push(offset ?? "");
    if (offset === "0") {
      return jsonResponse(200, { orders: [makePageOrder("order-1"), makePageOrder("order-2")], next: "https://api.sandbox.ebay.com/sell/fulfillment/v1/order?offset=200&limit=200" });
    }
    if (offset === String(EBAY_ORDERS_PAGE_SIZE)) {
      return jsonResponse(200, {
        orders: [makePageOrder("order-3")],
        next: `https://api.sandbox.ebay.com/sell/fulfillment/v1/order?offset=${EBAY_ORDERS_PAGE_SIZE * 2}&limit=200`,
      });
    }
    if (offset === String(EBAY_ORDERS_PAGE_SIZE * 2)) {
      // No `next` this time -- the loop must stop here.
      return jsonResponse(200, { orders: [makePageOrder("order-4")] });
    }
    throw new Error(`unexpected request in test: ${url}`);
  }) as typeof fetch;

  try {
    const connector = new EbayConnector(FAKE_CREDENTIALS, EBAY_API_SANDBOX_BASE_URL);
    const orders = await connector.pullOrders(new Date("2026-01-01T00:00:00.000Z"));

    assert.deepEqual(
      orders.map((o) => o.externalOrderId),
      ["order-1", "order-2", "order-3", "order-4"],
      "must collect orders from every page, not just the first",
    );
    assert.deepEqual(
      requestedOffsets,
      ["0", String(EBAY_ORDERS_PAGE_SIZE), String(EBAY_ORDERS_PAGE_SIZE * 2)],
      "must advance offset by one page's worth each time, and stop once `next` is absent",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pullOrders stops (rather than looping forever) when a page claims `next` but returns zero orders", async () => {
  const originalFetch = globalThis.fetch;
  let orderPageRequests = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/identity/v1/oauth2/token")) {
      return jsonResponse(200, TOKEN_RESPONSE_BODY);
    }
    orderPageRequests++;
    // Malformed/edge-case response: claims another page exists but has
    // nothing in it. Must be treated as "done," not followed forever.
    return jsonResponse(200, { orders: [], next: "https://api.sandbox.ebay.com/sell/fulfillment/v1/order?offset=200&limit=200" });
  }) as typeof fetch;

  try {
    const connector = new EbayConnector(FAKE_CREDENTIALS, EBAY_API_SANDBOX_BASE_URL);
    const orders = await connector.pullOrders(new Date("2026-01-01T00:00:00.000Z"));
    assert.deepEqual(orders, []);
    assert.equal(orderPageRequests, 1, "an empty page must stop the loop immediately, even though `next` was set");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pullOrders never fetches the literal `next` URL eBay returns -- it only checks it for truthiness and re-derives the next request itself", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/identity/v1/oauth2/token")) {
      return jsonResponse(200, TOKEN_RESPONSE_BODY);
    }
    requestedUrls.push(url);
    if (offsetOf(url) === "0") {
      // A deliberately bogus `next` (wrong host, malformed) -- if pullOrders()
      // ever actually fetched this literal string, the test's own stub
      // would receive a request for a URL it never intended to serve.
      return jsonResponse(200, { orders: [makePageOrder("order-1")], next: "https://totally-not-ebay.example/bogus-next-url" });
    }
    return jsonResponse(200, { orders: [makePageOrder("order-2")] });
  }) as typeof fetch;

  try {
    const connector = new EbayConnector(FAKE_CREDENTIALS, EBAY_API_SANDBOX_BASE_URL);
    const orders = await connector.pullOrders(new Date("2026-01-01T00:00:00.000Z"));
    assert.equal(orders.length, 2);
    for (const url of requestedUrls) {
      assert.ok(url.startsWith(EBAY_API_SANDBOX_BASE_URL), `every request must stay on this connector's own base URL, got: ${url}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pullOrders stops at EBAY_ORDERS_MAX_PAGES rather than looping forever against a `next` that never runs out", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  let warned = false;
  console.warn = () => {
    warned = true;
  };
  let pageRequests = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/identity/v1/oauth2/token")) {
      return jsonResponse(200, TOKEN_RESPONSE_BODY);
    }
    pageRequests++;
    // Always claims another page exists, with exactly one order each time --
    // an adversarial response that would spin forever without the cap.
    return jsonResponse(200, {
      orders: [makePageOrder(`order-${pageRequests}`)],
      next: "https://api.sandbox.ebay.com/sell/fulfillment/v1/order?offset=999999&limit=200",
    });
  }) as typeof fetch;

  try {
    const connector = new EbayConnector(FAKE_CREDENTIALS, EBAY_API_SANDBOX_BASE_URL);
    const orders = await connector.pullOrders(new Date("2026-01-01T00:00:00.000Z"));
    assert.equal(pageRequests, EBAY_ORDERS_MAX_PAGES, "must stop at exactly the cap, not one more, not fewer");
    assert.equal(orders.length, EBAY_ORDERS_MAX_PAGES);
    assert.equal(warned, true, "hitting the cap must be logged, not silent");
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});
