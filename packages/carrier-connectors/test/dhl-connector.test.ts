// Fetch-intercepted unit tests for DhlConnector -- no real DHL Express
// MyDHL API key/secret/account number or Unified Tracking API key exists
// anywhere in this codebase yet (see dhl-connector.ts's own class doc
// comment for the full CONFIRMED/INFERRED research trail, including the
// three-way request-shape discrepancy this connector had to resolve for
// createShipment()). Same "stub globalThis.fetch, restore in finally"
// discipline every other connector test file in this codebase already
// uses. Unlike FedEx/UPS/Evri, DHL's own MyDHL API has no OAuth token
// exchange -- authenticate() makes no network call at all (a static
// Basic-auth pair applied directly to every request), so there is no
// "stub the token call, then the real one" two-step helper needed here,
// mirroring ParcelforceConnector's own test file for the same underlying
// reason.
//
// Run with: npm run test --workspace=@alltix/carrier-connectors

import { test } from "node:test";
import assert from "node:assert/strict";
import { DhlConnector, type DhlCredentials } from "../src/dhl-connector.js";
import type { CreateShipmentRequest } from "../src/connector.js";

const CREDENTIALS: DhlCredentials = {
  apiKey: "test-api-key",
  apiSecret: "test-api-secret",
  accountNumber: "123456789",
};

const CREDENTIALS_WITH_TRACKING: DhlCredentials = {
  ...CREDENTIALS,
  trackingApiKey: "test-tracking-api-key",
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

test("authenticate throws when apiKey/apiSecret/accountNumber are not all present", async () => {
  const connector = new DhlConnector({ apiKey: "", apiSecret: "s", accountNumber: "1" });
  await assert.rejects(() => connector.authenticate(), /apiKey, apiSecret, and accountNumber are all required/);
});

test("authenticate makes no network call -- a static Basic-auth pair, not a token exchange", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("authenticate() should never call fetch");
  }) as typeof fetch;

  try {
    const connector = new DhlConnector(CREDENTIALS);
    const token = await connector.authenticate();
    assert.equal(fetchCalls, 0);
    assert.equal(token.accessToken, "test-api-key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("verifyConnection sends a Basic-authorized POST /rates and treats 401/403 as rejected credentials", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedAuth = "";
  let capturedVersion = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    const headers = init?.headers as Record<string, string>;
    capturedAuth = headers?.Authorization ?? "";
    capturedVersion = headers?.["x-version"] ?? "";
    return new Response("Unauthorized", { status: 401 });
  }) as typeof fetch;

  try {
    const connector = new DhlConnector(CREDENTIALS);
    await assert.rejects(() => connector.verifyConnection(), /DHL credentials rejected: 401/);
    assert.equal(capturedUrl, "https://express.api.dhl.com/mydhlapi/rates");
    assert.equal(capturedAuth, `Basic ${Buffer.from("test-api-key:test-api-secret").toString("base64")}`);
    assert.equal(capturedVersion, "3.3.2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("verifyConnection does not throw on a non-401/403 status (DHL evaluated the credentials before rejecting the request shape)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("Bad request shape", { status: 400 })) as typeof fetch;

  try {
    const connector = new DhlConnector(CREDENTIALS);
    await connector.verifyConnection();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createShipment sends a Basic-authorized POST /shipments with the confirmed nested request shape", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedAuth = "";
  let capturedBody: any;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
    capturedBody = JSON.parse(String(init?.body));
    return jsonResponse(200, {
      shipmentTrackingNumber: "00340434292135100188",
      documents: [{ typeCode: "label", content: "base64-label-data", imageFormat: "PDF" }],
    });
  }) as typeof fetch;

  try {
    const connector = new DhlConnector(CREDENTIALS);
    const result = await connector.createShipment(SAMPLE_REQUEST);

    assert.equal(capturedUrl, "https://express.api.dhl.com/mydhlapi/shipments");
    assert.equal(capturedAuth, `Basic ${Buffer.from("test-api-key:test-api-secret").toString("base64")}`);
    assert.equal(capturedBody.accounts[0].number, "123456789");
    assert.equal(capturedBody.customerDetails.receiverDetails.postalAddress.postalCode, "SW1A 1AA");
    assert.equal(capturedBody.customerDetails.receiverDetails.contactInformation.fullName, "Jane Doe");
    assert.equal(capturedBody.content.packages[0].weight, 0.5);
    assert.equal(capturedBody.productCode, "N");

    assert.equal(result.carrierOrderId, "00340434292135100188");
    assert.equal(result.trackingNumber, "00340434292135100188");
    assert.equal(result.labelBase64, "base64-label-data");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createShipment throws when no shipmentTrackingNumber/trackingNumber is found in the response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse(200, {})) as typeof fetch;

  try {
    const connector = new DhlConnector(CREDENTIALS);
    await assert.rejects(() => connector.createShipment(SAMPLE_REQUEST), /no shipmentTrackingNumber found/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createShipment throws with the response body on a non-OK HTTP status (DHL's own problem+json shape)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    jsonResponse(400, { title: "Bad Request", detail: "The shipment could not be created due to invalid input." })) as typeof fetch;

  try {
    const connector = new DhlConnector(CREDENTIALS);
    await assert.rejects(() => connector.createShipment(SAMPLE_REQUEST), /DHL API error \(400\)/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DhlConnector has no voidShipment -- CONFIRMED DHL Express has no true label-void endpoint", () => {
  const connector = new DhlConnector(CREDENTIALS);
  assert.equal(connector.voidShipment, undefined);
});

test("trackShipment throws a clear error when trackingApiKey is not configured", async () => {
  const connector = new DhlConnector(CREDENTIALS);
  await assert.rejects(() => connector.trackShipment("00340434292135100188"), /no Unified Tracking API key configured/);
});

test("trackShipment GETs the separate api-eu.dhl.com host with a DHL-API-Key header and maps events", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedMethod = "";
  let capturedApiKey = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedMethod = String(init?.method);
    capturedApiKey = (init?.headers as Record<string, string>)?.["DHL-API-Key"] ?? "";
    return jsonResponse(200, {
      shipments: [
        {
          status: { statusCode: "delivered", description: "Delivered" },
          events: [
            {
              statusCode: "delivered",
              description: "Delivered",
              timestamp: "2026-09-25T09:00:00Z",
              location: { address: { addressLocality: "London" } },
            },
          ],
        },
      ],
    });
  }) as typeof fetch;

  try {
    const connector = new DhlConnector(CREDENTIALS_WITH_TRACKING);
    const result = await connector.trackShipment("00340434292135100188");
    assert.equal(
      capturedUrl,
      "https://api-eu.dhl.com/track/shipments?trackingNumber=00340434292135100188",
    );
    assert.equal(capturedMethod, "GET");
    assert.equal(capturedApiKey, "test-tracking-api-key");
    assert.equal(result.statusCategory, "delivered");
    assert.equal(result.statusDescription, "Delivered");
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]!.eventName, "Delivered");
    assert.equal(result.events[0]!.locationName, "London");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("trackShipment throws with the response body on a non-OK HTTP status", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("Not Found", { status: 404 })) as typeof fetch;

  try {
    const connector = new DhlConnector(CREDENTIALS_WITH_TRACKING);
    await assert.rejects(() => connector.trackShipment("unknown-number"), /DHL Tracking API error \(404\)/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getRateEstimate makes a real live POST /rates call, like FedEx and UPS and unlike Royal Mail/Evri/Parcelforce", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    capturedUrl = String(input);
    return jsonResponse(200, {
      products: [{ productName: "EXPRESS WORLDWIDE", productCode: "P", totalPrice: [{ price: 24.5, priceCurrency: "GBP" }] }],
    });
  }) as typeof fetch;

  try {
    const connector = new DhlConnector(CREDENTIALS);
    const rates = await connector.getRateEstimate({ weightGrams: 500, destinationCountryCode: "GB", shipDate: "2026-06-01" });
    assert.equal(capturedUrl, "https://express.api.dhl.com/mydhlapi/rates");
    assert.equal(rates.length, 1);
    assert.equal(rates[0]!.serviceCode, "P");
    assert.equal(rates[0]!.estimatedCostGbp, "24.50");
    assert.equal(rates[0]!.surchargesApplied, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getRateEstimate throws with the response body on a non-OK HTTP status", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse(400, { title: "Bad Request", detail: "Invalid rate request" })) as typeof fetch;

  try {
    const connector = new DhlConnector(CREDENTIALS);
    await assert.rejects(
      () => connector.getRateEstimate({ weightGrams: 500, destinationCountryCode: "GB", shipDate: "2026-06-01" }),
      /DHL API error \(400\)/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
