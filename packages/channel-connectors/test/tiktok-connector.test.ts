// Pure-function unit tests for the TikTok Shop connector's signing algorithm
// and order/line-item mapping logic -- no network, no real TikTok credentials
// of any kind exist anywhere in this codebase yet (see tiktok-connector.ts's
// own header comment for the full research trail). Same split as every other
// connector's own test file in this package: this covers the parts that are
// genuinely provable without live credentials.
//
// Run with: npm run test --workspace=@alltix/channel-connectors

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  buildTikTokSignature,
  normalizeTikTokOrder,
  normalizeTikTokOrderLine,
  parseTikTokProductId,
  type TikTokOrder,
  type TikTokOrderLine,
} from "../src/tiktok-connector.js";

test("buildTikTokSignature sorts params alphabetically before concatenating", () => {
  const a = buildTikTokSignature("/order/202309/orders/search", { b: "2", a: "1" }, "secret");
  const b = buildTikTokSignature("/order/202309/orders/search", { a: "1", b: "2" }, "secret");
  assert.equal(a, b);
});

test("buildTikTokSignature matches a manually-computed HMAC-SHA256 for a known input", () => {
  // Reproduces the openlinker spike's own described algorithm by hand: sort
  // keys alphabetically, concat key+value with no separator, prepend the
  // path, wrap with the secret on both sides, HMAC-SHA256 keyed with the
  // secret, lowercase hex.
  const path = "/order/202309/orders/search";
  const params = { timestamp: 1700000000, app_key: "k" };
  const sortedConcat = "app_keyktimestamp1700000000";
  const toSign = `${path}${sortedConcat}`;
  const manual = crypto.createHmac("sha256", "secret").update(`secret${toSign}secret`, "utf8").digest("hex");
  assert.equal(buildTikTokSignature(path, params, "secret"), manual);
});

test("buildTikTokSignature includes the request body when provided", () => {
  const withBody = buildTikTokSignature("/order/202309/orders/search", { a: "1" }, "secret", '{"x":1}');
  const withoutBody = buildTikTokSignature("/order/202309/orders/search", { a: "1" }, "secret");
  assert.notEqual(withBody, withoutBody);
});

test("buildTikTokSignature skips array-valued params entirely", () => {
  const withArray = buildTikTokSignature("/order/202309/orders/search", { a: "1", ids: ["x", "y"] }, "secret");
  const withoutArray = buildTikTokSignature("/order/202309/orders/search", { a: "1" }, "secret");
  assert.equal(withArray, withoutArray);
});

test("buildTikTokSignature is deterministic for the same input", () => {
  const params = { foo: "bar", baz: 42 };
  assert.equal(buildTikTokSignature("/p", params, "secret"), buildTikTokSignature("/p", params, "secret"));
});

test("buildTikTokSignature produces a different signature for a different path", () => {
  const params = { foo: "bar" };
  assert.notEqual(buildTikTokSignature("/order/202309/orders/search", params, "secret"), buildTikTokSignature("/order/202309/orders", params, "secret"));
});

test("buildTikTokSignature produces a different signature for a different app secret", () => {
  const params = { foo: "bar" };
  assert.notEqual(buildTikTokSignature("/p", params, "secret-one"), buildTikTokSignature("/p", params, "secret-two"));
});

test("parseTikTokProductId splits a well-formed compound id", () => {
  assert.deepEqual(parseTikTokProductId("prod-1:sku-1"), { productId: "prod-1", skuId: "sku-1" });
});

test("parseTikTokProductId throws on a productId with no colon", () => {
  assert.throws(() => parseTikTokProductId("no-colon-here"), /must be "<productId>:<skuId>"/);
});

test("parseTikTokProductId throws on an empty productId or skuId", () => {
  assert.throws(() => parseTikTokProductId(":sku-only"));
  assert.throws(() => parseTikTokProductId("product-only:"));
});

function makeOrderLine(overrides: Partial<TikTokOrderLine> = {}): TikTokOrderLine {
  return {
    id: "LINE-1",
    seller_sku: "SKU-1",
    sku_id: "TT-SKU-1",
    product_name: "Test Product",
    sale_price: "9.99",
    quantity: 2,
    ...overrides,
  };
}

test("normalizeTikTokOrderLine maps quantity/price/sku straight through", () => {
  const normalized = normalizeTikTokOrderLine(makeOrderLine());
  assert.equal(normalized.quantity, 2);
  assert.equal(normalized.unitPrice, "9.99");
  assert.equal(normalized.externalSku, "SKU-1");
  assert.equal(normalized.externalLineId, "LINE-1");
  assert.equal(normalized.fulfillmentType, "seller_fulfilled");
});

test("normalizeTikTokOrderLine defaults unitPrice to 0.00 when sale_price is absent", () => {
  const normalized = normalizeTikTokOrderLine(makeOrderLine({ sale_price: undefined }));
  assert.equal(normalized.unitPrice, "0.00");
});

test("normalizeTikTokOrderLine defaults quantity to 0 when quantity is not a number", () => {
  const normalized = normalizeTikTokOrderLine(makeOrderLine({ quantity: undefined }));
  assert.equal(normalized.quantity, 0);
});

test("normalizeTikTokOrderLine falls back to sku_id for externalSku when seller_sku is absent", () => {
  const normalized = normalizeTikTokOrderLine(makeOrderLine({ seller_sku: undefined, sku_id: "TT-ONLY" }));
  assert.equal(normalized.externalSku, "TT-ONLY");
});

test("normalizeTikTokOrderLine falls back to sku_id for externalLineId when id is absent", () => {
  const normalized = normalizeTikTokOrderLine(makeOrderLine({ id: undefined, sku_id: "TT-ONLY" }));
  assert.equal(normalized.externalLineId, "TT-ONLY");
});

function makeOrder(overrides: Partial<TikTokOrder> = {}): TikTokOrder {
  return {
    id: "ORDER-1",
    status: "AWAITING_SHIPMENT",
    create_time: 1700000000,
    line_items: [makeOrderLine()],
    ...overrides,
  };
}

test("normalizeTikTokOrder maps id/channel/placedAt/channelStatus and nests normalized lines", () => {
  const normalized = normalizeTikTokOrder(makeOrder());
  assert.equal(normalized.externalOrderId, "ORDER-1");
  assert.equal(normalized.channel, "tiktok");
  assert.equal(normalized.channelMarketplace, "");
  assert.equal(normalized.placedAt, new Date(1700000000 * 1000).toISOString());
  assert.equal(normalized.channelStatus, "AWAITING_SHIPMENT");
  assert.equal(normalized.lines.length, 1);
  assert.equal(normalized.lines[0]!.externalSku, "SKU-1");
});

test("normalizeTikTokOrder sets placedAt to null when create_time is absent", () => {
  const normalized = normalizeTikTokOrder(makeOrder({ create_time: undefined }));
  assert.equal(normalized.placedAt, null);
});

test("normalizeTikTokOrder defaults shippingAddress to {} when recipient_address is absent", () => {
  const normalized = normalizeTikTokOrder(makeOrder({ recipient_address: undefined }));
  assert.deepEqual(normalized.shippingAddress, {});
});

test("normalizeTikTokOrder passes recipient_address through unmapped when present", () => {
  const normalized = normalizeTikTokOrder(makeOrder({ recipient_address: { zipcode: "10001" } }));
  assert.deepEqual(normalized.shippingAddress, { zipcode: "10001" });
});

test("normalizeTikTokOrder defaults lines to [] when line_items is absent", () => {
  const normalized = normalizeTikTokOrder(makeOrder({ line_items: undefined }));
  assert.deepEqual(normalized.lines, []);
});

test("normalizeTikTokOrder preserves the whole order in rawPayload", () => {
  const order = makeOrder();
  const normalized = normalizeTikTokOrder(order);
  assert.deepEqual(normalized.rawPayload, order);
});
