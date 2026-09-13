// Pure-function unit tests for the Shopify connector's mapping/verification
// logic -- no network, no live store required. Live-integration coverage
// (pullOrders/pushInventory/confirmShipment against a real Shopify dev
// store) is scripts/shopify-sandbox-smoke-test.ts, run manually once real
// SHOPIFY_SANDBOX_* credentials exist (see .env.example) -- same split
// AmazonConnector's own parsePurchaseDate/isSandbox unit tests vs.
// amazon-sandbox-smoke-test.ts use.
//
// Run with: npm run test --workspace=@alltix/channel-connectors

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  normalizeShopifyOrder,
  normalizeShopifyOrderWebhookPayload,
  normalizeShopifyProductVariant,
  verifyShopifyWebhookHmac,
  type RawProductVariantNode,
  type ShopifyOrder,
  type ShopifyOrderWebhookPayload,
} from "../src/shopify-connector.js";

function makeShopifyOrder(overrides: Partial<ShopifyOrder> = {}): ShopifyOrder {
  return {
    id: "gid://shopify/Order/123456789",
    name: "#1001",
    createdAt: "2026-01-15T10:30:00Z",
    displayFulfillmentStatus: "UNFULFILLED",
    email: null,
    customer: null,
    shippingAddress: null,
    lineItems: {
      edges: [
        {
          node: {
            id: "gid://shopify/LineItem/1",
            sku: "SKU-001",
            quantity: 2,
            originalUnitPriceSet: { shopMoney: { amount: "19.99", currencyCode: "USD" } },
          },
        },
      ],
    },
    ...overrides,
  };
}

test("normalizeShopifyOrder uses the order's GID as externalOrderId, not the human-readable name", () => {
  const normalized = normalizeShopifyOrder(makeShopifyOrder());
  assert.equal(normalized.externalOrderId, "gid://shopify/Order/123456789");
});

test("normalizeShopifyOrder always sets channel='shopify' and channelMarketplace=''", () => {
  const normalized = normalizeShopifyOrder(makeShopifyOrder());
  assert.equal(normalized.channel, "shopify");
  assert.equal(normalized.channelMarketplace, "");
});

test("normalizeShopifyOrder prefers customer.email over the order-level email when both are present", () => {
  const normalized = normalizeShopifyOrder(
    makeShopifyOrder({ email: "order-level@example.com", customer: { email: "customer@example.com" } }),
  );
  assert.deepEqual(normalized.customer, { email: "customer@example.com" });
});

test("normalizeShopifyOrder falls back to the order-level email when customer.email is absent", () => {
  const normalized = normalizeShopifyOrder(makeShopifyOrder({ email: "order-level@example.com", customer: null }));
  assert.deepEqual(normalized.customer, { email: "order-level@example.com" });
});

test("normalizeShopifyOrder falls back to an empty customer object when neither email is present", () => {
  const normalized = normalizeShopifyOrder(makeShopifyOrder({ email: null, customer: null }));
  assert.deepEqual(normalized.customer, {});
});

test("normalizeShopifyOrder maps line items, defaulting fulfillmentType to seller_fulfilled", () => {
  const normalized = normalizeShopifyOrder(makeShopifyOrder());
  assert.equal(normalized.lines.length, 1);
  assert.deepEqual(normalized.lines[0], {
    externalLineId: "gid://shopify/LineItem/1",
    externalSku: "SKU-001",
    quantity: 2,
    unitPrice: "19.99",
    fulfillmentType: "seller_fulfilled",
  });
});

test("normalizeShopifyOrder falls back a line's externalSku to its own GID when sku is null", () => {
  const normalized = normalizeShopifyOrder(
    makeShopifyOrder({
      lineItems: {
        edges: [
          {
            node: {
              id: "gid://shopify/LineItem/2",
              sku: null,
              quantity: 1,
              originalUnitPriceSet: { shopMoney: { amount: "5.00", currencyCode: "USD" } },
            },
          },
        ],
      },
    }),
  );
  assert.equal(normalized.lines[0]?.externalSku, "gid://shopify/LineItem/2");
});

test("normalizeShopifyOrder preserves the raw order as rawPayload", () => {
  const raw = makeShopifyOrder();
  const normalized = normalizeShopifyOrder(raw);
  assert.deepEqual(normalized.rawPayload, raw);
});

function makeVariantNode(overrides: Partial<RawProductVariantNode> = {}): RawProductVariantNode {
  return {
    id: "gid://shopify/ProductVariant/1",
    sku: "SKU-001",
    title: "Default Title",
    product: { title: "Test Product" },
    inventoryItem: {
      id: "gid://shopify/InventoryItem/1",
      inventoryLevels: { edges: [{ node: { location: { id: "gid://shopify/Location/1" }, quantities: [{ quantity: 10 }] } }] },
    },
    ...overrides,
  };
}

test("normalizeShopifyProductVariant returns null for a variant with no SKU set", () => {
  assert.equal(normalizeShopifyProductVariant(makeVariantNode({ sku: null })), null);
});

test("normalizeShopifyProductVariant sums quantity across every location the item has a level at", () => {
  const normalized = normalizeShopifyProductVariant(
    makeVariantNode({
      inventoryItem: {
        id: "gid://shopify/InventoryItem/1",
        inventoryLevels: {
          edges: [
            { node: { location: { id: "gid://shopify/Location/1" }, quantities: [{ quantity: 10 }] } },
            { node: { location: { id: "gid://shopify/Location/2" }, quantities: [{ quantity: 5 }] } },
          ],
        },
      },
    }),
  );
  assert.equal(normalized?.totalAvailable, 15);
});

test("normalizeShopifyProductVariant treats a variant with no inventory levels yet as zero available, not an error", () => {
  const normalized = normalizeShopifyProductVariant(
    makeVariantNode({ inventoryItem: { id: "gid://shopify/InventoryItem/1", inventoryLevels: { edges: [] } } }),
  );
  assert.equal(normalized?.totalAvailable, 0);
});

test("normalizeShopifyProductVariant drops Shopify's 'Default Title' suffix for a single-variant product", () => {
  const normalized = normalizeShopifyProductVariant(makeVariantNode({ title: "Default Title", product: { title: "Test Product" } }));
  assert.equal(normalized?.title, "Test Product");
});

test("normalizeShopifyProductVariant combines product and variant titles when the variant has a real one", () => {
  const normalized = normalizeShopifyProductVariant(makeVariantNode({ title: "Large / Blue", product: { title: "Test Product" } }));
  assert.equal(normalized?.title, "Test Product - Large / Blue");
});

test("normalizeShopifyProductVariant carries the SKU and inventoryItem gid through unchanged", () => {
  const normalized = normalizeShopifyProductVariant(
    makeVariantNode({ sku: "SKU-XYZ", inventoryItem: { id: "gid://shopify/InventoryItem/99", inventoryLevels: { edges: [] } } }),
  );
  assert.equal(normalized?.externalSku, "SKU-XYZ");
  assert.equal(normalized?.inventoryItemId, "gid://shopify/InventoryItem/99");
});

function makeOrderWebhookPayload(overrides: Partial<ShopifyOrderWebhookPayload> = {}): ShopifyOrderWebhookPayload {
  return {
    id: 5678919990329,
    admin_graphql_api_id: "gid://shopify/Order/5678919990329",
    name: "#1001",
    created_at: "2026-01-15T10:30:00Z",
    fulfillment_status: null,
    email: null,
    customer: null,
    shipping_address: null,
    line_items: [{ id: 12345678901234, sku: "SKU-001", quantity: 2, price: "19.99" }],
    ...overrides,
  };
}

test("normalizeShopifyOrderWebhookPayload uses admin_graphql_api_id (not the numeric id) as externalOrderId, matching pullOrders'", () => {
  const normalized = normalizeShopifyOrderWebhookPayload(makeOrderWebhookPayload());
  assert.equal(normalized.externalOrderId, "gid://shopify/Order/5678919990329");
});

test("normalizeShopifyOrderWebhookPayload always sets channel='shopify' and channelMarketplace=''", () => {
  const normalized = normalizeShopifyOrderWebhookPayload(makeOrderWebhookPayload());
  assert.equal(normalized.channel, "shopify");
  assert.equal(normalized.channelMarketplace, "");
});

test("normalizeShopifyOrderWebhookPayload prefers customer.email over the order-level email when both are present", () => {
  const normalized = normalizeShopifyOrderWebhookPayload(
    makeOrderWebhookPayload({ email: "order-level@example.com", customer: { email: "customer@example.com" } }),
  );
  assert.deepEqual(normalized.customer, { email: "customer@example.com" });
});

test("normalizeShopifyOrderWebhookPayload falls back to an empty customer object when neither email is present", () => {
  const normalized = normalizeShopifyOrderWebhookPayload(makeOrderWebhookPayload({ email: null, customer: null }));
  assert.deepEqual(normalized.customer, {});
});

test("normalizeShopifyOrderWebhookPayload maps flat line_items, defaulting fulfillmentType to seller_fulfilled", () => {
  const normalized = normalizeShopifyOrderWebhookPayload(makeOrderWebhookPayload());
  assert.equal(normalized.lines.length, 1);
  assert.deepEqual(normalized.lines[0], {
    externalLineId: "12345678901234",
    externalSku: "SKU-001",
    quantity: 2,
    unitPrice: "19.99",
    fulfillmentType: "seller_fulfilled",
  });
});

test("normalizeShopifyOrderWebhookPayload falls back a line's externalSku to its own id when sku is null", () => {
  const normalized = normalizeShopifyOrderWebhookPayload(
    makeOrderWebhookPayload({ line_items: [{ id: 999, sku: null, quantity: 1, price: "5.00" }] }),
  );
  assert.equal(normalized.lines[0]?.externalSku, "999");
});

test("normalizeShopifyOrderWebhookPayload preserves the raw payload as rawPayload", () => {
  const raw = makeOrderWebhookPayload();
  const normalized = normalizeShopifyOrderWebhookPayload(raw);
  assert.deepEqual(normalized.rawPayload, raw);
});

test("verifyShopifyWebhookHmac accepts a correctly-signed body", () => {
  const secret = "test-client-secret";
  const rawBody = JSON.stringify({ id: 123, test: true });
  const hmacHeader = createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  assert.equal(verifyShopifyWebhookHmac(rawBody, hmacHeader, secret), true);
});

test("verifyShopifyWebhookHmac rejects a body that was tampered with after signing", () => {
  const secret = "test-client-secret";
  const original = JSON.stringify({ id: 123, test: true });
  const hmacHeader = createHmac("sha256", secret).update(original, "utf8").digest("base64");
  const tampered = JSON.stringify({ id: 123, test: false });
  assert.equal(verifyShopifyWebhookHmac(tampered, hmacHeader, secret), false);
});

test("verifyShopifyWebhookHmac rejects a signature computed with the wrong secret", () => {
  const rawBody = JSON.stringify({ id: 123, test: true });
  const hmacHeader = createHmac("sha256", "wrong-secret").update(rawBody, "utf8").digest("base64");
  assert.equal(verifyShopifyWebhookHmac(rawBody, hmacHeader, "test-client-secret"), false);
});

test("verifyShopifyWebhookHmac rejects a malformed/short header instead of throwing", () => {
  const rawBody = JSON.stringify({ id: 123 });
  assert.equal(verifyShopifyWebhookHmac(rawBody, "not-a-real-signature", "test-client-secret"), false);
});

test("verifyShopifyWebhookHmac rejects an empty header instead of throwing", () => {
  const rawBody = JSON.stringify({ id: 123 });
  assert.equal(verifyShopifyWebhookHmac(rawBody, "", "test-client-secret"), false);
});
