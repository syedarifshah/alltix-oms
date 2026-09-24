// Fetch-intercepted unit tests for UpsConnector -- no real UPS credentials
// exist anywhere in this codebase yet (see ups-connector.ts's own class doc
// comment for the full CONFIRMED/INFERRED research trail -- the
// best-SOURCED carrier connector in this codebase's layer so far, built
// directly off UPS's own public OpenAPI spec repo). Same "stub
// globalThis.fetch, restore in finally" discipline every other connector
// test file in this codebase already uses.
//
// Run with: npm run test --workspace=@alltix/carrier-connectors

import { test } from "node:test";
import assert from "node:assert/strict";
import { UpsConnector, type UpsCredentials } from "../src/ups-connector.js";
import type { CreateShipmentRequest } from "../src/connector.js";

const CREDENTIALS: UpsCredentials = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  accountNumber: "A1B2C3",
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
      assert.equal(String(input), "https://onlinetools.ups.com/security/v1/oauth/token");
      return jsonResponse(200, {
        token_type: "Bearer",
        access_token: "ups-token-abc",
        expires_in: "3600",
        issued_at: "1758700000000",
        client_id: "test-client-id",
        scope: "default",
        refresh_count: "0",
        status: "approved",
      });
    }
    return handler(input, init);
  }) as typeof fetch;
}

test("authenticate exchanges credentials via HTTP Basic auth and a client_credentials body", async () => {
  const originalFetch = globalThis.fetch;
  let capturedAuth = "";
  let capturedBody = "";
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
    capturedBody = String(init?.body);
    return jsonResponse(200, { token_type: "Bearer", access_token: "ups-token-abc", expires_in: "3600" });
  }) as typeof fetch;

  try {
    const connector = new UpsConnector(CREDENTIALS);
    const token = await connector.authenticate();
    assert.equal(capturedAuth, `Basic ${Buffer.from("test-client-id:test-client-secret").toString("base64")}`);
    const params = new URLSearchParams(capturedBody);
    assert.equal(params.get("grant_type"), "client_credentials");
    assert.equal(token.accessToken, "ups-token-abc");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authenticate caches the token and does not re-request until near expiry", async () => {
  const originalFetch = globalThis.fetch;
  let tokenCalls = 0;
  globalThis.fetch = (async () => {
    tokenCalls += 1;
    return jsonResponse(200, { token_type: "Bearer", access_token: "ups-token-abc", expires_in: "3600" });
  }) as typeof fetch;

  try {
    const connector = new UpsConnector(CREDENTIALS);
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
    const connector = new UpsConnector(CREDENTIALS);
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
    return jsonResponse(200, { token_type: "Bearer", access_token: "ups-token-abc", expires_in: "3600" });
  }) as typeof fetch;

  try {
    const connector = new UpsConnector(CREDENTIALS);
    await connector.authenticate();
    await connector.verifyConnection();
    assert.equal(tokenCalls, 2, "verifyConnection must not reuse a cached token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createShipment sends a Bearer-authorized POST /api/shipments/v2409/ship with the confirmed request shape", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedAuth = "";
  let capturedBody: any;
  globalThis.fetch = stubTokenThenOnce(async (input, init) => {
    capturedUrl = String(input);
    capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
    capturedBody = JSON.parse(String(init?.body));
    return jsonResponse(200, {
      ShipmentResponse: {
        ShipmentResults: {
          ShipmentIdentificationNumber: "1Z12345E0205271688",
          PackageResults: { TrackingNumber: "1Z12345E0205271688", ShippingLabel: { GraphicImage: "base64-label-data" } },
        },
      },
    });
  });

  try {
    const connector = new UpsConnector(CREDENTIALS);
    const result = await connector.createShipment(SAMPLE_REQUEST);

    assert.equal(capturedUrl, "https://onlinetools.ups.com/api/shipments/v2409/ship");
    assert.equal(capturedAuth, "Bearer ups-token-abc");
    assert.equal(capturedBody.ShipmentRequest.Shipment.Shipper.ShipperNumber, "A1B2C3");
    assert.equal(capturedBody.ShipmentRequest.Shipment.ShipTo.Address.PostalCode, "SW1A 1AA");
    assert.equal(capturedBody.ShipmentRequest.Shipment.PaymentInformation.ShipmentCharge.BillShipper.AccountNumber, "A1B2C3");
    assert.equal(capturedBody.ShipmentRequest.Shipment.Package[0].PackageWeight.Weight, "0.50");

    assert.equal(result.carrierOrderId, "1Z12345E0205271688");
    assert.equal(result.trackingNumber, "1Z12345E0205271688");
    assert.equal(result.labelBase64, "base64-label-data");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createShipment throws when UPS reports errors on the response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubTokenThenOnce(async () =>
    jsonResponse(200, { ShipmentResponse: { Response: { Errors: [{ Code: "120600", Description: "Missing ship-to postal code" }] } } }),
  );

  try {
    const connector = new UpsConnector(CREDENTIALS);
    await assert.rejects(() => connector.createShipment(SAMPLE_REQUEST), /Missing ship-to postal code/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createShipment throws when no ShipmentResults/ShipmentIdentificationNumber is found in the response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubTokenThenOnce(async () => jsonResponse(200, { ShipmentResponse: {} }));

  try {
    const connector = new UpsConnector(CREDENTIALS);
    await assert.rejects(() => connector.createShipment(SAMPLE_REQUEST));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createShipment throws with the response body on a non-OK HTTP status", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubTokenThenOnce(async () => new Response("Invalid ShipmentRequest", { status: 400 }));

  try {
    const connector = new UpsConnector(CREDENTIALS);
    await assert.rejects(() => connector.createShipment(SAMPLE_REQUEST), /400/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("voidShipment sends a DELETE to /api/shipments/v1/void/cancel/{id}", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedMethod = "";
  globalThis.fetch = stubTokenThenOnce(async (input, init) => {
    capturedUrl = String(input);
    capturedMethod = String(init?.method);
    return jsonResponse(200, { VoidShipmentResponse: { Response: { ResponseStatus: { Code: "1" } } } });
  });

  try {
    const connector = new UpsConnector(CREDENTIALS);
    await connector.voidShipment("1Z12345E0205271688");
    assert.equal(capturedUrl, "https://onlinetools.ups.com/api/shipments/v1/void/cancel/1Z12345E0205271688");
    assert.equal(capturedMethod, "DELETE");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("trackShipment GETs /api/track/v1/details/{inquiryNumber} and maps activity events", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedMethod = "";
  globalThis.fetch = stubTokenThenOnce(async (input, init) => {
    capturedUrl = String(input);
    capturedMethod = String(init?.method);
    return jsonResponse(200, {
      trackResponse: {
        shipment: [
          {
            package: [
              {
                currentStatus: { statusCode: "DEL", statusDescription: "Delivered" },
                activity: [
                  { status: { type: "D", description: "Delivered" }, location: { address: { city: "London" } }, date: "20260925", time: "090000" },
                ],
              },
            ],
          },
        ],
      },
    });
  });

  try {
    const connector = new UpsConnector(CREDENTIALS);
    const result = await connector.trackShipment("1Z12345E0205271688");
    assert.equal(capturedUrl, "https://onlinetools.ups.com/api/track/v1/details/1Z12345E0205271688");
    assert.equal(capturedMethod, "GET");
    assert.equal(result.statusCategory, "DEL");
    assert.equal(result.statusDescription, "Delivered");
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]!.eventName, "Delivered");
    assert.equal(result.events[0]!.locationName, "London");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getRateEstimate makes a real live POST /api/rating/v2409/Shop call, like FedEx and unlike Royal Mail/Evri/Parcelforce", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  globalThis.fetch = stubTokenThenOnce(async (input) => {
    capturedUrl = String(input);
    return jsonResponse(200, {
      RateResponse: {
        RatedShipment: [{ Service: { Code: "03", Description: "UPS Ground" }, TotalCharges: { MonetaryValue: "12.50", CurrencyCode: "GBP" } }],
      },
    });
  });

  try {
    const connector = new UpsConnector(CREDENTIALS);
    const rates = await connector.getRateEstimate({ weightGrams: 500, destinationCountryCode: "GB", shipDate: "2026-06-01" });
    assert.equal(capturedUrl, "https://onlinetools.ups.com/api/rating/v2409/Shop");
    assert.equal(rates.length, 1);
    assert.equal(rates[0]!.serviceCode, "03");
    assert.equal(rates[0]!.estimatedCostGbp, "12.50");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getRateEstimate throws when UPS reports errors on the response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubTokenThenOnce(async () =>
    jsonResponse(200, { RateResponse: { Response: { Errors: [{ Code: "111210", Description: "Invalid rate request" }] } } }),
  );

  try {
    const connector = new UpsConnector(CREDENTIALS);
    await assert.rejects(
      () => connector.getRateEstimate({ weightGrams: 500, destinationCountryCode: "GB", shipDate: "2026-06-01" }),
      /Invalid rate request/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
