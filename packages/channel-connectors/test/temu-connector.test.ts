// Pure-function unit tests for the Temu connector's signing algorithm and
// order/line-item mapping logic -- no network, no real Temu credentials of
// any kind exist anywhere in this codebase yet (see temu-connector.ts's own
// header comment for the full research trail). Same split as every other
// connector's own test file in this package: this covers the parts that
// are genuinely provable without live credentials.
//
// Run with: npm run test --workspace=@alltix/channel-connectors

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  buildTemuSignature,
  buildTemuRequestBody,
  normalizeTemuOrder,
  normalizeTemuOrderLine,
  parseTemuProductId,
  type TemuCredentials,
  type TemuOrder,
  type TemuOrderLine,
} from "../src/temu-connector.js";

const CREDENTIALS: TemuCredentials = {
  appKey: "test-app-key",
  appSecret: "test-app-secret",
  accessToken: "test-access-token",
};

test("buildTemuSignature sorts params alphabetically before concatenating", () => {
  // Same key/value pair set, given in two different orders -- the
  // signature must come out identical either way, since _get_sign() sorts
  // before concatenating (utils/base_client.py, confirmed from the real
  // installed SDK source).
  const a = buildTemuSignature({ b: "2", a: "1" }, "secret");
  const b = buildTemuSignature({ a: "1", b: "2" }, "secret");
  assert.equal(a, b);
});

test("buildTemuSignature matches a manually-computed MD5 for a known input", () => {
  // Reproduces _get_sign()'s exact algorithm by hand: sort keys
  // alphabetically (app_key, timestamp, type), concat key+value pairs with
  // no separator, wrap with the secret on both sides, MD5, uppercase hex.
  const params = { type: "bg.order.list.v2.get", app_key: "k", timestamp: 1700000000 };
  const sortedConcat = "app_keyktimestamp1700000000typebg.order.list.v2.get";
  const manual = crypto.createHash("md5").update(`secret${sortedConcat}secret`, "utf8").digest("hex").toUpperCase();
  assert.equal(buildTemuSignature(params, "secret"), manual);
});

test("buildTemuSignature strips spaces from the concatenated string before hashing", () => {
  const withSpaces = buildTemuSignature({ a: "has space" }, "secret");
  const withoutSpaces = crypto.createHash("md5").update("secretahasspacesecret", "utf8").digest("hex").toUpperCase();
  assert.equal(withSpaces, withoutSpaces);
});

test("buildTemuSignature is deterministic for the same input", () => {
  const params = { foo: "bar", baz: 42 };
  assert.equal(buildTemuSignature(params, "secret"), buildTemuSignature(params, "secret"));
});

test("buildTemuSignature produces a different signature for a different app secret", () => {
  const params = { foo: "bar" };
  assert.notEqual(buildTemuSignature(params, "secret-one"), buildTemuSignature(params, "secret-two"));
});

test("buildTemuRequestBody includes type/app_key/access_token/data_type and a computed sign", () => {
  const body = buildTemuRequestBody("bg.order.list.v2.get", CREDENTIALS, { pageNumber: 1 });
  assert.equal(body.type, "bg.order.list.v2.get");
  assert.equal(body.app_key, CREDENTIALS.appKey);
  assert.equal(body.access_token, CREDENTIALS.accessToken);
  assert.equal(body.data_type, "JSON");
  assert.equal(body.pageNumber, 1);
  assert.equal(typeof body.timestamp, "number");
  assert.equal(typeof body.sign, "string");
  assert.equal((body.sign as string).length, 32); // MD5 hex digest length
});

test("buildTemuRequestBody omits null/undefined extra params from the signed body (filter_none)", () => {
  const body = buildTemuRequestBody("bg.order.detail.v2.get", CREDENTIALS, {
    parentOrderSn: "P1",
    fulfillmentTypeList: undefined,
    someOtherField: null,
  });
  assert.equal(body.parentOrderSn, "P1");
  assert.equal("fulfillmentTypeList" in body, false);
  assert.equal("someOtherField" in body, false);
});

test("buildTemuRequestBody's sign changes if any signed field changes", () => {
  const a = buildTemuRequestBody("bg.order.list.v2.get", CREDENTIALS, { pageNumber: 1 });
  const b = buildTemuRequestBody("bg.order.list.v2.get", CREDENTIALS, { pageNumber: 2 });
  assert.notEqual(a.sign, b.sign);
});

test("parseTemuProductId splits a well-formed compound id", () => {
  assert.deepEqual(parseTemuProductId("goods-1:sku-1"), { goodsId: "goods-1", skuId: "sku-1" });
});

test("parseTemuProductId throws on a productId with no colon", () => {
  assert.throws(() => parseTemuProductId("no-colon-here"), /must be "<goodsId>:<skuId>"/);
});

test("parseTemuProductId throws on an empty goodsId or skuId", () => {
  assert.throws(() => parseTemuProductId(":sku-only"));
  assert.throws(() => parseTemuProductId("goods-only:"));
});

function makeOrderLine(overrides: Partial<TemuOrderLine> = {}): TemuOrderLine {
  return {
    orderSn: "SUB-1",
    goodsId: "G1",
    skuId: "SKU-1",
    quantity: 2,
    goodsName: "Test Product",
    currencyPrice: "9.99",
    ...overrides,
  };
}

test("normalizeTemuOrderLine maps quantity/price/sku straight through", () => {
  const normalized = normalizeTemuOrderLine(makeOrderLine());
  assert.equal(normalized.quantity, 2);
  assert.equal(normalized.unitPrice, "9.99");
  assert.equal(normalized.externalSku, "SKU-1");
  assert.equal(normalized.externalLineId, "SUB-1");
  assert.equal(normalized.fulfillmentType, "seller_fulfilled");
});

test("normalizeTemuOrderLine defaults unitPrice to 0.00 when currencyPrice is absent", () => {
  const normalized = normalizeTemuOrderLine(makeOrderLine({ currencyPrice: undefined }));
  assert.equal(normalized.unitPrice, "0.00");
});

test("normalizeTemuOrderLine defaults quantity to 0 when quantity is not a number", () => {
  const normalized = normalizeTemuOrderLine(makeOrderLine({ quantity: undefined }));
  assert.equal(normalized.quantity, 0);
});

test("normalizeTemuOrderLine falls back to skuId for externalLineId when orderSn is absent", () => {
  const normalized = normalizeTemuOrderLine(makeOrderLine({ orderSn: undefined, skuId: "SKU-ONLY" }));
  assert.equal(normalized.externalLineId, "SKU-ONLY");
});

function makeOrderHeader(overrides: Partial<TemuOrder> = {}): TemuOrder {
  return {
    parentOrderSn: "PARENT-1",
    parentOrderStatus: 1,
    createTime: 1700000000,
    regionId: 211,
    ...overrides,
  };
}

test("normalizeTemuOrder maps parentOrderSn/channel/placedAt/channelStatus and nests normalized lines", () => {
  const normalized = normalizeTemuOrder(makeOrderHeader(), [makeOrderLine()]);
  assert.equal(normalized.externalOrderId, "PARENT-1");
  assert.equal(normalized.channel, "temu");
  assert.equal(normalized.channelMarketplace, "");
  assert.equal(normalized.placedAt, new Date(1700000000 * 1000).toISOString());
  assert.equal(normalized.channelStatus, "1");
  assert.equal(normalized.lines.length, 1);
  assert.equal(normalized.lines[0]!.externalSku, "SKU-1");
});

test("normalizeTemuOrder leaves shippingAddress empty (bg.order.shippinginfo.v2.get is not called in v1)", () => {
  const normalized = normalizeTemuOrder(makeOrderHeader(), []);
  assert.deepEqual(normalized.shippingAddress, {});
});

test("normalizeTemuOrder sets placedAt to null when createTime is absent", () => {
  const normalized = normalizeTemuOrder(makeOrderHeader({ createTime: undefined }), []);
  assert.equal(normalized.placedAt, null);
});

test("normalizeTemuOrder preserves both header and lines in rawPayload", () => {
  const header = makeOrderHeader();
  const lines = [makeOrderLine()];
  const normalized = normalizeTemuOrder(header, lines);
  assert.deepEqual(normalized.rawPayload, { header, lines });
});
