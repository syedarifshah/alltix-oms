// Fetch-intercepted unit tests for RoyalMailConnector -- no real Royal Mail
// credentials exist anywhere in this codebase yet (see royal-mail-connector.ts's
// own class doc comment for the full CONFIRMED/INFERRED research trail).
// Same "stub globalThis.fetch, restore in finally" discipline every other
// connector test file in this codebase already uses (e.g.
// channel-connectors/test/ebay-connector.test.ts).
//
// Run with: npm run test --workspace=@alltix/carrier-connectors

import { test } from "node:test";
import assert from "node:assert/strict";
import { RoyalMailConnector, type RoyalMailCredentials } from "../src/royal-mail-connector.js";
import type { CreateShipmentRequest } from "../src/connector.js";

const CREDENTIALS: RoyalMailCredentials = {
  clickAndDropApiKey: "test-click-and-drop-key",
  trackingClientId: "test-tracking-client-id",
  trackingClientSecret: "test-tracking-client-secret",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const SAMPLE_REQUEST: CreateShipmentRequest = {
  orderId: "order-1",
  orderReference: "ORDER-1",
  orderDate: "2026-09-24T10:00:00Z",
  recipient: {
    name: "Jane Doe",
    addressLine1: "1 Test Street",
    city: "London",
    postalCode: "SW1A 1AA",
    countryCode: "GB",
    phone: "07700900000",
    email: "jane@example.com",
  },
  subtotalGbp: "19.99",
  shippingCostChargedGbp: "3.99",
  totalGbp: "23.98",
  packages: [
    {
      weightGrams: 500,
      packageFormat: "parcel",
      items: [{ name: "Widget", sku: "WIDGET-1", quantity: 1, unitValueGbp: "19.99" }],
    },
  ],
};

test("authenticate resolves the configured API key as the access token", async () => {
  const connector = new RoyalMailConnector(CREDENTIALS);
  const token = await connector.authenticate();
  assert.equal(token.accessToken, CREDENTIALS.clickAndDropApiKey);
});

test("authenticate throws when no Click & Drop API key is configured", async () => {
  const connector = new RoyalMailConnector({ clickAndDropApiKey: "" });
  await assert.rejects(() => connector.authenticate());
});

test("verifyConnection sends a Bearer-authorized GET /carriers", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedAuth = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
    return jsonResponse(200, [{ carrierName: "Royal Mail" }]);
  }) as typeof fetch;

  try {
    const connector = new RoyalMailConnector(CREDENTIALS);
    await connector.verifyConnection();
    assert.equal(capturedUrl, "https://api.parcel.royalmail.com/api/v1/carriers");
    assert.equal(capturedAuth, `Bearer ${CREDENTIALS.clickAndDropApiKey}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("verifyConnection throws on a bad key (non-OK response)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("Unauthorized", { status: 401 })) as typeof fetch;

  try {
    const connector = new RoyalMailConnector(CREDENTIALS);
    await assert.rejects(() => connector.verifyConnection(), /401/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createShipment sends a Bearer-authorized POST /orders with the confirmed request shape", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedAuth = "";
  let capturedBody: any;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
    capturedBody = JSON.parse(String(init?.body));
    return jsonResponse(200, {
      successCount: 1,
      errorCount: 0,
      createdOrders: [{ orderIdentifier: 123456, trackingNumber: "RM123456789GB", label: "base64-label-data" }],
    });
  }) as typeof fetch;

  try {
    const connector = new RoyalMailConnector(CREDENTIALS);
    const result = await connector.createShipment(SAMPLE_REQUEST);

    assert.equal(capturedUrl, "https://api.parcel.royalmail.com/api/v1/orders");
    assert.equal(capturedAuth, `Bearer ${CREDENTIALS.clickAndDropApiKey}`);
    assert.equal(capturedBody.items[0].orderReference, "ORDER-1");
    assert.equal(capturedBody.items[0].shippingCostCharged, "3.99");
    assert.equal(capturedBody.items[0].packages[0].weightInGrams, 500);
    assert.equal(capturedBody.items[0].packages[0].contents[0].SKU, "WIDGET-1");
    // Recipient address must be nested under `recipient.address`, using Royal
    // Mail's own real field names (`fullName`/`postcode`, not `name`/
    // `postalCode`) -- see createShipment()'s own doc comment for the real
    // production bug this corrects (Royal Mail echoed back an empty
    // `recipient: {}` when these were sent flat).
    assert.equal(capturedBody.items[0].recipient.address.fullName, SAMPLE_REQUEST.recipient.name);
    assert.equal(capturedBody.items[0].recipient.address.addressLine1, SAMPLE_REQUEST.recipient.addressLine1);
    assert.equal(capturedBody.items[0].recipient.address.city, SAMPLE_REQUEST.recipient.city);
    assert.equal(capturedBody.items[0].recipient.address.postcode, SAMPLE_REQUEST.recipient.postalCode);
    assert.equal(capturedBody.items[0].recipient.address.countryCode, SAMPLE_REQUEST.recipient.countryCode);
    // phoneNumber/emailAddress are siblings of `address`, not nested inside it.
    assert.equal(capturedBody.items[0].recipient.phoneNumber, SAMPLE_REQUEST.recipient.phone);
    assert.equal(capturedBody.items[0].recipient.emailAddress, SAMPLE_REQUEST.recipient.email);
    assert.equal(capturedBody.items[0].recipient.address.phoneNumber, undefined);
    assert.equal(capturedBody.items[0].recipient.address.emailAddress, undefined);

    assert.equal(result.carrierOrderId, "123456");
    assert.equal(result.trackingNumber, "RM123456789GB");
    assert.equal(result.labelBase64, "base64-label-data");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createShipment returns labelBase64: null when the order is created but Royal Mail reports a labelErrors split outcome", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    jsonResponse(200, {
      successCount: 1,
      errorCount: 0,
      createdOrders: [
        { orderIdentifier: 999, trackingNumber: "RM999GB", labelErrors: [{ message: "label generation failed" }] },
      ],
    })) as typeof fetch;

  try {
    const connector = new RoyalMailConnector(CREDENTIALS);
    const result = await connector.createShipment(SAMPLE_REQUEST);
    assert.equal(result.carrierOrderId, "999");
    assert.equal(result.labelBase64, null, "no `label` field on this order means labelBase64 must be null, not throw");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createShipment throws when Royal Mail reports zero created orders", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse(200, { successCount: 0, errorCount: 1, createdOrders: [] })) as typeof fetch;

  try {
    const connector = new RoyalMailConnector(CREDENTIALS);
    await assert.rejects(() => connector.createShipment(SAMPLE_REQUEST));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createShipment throws with the response body on a non-OK HTTP status", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("Invalid postageDetails.serviceCode", { status: 400 })) as typeof fetch;

  try {
    const connector = new RoyalMailConnector(CREDENTIALS);
    await assert.rejects(() => connector.createShipment(SAMPLE_REQUEST), /400/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("voidShipment sends a DELETE to /orders/{carrierOrderId}", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedMethod = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedMethod = init?.method ?? "";
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    const connector = new RoyalMailConnector(CREDENTIALS);
    await connector.voidShipment("123456");
    assert.equal(capturedUrl, "https://api.parcel.royalmail.com/api/v1/orders/123456");
    assert.equal(capturedMethod, "DELETE");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("trackShipment maps events/statusCategory/statusDescription from the confirmed response shape", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    capturedUrl = String(input);
    return jsonResponse(200, {
      mailPieces: {
        statusCategory: "DELIVERED",
        statusDescription: "Your item has been delivered",
        events: [
          { eventCode: "EVENTDELIVEREDTOADDRESSEE", eventName: "Delivered", eventDateTime: "2026-09-25T09:00:00Z", locationName: "London" },
        ],
      },
    });
  }) as typeof fetch;

  try {
    const connector = new RoyalMailConnector(CREDENTIALS);
    const result = await connector.trackShipment("RM123456789GB");
    assert.equal(capturedUrl, "https://api.royalmail.net/mailpieces/v2/RM123456789GB/events");
    assert.equal(result.statusCategory, "DELIVERED");
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]!.eventName, "Delivered");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("trackShipment throws when Tracking API credentials are not configured", async () => {
  const connector = new RoyalMailConnector({ clickAndDropApiKey: "key-only" });
  await assert.rejects(() => connector.trackShipment("RM123456789GB"));
});

test("getRateEstimate delegates to estimateRoyalMailRates (no network call)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("getRateEstimate must never call fetch -- Royal Mail has no rate-quote endpoint");
  }) as typeof fetch;

  try {
    const connector = new RoyalMailConnector(CREDENTIALS);
    const rates = await connector.getRateEstimate({ weightGrams: 500, destinationCountryCode: "GB", shipDate: "2026-06-01" });
    assert.ok(rates.length > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
