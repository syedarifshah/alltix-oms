// Regression test for the /orders "Placed At" column showing
// 1970-01-19T03:58:30.000Z for real Amazon sandbox orders. Traced the raw
// value straight from the SP-API sandbox (bypassing this connector) and
// confirmed it returns that exact PurchaseDate on every TEST_CASE_200
// order -- not something normalizeAmazonOrder, persistPulledOrders(), or
// the /orders page corrupts. parsePurchaseDate() is the guard added at
// ingestion so that implausible upstream dates become null (rendered as
// "—") instead of being stored and displayed as if they were real.
//
// Run with: npm run test --workspace=@alltix/channel-connectors

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePurchaseDate,
  AmazonConnector,
  buildCreateListingRequestBody,
  SP_API_EU_SANDBOX_BASE_URL,
  SP_API_NA_SANDBOX_BASE_URL,
  SP_API_EU_PRODUCTION_BASE_URL,
  SP_API_NA_PRODUCTION_BASE_URL,
  SP_API_FE_PRODUCTION_BASE_URL,
  type AmazonListingSubmission,
} from "../src/amazon-connector.js";

test("rejects the SP-API sandbox's own known-bad canned PurchaseDate", () => {
  assert.equal(parsePurchaseDate("1970-01-19T03:58:30Z"), null);
});

test("rejects any date before Amazon's third-party marketplace existed", () => {
  assert.equal(parsePurchaseDate("1999-12-31T23:59:59Z"), null);
});

test("rejects a non-date string", () => {
  assert.equal(parsePurchaseDate("not-a-date"), null);
});

test("accepts a real, recent-ish ISO 8601 purchase date unchanged", () => {
  const real = "2024-03-15T10:30:00.000Z";
  assert.equal(parsePurchaseDate(real), real);
});

// Regression coverage for preparing AmazonConnector for real production
// testing: isSandbox() gates every TEST_CASE_200/CreatedAfter-literal
// substitution in pullOrders()/getOrderItems()/confirmShipment(), so it
// must correctly distinguish both sandbox hosts from every production
// host -- a fake credentials object is enough here since the constructor
// makes no network call, only pullOrders()/confirmShipment() do.
const FAKE_CREDENTIALS = { clientId: "x", clientSecret: "x", refreshToken: "x", sellerId: "x" };

test("isSandbox() is true for the EU sandbox host", () => {
  assert.equal(new AmazonConnector(FAKE_CREDENTIALS, SP_API_EU_SANDBOX_BASE_URL).isSandbox(), true);
});

test("isSandbox() is true for the NA sandbox host too, not just EU", () => {
  assert.equal(new AmazonConnector(FAKE_CREDENTIALS, SP_API_NA_SANDBOX_BASE_URL).isSandbox(), true);
});

test("isSandbox() is false for every production host -- real dates and order ids must flow through unchanged", () => {
  assert.equal(new AmazonConnector(FAKE_CREDENTIALS, SP_API_EU_PRODUCTION_BASE_URL).isSandbox(), false);
  assert.equal(new AmazonConnector(FAKE_CREDENTIALS, SP_API_NA_PRODUCTION_BASE_URL).isSandbox(), false);
  assert.equal(new AmazonConnector(FAKE_CREDENTIALS, SP_API_FE_PRODUCTION_BASE_URL).isSandbox(), false);
});

// buildCreateListingRequestBody() -- pure request-body builder for
// AmazonConnector.createListing(), split out the same way
// WalmartConnector.buildMpItemMatchFeedPayload() is (see
// walmart-connector.test.ts's own tests for that function). No network, no
// live seller account required -- these tests cover the one part of
// createListing() that's genuinely provable without live credentials: the
// pure attribute-shape mapping. createListing()'s own live network call is
// unverifiable from this environment (see its class doc comment).

function makeSubmission(overrides: Partial<AmazonListingSubmission> = {}): AmazonListingSubmission {
  return {
    asin: "B00EXAMPLE1",
    sellerSku: "SKU-001",
    price: "19.99",
    quantity: 5,
    ...overrides,
  };
}

test("buildCreateListingRequestBody builds the confirmed LISTING_OFFER_ONLY envelope shape", () => {
  const body = buildCreateListingRequestBody(makeSubmission(), "ATVPDKIKX0DER");
  assert.deepEqual(body, {
    productType: "PRODUCT",
    requirements: "LISTING_OFFER_ONLY",
    attributes: {
      merchant_suggested_asin: [{ value: "B00EXAMPLE1", marketplace_id: "ATVPDKIKX0DER" }],
      condition_type: [{ value: "new_new", marketplace_id: "ATVPDKIKX0DER" }],
      purchasable_offer: [
        {
          marketplace_id: "ATVPDKIKX0DER",
          currency: "USD",
          our_price: [{ schedule: [{ value_with_tax: 19.99 }] }],
        },
      ],
      fulfillment_availability: [{ fulfillment_channel_code: "DEFAULT", quantity: 5 }],
    },
  });
});

test("buildCreateListingRequestBody defaults condition_type to 'new_new' when not supplied", () => {
  const body = buildCreateListingRequestBody(makeSubmission({ conditionType: undefined }), "ATVPDKIKX0DER");
  assert.equal(body.attributes.condition_type[0]!.value, "new_new");
});

test("buildCreateListingRequestBody honors an explicitly supplied conditionType", () => {
  const body = buildCreateListingRequestBody(makeSubmission({ conditionType: "used_like_new" }), "ATVPDKIKX0DER");
  assert.equal(body.attributes.condition_type[0]!.value, "used_like_new");
});

test("buildCreateListingRequestBody coerces the string price to a number", () => {
  const body = buildCreateListingRequestBody(makeSubmission({ price: "149.5" }), "ATVPDKIKX0DER");
  const value = body.attributes.purchasable_offer[0]!.our_price[0]!.schedule[0]!.value_with_tax;
  assert.equal(value, 149.5);
  assert.equal(typeof value, "number");
});

test("buildCreateListingRequestBody always prices in USD -- v1 scope, no marketplace-currency mapping yet", () => {
  const body = buildCreateListingRequestBody(makeSubmission(), "A1PA6795UKMFR9");
  assert.equal(body.attributes.purchasable_offer[0]!.currency, "USD");
});

test("buildCreateListingRequestBody threads the given marketplaceId into every attribute that needs one", () => {
  const body = buildCreateListingRequestBody(makeSubmission(), "A1PA6795UKMFR9");
  assert.equal(body.attributes.merchant_suggested_asin[0]!.marketplace_id, "A1PA6795UKMFR9");
  assert.equal(body.attributes.condition_type[0]!.marketplace_id, "A1PA6795UKMFR9");
  assert.equal(body.attributes.purchasable_offer[0]!.marketplace_id, "A1PA6795UKMFR9");
});

test("buildCreateListingRequestBody sets fulfillment_availability to the MFN/'DEFAULT' channel only, same as pushInventory()", () => {
  const body = buildCreateListingRequestBody(makeSubmission({ quantity: 42 }), "ATVPDKIKX0DER");
  assert.deepEqual(body.attributes.fulfillment_availability, [{ fulfillment_channel_code: "DEFAULT", quantity: 42 }]);
});
