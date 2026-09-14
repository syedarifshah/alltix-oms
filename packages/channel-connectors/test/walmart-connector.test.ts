// Pure-function unit tests for the Walmart connector's mapping logic -- no
// network, no live seller account required. Same split as
// amazon-connector.test.ts's parsePurchaseDate/isSandbox tests and
// shopify-connector.test.ts's normalizeShopifyOrder tests use: live
// end-to-end coverage (authenticate/pullOrders/pushInventory/confirmShipment
// against real Walmart infrastructure) belongs in
// scripts/walmart-sandbox-smoke-test.ts, not runnable today since no
// Walmart sandbox credentials exist yet (see that script's own header
// comment and WalmartConnector's class doc comment). These tests cover the
// one part of this connector that's genuinely provable without live
// credentials: the pure request/response mapping.
//
// Run with: npm run test --workspace=@alltix/channel-connectors

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapShipNodeTypeToFulfillmentType,
  normalizeWalmartOrder,
  normalizeWalmartOrderLine,
  type WalmartOrder,
  type WalmartOrderLine,
  type WalmartShipNodeType,
} from "../src/walmart-connector.js";

test("mapShipNodeTypeToFulfillmentType maps SellerFulfilled to seller_fulfilled", () => {
  assert.equal(mapShipNodeTypeToFulfillmentType("SellerFulfilled"), "seller_fulfilled");
});

test("mapShipNodeTypeToFulfillmentType maps WFSFulfilled to wfs", () => {
  assert.equal(mapShipNodeTypeToFulfillmentType("WFSFulfilled"), "wfs");
});

test("mapShipNodeTypeToFulfillmentType maps 3PLFulfilled to 3pl", () => {
  assert.equal(mapShipNodeTypeToFulfillmentType("3PLFulfilled"), "3pl");
});

test("mapShipNodeTypeToFulfillmentType falls back to seller_fulfilled for an unrecognized value", () => {
  // The switch's `default` branch -- proves an unexpected/future ship-node
  // type degrades to the safest known fulfillment type instead of throwing
  // or returning undefined, same defensive-default spirit as
  // normalizeShopifyOrderLine's own sku-fallback.
  assert.equal(mapShipNodeTypeToFulfillmentType("SomeFutureShipNodeType" as WalmartShipNodeType), "seller_fulfilled");
});

function makeWalmartOrderLine(overrides: Partial<WalmartOrderLine> = {}): WalmartOrderLine {
  return {
    lineNumber: "1",
    item: { sku: "SKU-001", productName: "Test Product" },
    charges: { charge: [{ chargeType: "PRODUCT", chargeAmount: { currency: "USD", amount: 19.99 } }] },
    orderLineQuantity: { unitOfMeasurement: "EACH", amount: "2" },
    orderLineStatuses: { orderLineStatus: [{ status: "Shipped" }] },
    ...overrides,
  };
}

test("normalizeWalmartOrderLine maps sku, quantity, and the PRODUCT charge's amount", () => {
  const normalized = normalizeWalmartOrderLine(makeWalmartOrderLine(), "seller_fulfilled");
  assert.deepEqual(normalized, {
    externalLineId: "1",
    externalSku: "SKU-001",
    quantity: 2,
    unitPrice: "19.99",
    fulfillmentType: "seller_fulfilled",
  });
});

test("normalizeWalmartOrderLine defaults unitPrice to 0.00 when no PRODUCT charge is present", () => {
  const normalized = normalizeWalmartOrderLine(
    makeWalmartOrderLine({ charges: { charge: [{ chargeType: "SHIPPING", chargeAmount: { currency: "USD", amount: 5 } }] } }),
    "seller_fulfilled",
  );
  assert.equal(normalized.unitPrice, "0.00");
});

test("normalizeWalmartOrderLine defaults unitPrice to 0.00 when charges is entirely absent", () => {
  const normalized = normalizeWalmartOrderLine(makeWalmartOrderLine({ charges: undefined }), "wfs");
  assert.equal(normalized.unitPrice, "0.00");
});

test("normalizeWalmartOrderLine threads through the fulfillmentType it was given, not derived from the line itself", () => {
  const normalized = normalizeWalmartOrderLine(makeWalmartOrderLine(), "3pl");
  assert.equal(normalized.fulfillmentType, "3pl");
});

function makeWalmartOrder(overrides: Partial<WalmartOrder> = {}): WalmartOrder {
  return {
    purchaseOrderId: "PO-123456789",
    customerOrderId: "CO-123456789",
    orderDate: 1750000000000,
    shippingInfo: { postalAddress: { city: "Bentonville", state: "AR" } },
    customerEmailId: "buyer@example.com",
    orderLines: { orderLine: [makeWalmartOrderLine()] },
    ...overrides,
  };
}

test("normalizeWalmartOrder uses purchaseOrderId as externalOrderId, not customerOrderId", () => {
  const normalized = normalizeWalmartOrder(makeWalmartOrder(), "SellerFulfilled");
  assert.equal(normalized.externalOrderId, "PO-123456789");
});

test("normalizeWalmartOrder always sets channel='walmart' and channelMarketplace=''", () => {
  const normalized = normalizeWalmartOrder(makeWalmartOrder(), "SellerFulfilled");
  assert.equal(normalized.channel, "walmart");
  assert.equal(normalized.channelMarketplace, "");
});

test("normalizeWalmartOrder converts the epoch-millis orderDate to an ISO string", () => {
  const normalized = normalizeWalmartOrder(makeWalmartOrder({ orderDate: 1750000000000 }), "SellerFulfilled");
  assert.equal(normalized.placedAt, new Date(1750000000000).toISOString());
});

test("normalizeWalmartOrder reads channelStatus off the first line's first orderLineStatus", () => {
  const normalized = normalizeWalmartOrder(
    makeWalmartOrder({ orderLines: { orderLine: [makeWalmartOrderLine({ orderLineStatuses: { orderLineStatus: [{ status: "Acknowledged" }] } })] } }),
    "SellerFulfilled",
  );
  assert.equal(normalized.channelStatus, "Acknowledged");
});

test("normalizeWalmartOrder defaults channelStatus to 'Created' when no line has a status yet", () => {
  const normalized = normalizeWalmartOrder(
    makeWalmartOrder({ orderLines: { orderLine: [makeWalmartOrderLine({ orderLineStatuses: undefined })] } }),
    "SellerFulfilled",
  );
  assert.equal(normalized.channelStatus, "Created");
});

test("normalizeWalmartOrder maps customerEmailId into customer.email", () => {
  const normalized = normalizeWalmartOrder(makeWalmartOrder({ customerEmailId: "buyer@example.com" }), "SellerFulfilled");
  assert.deepEqual(normalized.customer, { email: "buyer@example.com" });
});

test("normalizeWalmartOrder falls back to an empty customer object when customerEmailId is absent", () => {
  const normalized = normalizeWalmartOrder(makeWalmartOrder({ customerEmailId: undefined }), "SellerFulfilled");
  assert.deepEqual(normalized.customer, {});
});

test("normalizeWalmartOrder falls back to an empty shippingAddress when shippingInfo.postalAddress is absent", () => {
  const normalized = normalizeWalmartOrder(makeWalmartOrder({ shippingInfo: undefined }), "SellerFulfilled");
  assert.deepEqual(normalized.shippingAddress, {});
});

test("normalizeWalmartOrder maps every orderLine, applying the shipNodeType-derived fulfillmentType to each", () => {
  const normalized = normalizeWalmartOrder(
    makeWalmartOrder({
      orderLines: {
        orderLine: [makeWalmartOrderLine({ lineNumber: "1" }), makeWalmartOrderLine({ lineNumber: "2", item: { sku: "SKU-002" } })],
      },
    }),
    "WFSFulfilled",
  );
  assert.equal(normalized.lines.length, 2);
  assert.equal(normalized.lines[0]!.fulfillmentType, "wfs");
  assert.equal(normalized.lines[1]!.fulfillmentType, "wfs");
  assert.equal(normalized.lines[1]!.externalSku, "SKU-002");
});

test("normalizeWalmartOrder preserves the raw order as rawPayload for debugging/replay", () => {
  const order = makeWalmartOrder();
  const normalized = normalizeWalmartOrder(order, "SellerFulfilled");
  assert.deepEqual(normalized.rawPayload, order);
});
