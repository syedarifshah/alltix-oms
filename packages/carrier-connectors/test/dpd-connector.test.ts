// Fetch-intercepted unit tests for DpdConnector -- no real Sapient/DPD
// credentials exist anywhere in this codebase yet (see dpd-connector.ts's own
// class doc comment for the full CONFIRMED/INFERRED research trail: this
// connector integrates via the Sapient/Intersoft CORE API gateway -- the
// same gateway EvriConnector already uses -- not DPD UK's own real but
// undocumented direct API). Closely mirrors evri-connector.test.ts's own
// structure, since DpdConnector's implementation is a close structural
// mirror of EvriConnector's. Same "stub globalThis.fetch, restore in
// finally" discipline every other connector test file in this codebase
// already uses.
//
// Run with: npm run test --workspace=@alltix/carrier-connectors

import { test } from "node:test";
import assert from "node:assert/strict";
import { DpdConnector, type DpdCredentials } from "../src/dpd-connector.js";
import type { CreateShipmentRequest } from "../src/connector.js";

const CREDENTIALS: DpdCredentials = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
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

function stubTokenThenOnce(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  let call = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    call += 1;
    if (call === 1) {
      assert.equal(String(input), "https://authentication.intersoftsapient.net/connect/token");
      return jsonResponse(200, { access_token: "sapient-token-abc", expires_in: 3600, token_type: "Bearer" });
    }
    return handler(input, init);
  }) as typeof fetch;
}

test("authenticate exchanges client_id/client_secret via HTTP Basic auth for a bearer token", async () => {
  const originalFetch = globalThis.fetch;
  let capturedAuth = "";
  let capturedBody = "";
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
    capturedBody = String(init?.body);
    return jsonResponse(200, { access_token: "sapient-token-abc", expires_in: 3600, token_type: "Bearer" });
  }) as typeof fetch;

  try {
    const connector = new DpdConnector(CREDENTIALS);
    const token = await connector.authenticate();
    const expectedBasic = Buffer.from(`${CREDENTIALS.clientId}:${CREDENTIALS.clientSecret}`).toString("base64");
    assert.equal(capturedAuth, `Basic ${expectedBasic}`);
    assert.equal(capturedBody, "grant_type=client_credentials");
    assert.equal(token.accessToken, "sapient-token-abc");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authenticate caches the token and does not re-request until near expiry", async () => {
  const originalFetch = globalThis.fetch;
  let tokenCalls = 0;
  globalThis.fetch = (async () => {
    tokenCalls += 1;
    return jsonResponse(200, { access_token: "sapient-token-abc", expires_in: 3600, token_type: "Bearer" });
  }) as typeof fetch;

  try {
    const connector = new DpdConnector(CREDENTIALS);
    await connector.authenticate();
    await connector.authenticate();
    assert.equal(tokenCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authenticate throws on a non-OK token response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("invalid_client", { status: 401 })) as typeof fetch;

  try {
    const connector = new DpdConnector(CREDENTIALS);
    await assert.rejects(() => connector.authenticate(), /401/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("verifyConnection forces a fresh token exchange", async () => {
  const originalFetch = globalThis.fetch;
  let tokenCalls = 0;
  globalThis.fetch = (async () => {
    tokenCalls += 1;
    return jsonResponse(200, { access_token: "sapient-token-abc", expires_in: 3600, token_type: "Bearer" });
  }) as typeof fetch;

  try {
    const connector = new DpdConnector(CREDENTIALS);
    await connector.authenticate();
    await connector.verifyConnection();
    assert.equal(tokenCalls, 2, "verifyConnection must not reuse a cached token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createShipment sends a Bearer-authorized POST /v4/shipments/dpduk with the confirmed top-level shape", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedAuth = "";
  let capturedBody: any;
  globalThis.fetch = stubTokenThenOnce(async (input, init) => {
    capturedUrl = String(input);
    capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
    capturedBody = JSON.parse(String(init?.body));
    return jsonResponse(200, {
      ShipmentId: "SAP-98765",
      TrackingNumber: "DPD123456789GB",
      Label: "base64-label-data",
    });
  });

  try {
    const connector = new DpdConnector(CREDENTIALS);
    const result = await connector.createShipment(SAMPLE_REQUEST);

    assert.equal(capturedUrl, "https://api.intersoftsapient.net/v4/shipments/dpduk");
    assert.equal(capturedAuth, "Bearer sapient-token-abc");
    assert.equal(capturedBody.ShipmentInformation.Action, "Process");
    assert.equal(capturedBody.ShipmentInformation.Reference, "ORDER-1");
    assert.equal(capturedBody.Destination.PostalCode, "SW1A 1AA");
    assert.equal(capturedBody.Packages[0].Weight, 500);
    assert.equal(capturedBody.Packages[0].Items[0].SKU, "WIDGET-1");

    assert.equal(result.carrierOrderId, "SAP-98765");
    assert.equal(result.trackingNumber, "DPD123456789GB");
    assert.equal(result.labelBase64, "base64-label-data");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createShipment throws when Sapient reports Errors on the response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubTokenThenOnce(async () => jsonResponse(200, { Errors: [{ message: "Invalid postcode" }] }));

  try {
    const connector = new DpdConnector(CREDENTIALS);
    await assert.rejects(() => connector.createShipment(SAMPLE_REQUEST), /Invalid postcode/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createShipment throws when no shipment id is found in the response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubTokenThenOnce(async () => jsonResponse(200, {}));

  try {
    const connector = new DpdConnector(CREDENTIALS);
    await assert.rejects(() => connector.createShipment(SAMPLE_REQUEST));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createShipment throws with the response body on a non-OK HTTP status", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubTokenThenOnce(async () => new Response("Invalid ShipmentInformation", { status: 400 }));

  try {
    const connector = new DpdConnector(CREDENTIALS);
    await assert.rejects(() => connector.createShipment(SAMPLE_REQUEST), /400/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DpdConnector has no voidShipment -- not every carrier's API supports cancellation the same way", () => {
  const connector = new DpdConnector(CREDENTIALS);
  assert.equal(connector.voidShipment, undefined);
});

test("trackShipment posts to /v4/trackings and maps the matching entry", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedBody: any;
  globalThis.fetch = stubTokenThenOnce(async (input, init) => {
    capturedUrl = String(input);
    capturedBody = JSON.parse(String(init?.body));
    return jsonResponse(200, {
      TrackingNumbers: [{ TrackingNumber: "DPD123456789GB", ShipmentId: "SAP-98765", Status: "Delivered" }],
    });
  });

  try {
    const connector = new DpdConnector(CREDENTIALS);
    const result = await connector.trackShipment("DPD123456789GB");
    assert.equal(capturedUrl, "https://api.intersoftsapient.net/v4/trackings");
    assert.deepEqual(capturedBody, { TrackingNumbers: ["DPD123456789GB"] });
    assert.equal(result.statusCategory, "Delivered");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getRateEstimate returns an empty list -- no confirmed DPD/Sapient surcharge or base-price data exists", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("getRateEstimate must never call fetch -- no live Sapient rate-quote endpoint was found");
  }) as typeof fetch;

  try {
    const connector = new DpdConnector(CREDENTIALS);
    const rates = await connector.getRateEstimate({ weightGrams: 500, destinationCountryCode: "GB", shipDate: "2026-06-01" });
    assert.deepEqual(rates, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
