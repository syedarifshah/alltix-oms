// Fetch-intercepted unit tests for ParcelforceConnector -- no real
// Parcelforce expressLink credentials exist anywhere in this codebase yet
// (see parcelforce-connector.ts's own class doc comment for the full
// CONFIRMED/INFERRED research trail: this is the first SOAP/XML, not
// REST/JSON, connector in this codebase's carrier/channel layer). Same
// "stub globalThis.fetch, restore in finally" discipline every other
// connector test file here already uses (e.g. evri-connector.test.ts).
//
// Responses are plain XML strings -- there is no XML-building test helper
// in this codebase to mirror jsonResponse()'s own JSON.stringify shortcut,
// so each test builds its own minimal SOAP-envelope-shaped XML string
// directly, matching what ParcelforceConnector's own xmlTag/xmlTagAny are
// built to read.
//
// Run with: npm run test --workspace=@alltix/carrier-connectors

import { test } from "node:test";
import assert from "node:assert/strict";
import { ParcelforceConnector, type ParcelforceCredentials } from "../src/parcelforce-connector.js";
import type { CreateShipmentRequest } from "../src/connector.js";

const CREDENTIALS: ParcelforceCredentials = {
  username: "test-username",
  password: "test-password",
  contractNumber: "1234567",
};

function xmlResponse(status: number, xml: string): Response {
  return new Response(xml, { status, headers: { "Content-Type": "text/xml; charset=utf-8" } });
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

test("authenticate returns a non-expiring token without ever calling fetch -- expressLink has no separate token endpoint", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("authenticate must never call fetch -- credentials travel in each request's own Authentication node");
  }) as typeof fetch;

  try {
    const connector = new ParcelforceConnector(CREDENTIALS);
    const token = await connector.authenticate();
    assert.equal(token.accessToken, "test-username");
    assert.equal(token.expiresAt, "9999-12-31T23:59:59Z");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authenticate throws when any of username/password/contractNumber is missing", async () => {
  const connector = new ParcelforceConnector({ username: "", password: "test-password", contractNumber: "1234567" });
  await assert.rejects(() => connector.authenticate(), /missing expressLink username\/password\/contract number/);
});

test("verifyConnection POSTs a Find SOAP request with the Authentication node and no fault", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};
  let capturedBody = "";
  globalThis.fetch = (async (input, init) => {
    capturedUrl = String(input);
    capturedHeaders = (init?.headers as Record<string, string>) ?? {};
    capturedBody = String(init?.body);
    return xmlResponse(
      200,
      `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><ns:FindReply/></soapenv:Body></soapenv:Envelope>`,
    );
  }) as typeof fetch;

  try {
    const connector = new ParcelforceConnector(CREDENTIALS);
    await connector.verifyConnection();
    assert.equal(capturedUrl, "https://expresslink-test.parcelforce.net/ws/");
    assert.equal(capturedHeaders.SOAPAction, "Find");
    assert.match(capturedBody, /<ns:FindRequest>/);
    assert.match(capturedBody, /<ns:UserName>test-username<\/ns:UserName>/);
    assert.match(capturedBody, /<ns:Password>test-password<\/ns:Password>/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("verifyConnection throws on a SOAP fault even with a 200 HTTP status", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    xmlResponse(
      200,
      `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><soapenv:Fault><faultstring>Authentication failed</faultstring></soapenv:Fault></soapenv:Body></soapenv:Envelope>`,
    )) as typeof fetch;

  try {
    const connector = new ParcelforceConnector(CREDENTIALS);
    await assert.rejects(() => connector.verifyConnection(), /Authentication failed/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("verifyConnection throws with the response body on a non-OK HTTP status", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => xmlResponse(500, "Internal Server Error")) as typeof fetch;

  try {
    const connector = new ParcelforceConnector(CREDENTIALS);
    await assert.rejects(() => connector.verifyConnection(), /500/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createShipment sends a createShipment SOAP request with the confirmed/inferred Consignment fields", async () => {
  const originalFetch = globalThis.fetch;
  let capturedHeaders: Record<string, string> = {};
  let capturedBody = "";
  globalThis.fetch = (async (_input, init) => {
    capturedHeaders = (init?.headers as Record<string, string>) ?? {};
    capturedBody = String(init?.body);
    return xmlResponse(
      200,
      `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>
        <ns:createShipmentReply>
          <ns:ShipmentNumber>PF123456789</ns:ShipmentNumber>
          <ns:TrackingNumber>PF987654321GB</ns:TrackingNumber>
          <ns:Label>base64-label-data</ns:Label>
        </ns:createShipmentReply>
      </soapenv:Body></soapenv:Envelope>`,
    );
  }) as typeof fetch;

  try {
    const connector = new ParcelforceConnector(CREDENTIALS);
    const result = await connector.createShipment(SAMPLE_REQUEST);

    assert.equal(capturedHeaders.SOAPAction, "createShipment");
    assert.match(capturedBody, /<ns:ContractNumber>1234567<\/ns:ContractNumber>/);
    assert.match(capturedBody, /<ns:DepartmentId>1<\/ns:DepartmentId>/);
    assert.match(capturedBody, /<ns:Reference>ORDER-1<\/ns:Reference>/);
    assert.match(capturedBody, /<ns:ServiceCode>Express24<\/ns:ServiceCode>/);
    assert.match(capturedBody, /<ns:TotalWeight>0\.500<\/ns:TotalWeight>/);
    assert.match(capturedBody, /<ns:PostalCode>SW1A 1AA<\/ns:PostalCode>/);

    assert.equal(result.carrierOrderId, "PF123456789");
    assert.equal(result.trackingNumber, "PF987654321GB");
    assert.equal(result.labelBase64, "base64-label-data");
    // raw preserves the actual response XML text, not a parsed object --
    // unlike every other connector's own JSON `raw`, so a real UAT run can
    // reveal the true response shape without re-deriving it from scratch.
    assert.match(String(result.raw), /ShipmentNumber/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createShipment passes through a tenant-supplied serviceCode instead of the Express24 default", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody = "";
  globalThis.fetch = (async (_input, init) => {
    capturedBody = String(init?.body);
    return xmlResponse(200, `<ns:createShipmentReply><ns:ShipmentNumber>PF1</ns:ShipmentNumber></ns:createShipmentReply>`);
  }) as typeof fetch;

  try {
    const connector = new ParcelforceConnector(CREDENTIALS);
    await connector.createShipment({ ...SAMPLE_REQUEST, serviceCode: "Express9" });
    assert.match(capturedBody, /<ns:ServiceCode>Express9<\/ns:ServiceCode>/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createShipment throws when no shipment/tracking identifier is found in the response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => xmlResponse(200, `<ns:createShipmentReply></ns:createShipmentReply>`)) as typeof fetch;

  try {
    const connector = new ParcelforceConnector(CREDENTIALS);
    await assert.rejects(() => connector.createShipment(SAMPLE_REQUEST), /no shipment\/tracking identifier found/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createShipment falls back to ShipmentNumber as the tracking number when no distinct TrackingNumber tag is present", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    xmlResponse(200, `<ns:createShipmentReply><ns:ShipmentNumber>PF123456789</ns:ShipmentNumber></ns:createShipmentReply>`)) as typeof fetch;

  try {
    const connector = new ParcelforceConnector(CREDENTIALS);
    const result = await connector.createShipment(SAMPLE_REQUEST);
    assert.equal(result.carrierOrderId, "PF123456789");
    assert.equal(result.trackingNumber, "PF123456789");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createShipment throws a SOAP fault error even with the fault nested under a Body element", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    xmlResponse(
      200,
      `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><soapenv:Fault><faultstring>Invalid postcode</faultstring></soapenv:Fault></soapenv:Body></soapenv:Envelope>`,
    )) as typeof fetch;

  try {
    const connector = new ParcelforceConnector(CREDENTIALS);
    await assert.rejects(() => connector.createShipment(SAMPLE_REQUEST), /Invalid postcode/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("voidShipment POSTs a CancelShipment SOAP request keyed on ShipmentNumber", async () => {
  const originalFetch = globalThis.fetch;
  let capturedHeaders: Record<string, string> = {};
  let capturedBody = "";
  globalThis.fetch = (async (_input, init) => {
    capturedHeaders = (init?.headers as Record<string, string>) ?? {};
    capturedBody = String(init?.body);
    return xmlResponse(200, `<ns:CancelShipmentReply/>`);
  }) as typeof fetch;

  try {
    const connector = new ParcelforceConnector(CREDENTIALS);
    await connector.voidShipment("PF123456789");
    assert.equal(capturedHeaders.SOAPAction, "CancelShipment");
    assert.match(capturedBody, /<ns:ShipmentNumber>PF123456789<\/ns:ShipmentNumber>/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ParcelforceConnector implements voidShipment, unlike EvriConnector", () => {
  const connector = new ParcelforceConnector(CREDENTIALS);
  assert.equal(typeof connector.voidShipment, "function");
});

test("trackShipment POSTs a Find SOAP request and reads status defensively", async () => {
  const originalFetch = globalThis.fetch;
  let capturedHeaders: Record<string, string> = {};
  let capturedBody = "";
  globalThis.fetch = (async (_input, init) => {
    capturedHeaders = (init?.headers as Record<string, string>) ?? {};
    capturedBody = String(init?.body);
    return xmlResponse(200, `<ns:FindReply><ns:Status>Delivered</ns:Status><ns:StatusDescription>Delivered to recipient</ns:StatusDescription></ns:FindReply>`);
  }) as typeof fetch;

  try {
    const connector = new ParcelforceConnector(CREDENTIALS);
    const result = await connector.trackShipment("PF987654321GB");
    assert.equal(capturedHeaders.SOAPAction, "Find");
    assert.match(capturedBody, /<ns:ShipmentNumber>PF987654321GB<\/ns:ShipmentNumber>/);
    assert.equal(result.statusCategory, "Delivered");
    assert.equal(result.statusDescription, "Delivered to recipient");
    assert.deepEqual(result.events, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("trackShipment defaults to 'unknown'/'' when no status tags are present in the response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => xmlResponse(200, `<ns:FindReply></ns:FindReply>`)) as typeof fetch;

  try {
    const connector = new ParcelforceConnector(CREDENTIALS);
    const result = await connector.trackShipment("PF987654321GB");
    assert.equal(result.statusCategory, "unknown");
    assert.equal(result.statusDescription, "");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getRateEstimate returns an empty list -- no live rate-shopping operation exists and no confirmed Parcelforce surcharge/base-price data exists", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("getRateEstimate must never call fetch -- no live expressLink rate-quote operation was found");
  }) as typeof fetch;

  try {
    const connector = new ParcelforceConnector(CREDENTIALS);
    const rates = await connector.getRateEstimate({ weightGrams: 500, destinationCountryCode: "GB", shipDate: "2026-06-01" });
    assert.deepEqual(rates, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
