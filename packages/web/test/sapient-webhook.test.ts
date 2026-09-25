// Pure-logic coverage for src/lib/sapient-webhook.ts -- no DB, no network.
// Same "extract the pure decision, test it directly" precedent
// channel-flags.test.ts/reorder-threshold.test.ts already set, applied here
// to a payload shape that (see sapient-webhook.ts's own header comment) was
// never independently confirmed against a literal Sapient example -- these
// tests exist to prove the DEFENSIVE parsing itself behaves as designed
// (several candidate field names tried, nested wrapper scopes searched,
// dates validated rather than passed through raw), not to assert a single
// "correct" Sapient payload shape that was never actually confirmed.
//
// Run with: npm run test:sapient-webhook --workspace=@alltix/web

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSapientTrackingWebhookPayload,
  buildSapientTrackingIdempotencyKey,
  type ParsedSapientTrackingEvent,
} from "../src/lib/sapient-webhook.js";

// Every case below that parses a single event asserts the array has exactly
// one entry first, so this non-null assertion is never masking a real
// out-of-bounds read -- just working around TS's own noUncaughtIndexedAccess
// not knowing that.
function parseOne(body: unknown): ParsedSapientTrackingEvent {
  const events = parseSapientTrackingWebhookPayload(body);
  assert.equal(events.length, 1);
  return events[0]!;
}

test("recognizes Sapient's own confirmed PascalCase field names at the top level", () => {
  const event = parseOne({
    TrackingNumber: "TRK123",
    ShipmentId: "SHIP456",
    EventCode: "DELV",
    Milestone: "DELIVERED",
    Description: "Delivered to recipient",
    Location: "London Depot",
    EventDateTime: "2026-09-20T10:30:00Z",
  });
  assert.equal(event.trackingNumber, "TRK123");
  assert.equal(event.shipmentId, "SHIP456");
  assert.equal(event.eventCode, "DELV");
  assert.equal(event.milestone, "DELIVERED");
  assert.equal(event.description, "Delivered to recipient");
  assert.equal(event.location, "London Depot");
  assert.equal(event.occurredAt, new Date("2026-09-20T10:30:00Z").toISOString());
});

test("falls back to camelCase and synonym field names when PascalCase isn't present", () => {
  const event = parseOne({
    consignmentNumber: "CONS789",
    shipmentNumber: "SHIPNUM1",
    statusCode: "PSDE",
    milestoneName: "OUT FOR DELIVERY",
    statusDescription: "Out for delivery",
    depotName: "Manchester Depot",
    eventDate: "2026-09-21T08:00:00Z",
  });
  assert.equal(event.trackingNumber, "CONS789");
  assert.equal(event.shipmentId, "SHIPNUM1");
  assert.equal(event.eventCode, "PSDE");
  assert.equal(event.milestone, "OUT FOR DELIVERY");
  assert.equal(event.description, "Out for delivery");
  assert.equal(event.location, "Manchester Depot");
  assert.equal(event.occurredAt, new Date("2026-09-21T08:00:00Z").toISOString());
});

test("reads fields nested under a candidate wrapper key when not present at the top level", () => {
  const event = parseOne({
    Tracking: {
      TrackingNumber: "TRK-NESTED",
      Milestone: "IN TRANSIT",
    },
  });
  assert.equal(event.trackingNumber, "TRK-NESTED");
  assert.equal(event.milestone, "IN TRANSIT");
});

test("a top-level field wins over the same field name found in a nested wrapper scope", () => {
  const event = parseOne({
    TrackingNumber: "TOP-LEVEL",
    Tracking: {
      TrackingNumber: "NESTED-LOSES",
    },
  });
  assert.equal(event.trackingNumber, "TOP-LEVEL");
});

test("tries every candidate wrapper key, not just the first", () => {
  const event = parseOne({
    data: {
      trackingNumber: "FOUND-IN-DATA",
    },
  });
  assert.equal(event.trackingNumber, "FOUND-IN-DATA");
});

test("handles a bare JSON array of events", () => {
  const events = parseSapientTrackingWebhookPayload([
    { TrackingNumber: "A1", Milestone: "COLLECTED" },
    { TrackingNumber: "A2", Milestone: "DELIVERED" },
  ]);
  assert.equal(events.length, 2);
  assert.equal(events[0]!.trackingNumber, "A1");
  assert.equal(events[1]!.trackingNumber, "A2");
});

test("handles a single event object with no wrapper at all", () => {
  const events = parseSapientTrackingWebhookPayload({ TrackingNumber: "SOLO" });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.trackingNumber, "SOLO");
});

test("handles an object whose events live under a recognized list key", () => {
  const events = parseSapientTrackingWebhookPayload({
    Events: [{ TrackingNumber: "L1" }, { TrackingNumber: "L2" }, { TrackingNumber: "L3" }],
  });
  assert.equal(events.length, 3);
  assert.deepEqual(
    events.map((e) => e.trackingNumber),
    ["L1", "L2", "L3"],
  );
});

test("falls back to treating the body as a single event when a list key is present but empty", () => {
  const events = parseSapientTrackingWebhookPayload({
    Events: [],
    TrackingNumber: "FALLBACK-SOLO",
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.trackingNumber, "FALLBACK-SOLO");
});

test("an unparseable date comes back null, never the raw unparsed string", () => {
  const event = parseOne({
    TrackingNumber: "TRK1",
    EventDateTime: "not-a-real-date",
  });
  assert.equal(event.occurredAt, null);
});

test("a field this parser doesn't recognize at all comes back null, not guessed", () => {
  const event = parseOne({
    SomeUnrelatedField: "whatever",
  });
  assert.equal(event.trackingNumber, null);
  assert.equal(event.shipmentId, null);
  assert.equal(event.eventCode, null);
  assert.equal(event.milestone, null);
  assert.equal(event.description, null);
  assert.equal(event.location, null);
  assert.equal(event.occurredAt, null);
});

test("a completely non-object, non-array body parses to an empty list", () => {
  assert.deepEqual(parseSapientTrackingWebhookPayload("just a string"), []);
  assert.deepEqual(parseSapientTrackingWebhookPayload(null), []);
  assert.deepEqual(parseSapientTrackingWebhookPayload(42), []);
});

test("a numeric field value is coerced to its string form", () => {
  const event = parseOne({ TrackingNumber: 123456 });
  assert.equal(event.trackingNumber, "123456");
});

test("a blank/whitespace-only string field is treated as absent, not as an empty value", () => {
  const event = parseOne({ TrackingNumber: "   " });
  assert.equal(event.trackingNumber, null);
});

test("idempotency key: identical events build identical keys", () => {
  const event: ParsedSapientTrackingEvent = {
    trackingNumber: "TRK1",
    shipmentId: null,
    eventCode: "DELV",
    milestone: "DELIVERED",
    description: null,
    location: null,
    occurredAt: "2026-09-20T10:30:00.000Z",
  };
  const key1 = buildSapientTrackingIdempotencyKey("shipment-uuid-1", event);
  const key2 = buildSapientTrackingIdempotencyKey("shipment-uuid-1", { ...event });
  assert.equal(key1, key2);
});

test("idempotency key: a different shipment id changes the key", () => {
  const event: ParsedSapientTrackingEvent = {
    trackingNumber: "TRK1",
    shipmentId: null,
    eventCode: "DELV",
    milestone: null,
    description: null,
    location: null,
    occurredAt: "2026-09-20T10:30:00.000Z",
  };
  const keyA = buildSapientTrackingIdempotencyKey("shipment-uuid-A", event);
  const keyB = buildSapientTrackingIdempotencyKey("shipment-uuid-B", event);
  assert.notEqual(keyA, keyB);
});

test("idempotency key: falls back through eventCode -> milestone -> description -> 'unknown-event'", () => {
  const withCode = buildSapientTrackingIdempotencyKey("s1", {
    trackingNumber: null,
    shipmentId: null,
    eventCode: "DELV",
    milestone: "DELIVERED",
    description: "Delivered",
    location: null,
    occurredAt: null,
  });
  assert.match(withCode, /:DELV:/);

  const withMilestoneOnly = buildSapientTrackingIdempotencyKey("s1", {
    trackingNumber: null,
    shipmentId: null,
    eventCode: null,
    milestone: "DELIVERED",
    description: "Delivered",
    location: null,
    occurredAt: null,
  });
  assert.match(withMilestoneOnly, /:DELIVERED:/);

  const withDescriptionOnly = buildSapientTrackingIdempotencyKey("s1", {
    trackingNumber: null,
    shipmentId: null,
    eventCode: null,
    milestone: null,
    description: "Delivered to recipient",
    location: null,
    occurredAt: null,
  });
  assert.match(withDescriptionOnly, /:Delivered to recipient:/);

  const withNothing = buildSapientTrackingIdempotencyKey("s1", {
    trackingNumber: null,
    shipmentId: null,
    eventCode: null,
    milestone: null,
    description: null,
    location: null,
    occurredAt: null,
  });
  assert.match(withNothing, /:unknown-event:/);
});

test("idempotency key: a missing occurredAt falls back to 'no-timestamp', still producing a usable key", () => {
  const key = buildSapientTrackingIdempotencyKey("shipment-uuid-1", {
    trackingNumber: null,
    shipmentId: null,
    eventCode: "DELV",
    milestone: null,
    description: null,
    location: null,
    occurredAt: null,
  });
  assert.equal(key, "sapient-tracking:shipment-uuid-1:DELV:no-timestamp");
});
