// Fetch-intercepted unit tests for FedExConnector -- no real FedEx
// credentials exist anywhere in this codebase yet (see fedex-connector.ts's
// own class doc comment for the full CONFIRMED/INFERRED research trail --
// the best-sourced carrier connector in this codebase so far, including a
// live rate-quote endpoint neither Royal Mail nor Evri has). Same
// "stub globalThis.fetch, restore in finally" discipline every other
// connector test file in this codebase already uses.
//
// Run with: npm run test --workspace=@alltix/carrier-connectors

import { test } from "node:test";
import assert from "node:assert/strict";
import { FedExConnector, type FedExCredentials } from "../src/fedex-connector.js";
import type { CreateShipmentRequest } from "../src/connector.js";

const CREDENTIALS: FedExCredentials = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  accountNumber: "510087780",
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
      assert.equal(String(input), "https://apis.fedex.com/oauth/token");
      return jsonResponse(200, { access_token: "fedex-token-abc", token_type: "bearer", expires_in: 3600, scope: "CXS" });
    }
    return handler(input, init);
  }) as typeof fetch;
}

test("authenticate exchanges client_id/client_secret via a form-urlencoded client_credentials request", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody = "";
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = String(init?.body);
    return jsonResponse(200, { access_token: "fedex-token-abc", token_type: "bearer", expires_in: 3600, scope: "CXS" });
  }) as typeof fetch;

  try {
    const connector = new FedExConnector(CREDENTIALS);
    const token = await connector.authenticate();
    const params = new URLSearchParams(capturedBody);
    assert.equal(params.get("grant_type"), "client_credentials");
    assert.equal(params.get("client_id"), "test-client-id");
    assert.equal(params.get("client_secret"), "test-client-secret");
    assert.equal(token.accessToken, "fedex-token-abc");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authenticate caches the token and does not re-request until near expiry", async () => {
  const originalFetch = globalThis.fetch;
  let tokenCalls = 0;
  globalThis.fetch = (async () => {
    tokenCalls += 1;
    return jsonResponse(200, { access_token: "fedex-token-abc", token_type: "bearer", expires_in: 3600 });
  }) as typeof fetch;

  try {
    const connector = new FedExConnector(CREDENTIALS);
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
    const connector = new FedExConnector(CREDENTIALS);
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
    return jsonResponse(200, { access_token: "fedex-token-abc", token_type: "bearer", expires_in: 3600 });
  }) as typeof fetch;

  try {
    const connector = new FedExConnector(CREDENTIALS);
    await connector.authenticate();
    await connector.verifyConnection();
    assert.equal(tokenCalls, 2, "verifyConnection must not reuse a cached token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createShipment sends a Bearer-authorized POST /ship/v1/shipments with the confirmed request shape", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedAuth = "";
  let capturedBody: any;
  globalThis.fetch = stubTokenThenOnce(async (input, init) => {
    capturedUrl = String(input);
    capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
    capturedBody = JSON.parse(String(init?.body));
    return jsonResponse(200, {
      output: {
        transactionShipments: [
          {
            masterTrackingNumber: "794658252052",
            pieceResponses: [
              { trackingNumber: "794658252052", packageDocuments: [{ url: "https://labels.fedex.com/abc.pdf" }] },
            ],
          },
        ],
      },
    });
  });

  try {
    const connector = new FedExConnector(CREDENTIALS);
    const result = await connector.createShipment(SAMPLE_REQUEST);

    assert.equal(capturedUrl, "https://apis.fedex.com/ship/v1/shipments");
    assert.equal(capturedAuth, "Bearer fedex-token-abc");
    assert.equal(capturedBody.accountNumber.value, "510087780");
    assert.equal(capturedBody.requestedShipment.recipients[0].address.postalCode, "SW1A 1AA");
    assert.equal(capturedBody.requestedShipment.shippingChargesPayment.paymentType, "SENDER");
    assert.equal(capturedBody.requestedShipment.labelSpecification.imageType, "PDF");
    assert.equal(capturedBody.requestedShipment.requestedPackageLineItems[0].weight.value, 0.5);

    assert.equal(result.carrierOrderId, "794658252052");
    assert.equal(result.trackingNumber, "794658252052");
    assert.equal(result.labelBase64, "https://labels.fedex.com/abc.pdf");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createShipment throws when FedEx reports errors on the response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubTokenThenOnce(async () => jsonResponse(200, { errors: [{ code: "SHIP.ACCOUNT.NUMBER.MISSING", message: "Missing account number" }] }));

  try {
    const connector = new FedExConnector(CREDENTIALS);
    await assert.rejects(() => connector.createShipment(SAMPLE_REQUEST), /Missing account number/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createShipment throws when no transactionShipments/trackingNumber is found in the response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubTokenThenOnce(async () => jsonResponse(200, { output: { transactionShipments: [] } }));

  try {
    const connector = new FedExConnector(CREDENTIALS);
    await assert.rejects(() => connector.createShipment(SAMPLE_REQUEST));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createShipment throws with the response body on a non-OK HTTP status", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubTokenThenOnce(async () => new Response("Invalid requestedShipment", { status: 400 }));

  try {
    const connector = new FedExConnector(CREDENTIALS);
    await assert.rejects(() => connector.createShipment(SAMPLE_REQUEST), /400/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("FedExConnector has no voidShipment -- no confirmed cancel-shipment endpoint was found", () => {
  const connector = new FedExConnector(CREDENTIALS);
  assert.equal(connector.voidShipment, undefined);
});

test("trackShipment posts the confirmed request shape to /track/v1/trackingnumbers and maps scan events", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedBody: any;
  globalThis.fetch = stubTokenThenOnce(async (input, init) => {
    capturedUrl = String(input);
    capturedBody = JSON.parse(String(init?.body));
    return jsonResponse(200, {
      output: {
        completeTrackResults: [
          {
            trackResults: [
              {
                latestStatusDetail: { code: "DL", description: "Delivered" },
                scanEvents: [
                  { eventType: "DL", eventDescription: "Delivered", date: "2026-09-25T09:00:00Z", scanLocation: { city: "London" } },
                ],
              },
            ],
          },
        ],
      },
    });
  });

  try {
    const connector = new FedExConnector(CREDENTIALS);
    const result = await connector.trackShipment("794658252052");
    assert.equal(capturedUrl, "https://apis.fedex.com/track/v1/trackingnumbers");
    assert.deepEqual(capturedBody, { trackingInfo: [{ trackingNumberInfo: { trackingNumber: "794658252052" } }] });
    assert.equal(result.statusCategory, "DL");
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]!.eventName, "Delivered");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getRateEstimate makes a real live POST /rate/v1/rates/quotes call, unlike Royal Mail/Evri", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  globalThis.fetch = stubTokenThenOnce(async (input) => {
    capturedUrl = String(input);
    return jsonResponse(200, {
      output: {
        rateReplyDetails: [
          {
            serviceType: "FEDEX_GROUND",
            serviceName: "FedEx Ground",
            ratedShipmentDetails: [{ totalNetCharge: { amount: 12.5, currency: "GBP" } }],
          },
        ],
      },
    });
  });

  try {
    const connector = new FedExConnector(CREDENTIALS);
    const rates = await connector.getRateEstimate({ weightGrams: 500, destinationCountryCode: "GB", shipDate: "2026-06-01" });
    assert.equal(capturedUrl, "https://apis.fedex.com/rate/v1/rates/quotes");
    assert.equal(rates.length, 1);
    assert.equal(rates[0]!.serviceCode, "FEDEX_GROUND");
    assert.equal(rates[0]!.estimatedCostGbp, "12.50");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getRateEstimate throws when FedEx reports errors on the response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubTokenThenOnce(async () => jsonResponse(200, { errors: [{ code: "RATE.INVALID", message: "Invalid rate request" }] }));

  try {
    const connector = new FedExConnector(CREDENTIALS);
    await assert.rejects(
      () => connector.getRateEstimate({ weightGrams: 500, destinationCountryCode: "GB", shipDate: "2026-06-01" }),
      /Invalid rate request/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
