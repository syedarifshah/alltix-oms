// Pure-function unit tests for the eBay connector's mapping logic -- no
// network, no live seller account required, same split as
// amazon-connector.test.ts's parsePurchaseDate/isSandbox tests and
// walmart-connector.test.ts's normalizeWalmartOrder tests use. There is no
// eBay sandbox smoke-test script yet (unlike Amazon's/Walmart's) --
// EbayConnector's authenticate()/pullOrders()/pushInventory()/
// confirmShipment() stay UNVERIFIED IN PRACTICE beyond what's provable
// here (see the class's own doc comment: this environment can't even
// reach api.sandbox.ebay.com to try). These tests cover the one part of
// this connector that's genuinely provable without live credentials: the
// pure order/line-item mapping.
//
// Run with: npm run test --workspace=@alltix/channel-connectors

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeEbayOrder,
  normalizeEbayOrderLine,
  EbayConnector,
  EBAY_API_SANDBOX_BASE_URL,
  type EbayOrder,
  type EbayLineItem,
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
