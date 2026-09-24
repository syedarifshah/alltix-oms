// Pure-function unit tests for estimateRoyalMailRates() -- no network, no
// DB. getApplicableSurcharges()/isInPeakSurchargeWindow() are DB-backed
// (withTenant against real Postgres) and are not covered here -- same
// "pure-function-first" split every other connector test file in this
// codebase already uses (e.g. temu-connector.test.ts's own header comment).
//
// Run with: npm run test --workspace=@alltix/carrier-connectors

import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateRoyalMailRates } from "../src/surcharges.js";

test("estimateRoyalMailRates returns only UK services for a GB destination", () => {
  const rates = estimateRoyalMailRates({ weightGrams: 500, destinationCountryCode: "GB", shipDate: "2026-06-01" });
  assert.ok(rates.length > 0);
  for (const rate of rates) {
    assert.ok(!rate.serviceName.toLowerCase().includes("international"));
  }
});

test("estimateRoyalMailRates returns only international services for a non-GB destination", () => {
  const rates = estimateRoyalMailRates({ weightGrams: 500, destinationCountryCode: "US", shipDate: "2026-06-01" });
  assert.ok(rates.length > 0);
  for (const rate of rates) {
    assert.ok(rate.serviceName.toLowerCase().includes("international"));
  }
});

test("estimateRoyalMailRates excludes services whose max weight is exceeded", () => {
  const rates = estimateRoyalMailRates({ weightGrams: 50000, destinationCountryCode: "GB", shipDate: "2026-06-01" });
  assert.deepEqual(rates, []);
});

test("estimateRoyalMailRates applies the UK peak surcharge inside the confirmed 2026/2027 window", () => {
  const outsidePeak = estimateRoyalMailRates({ weightGrams: 500, destinationCountryCode: "GB", shipDate: "2026-06-01" });
  const insidePeak = estimateRoyalMailRates({ weightGrams: 500, destinationCountryCode: "GB", shipDate: "2026-12-01" });
  const outsideCost = Number(outsidePeak.find((r) => r.serviceCode === "TPLR")!.estimatedCostGbp);
  const insideCost = Number(insidePeak.find((r) => r.serviceCode === "TPLR")!.estimatedCostGbp);
  assert.ok(insideCost > outsideCost, `expected peak cost (${insideCost}) > off-peak cost (${outsideCost})`);
});

test("estimateRoyalMailRates never applies the peak surcharge outside the confirmed window", () => {
  const beforePeak = estimateRoyalMailRates({ weightGrams: 500, destinationCountryCode: "GB", shipDate: "2026-11-01" });
  const afterPeak = estimateRoyalMailRates({ weightGrams: 500, destinationCountryCode: "GB", shipDate: "2027-01-11" });
  const inPeak = estimateRoyalMailRates({ weightGrams: 500, destinationCountryCode: "GB", shipDate: "2026-11-02" });
  const before = Number(beforePeak.find((r) => r.serviceCode === "TPLR")!.estimatedCostGbp);
  const after = Number(afterPeak.find((r) => r.serviceCode === "TPLR")!.estimatedCostGbp);
  const inside = Number(inPeak.find((r) => r.serviceCode === "TPLR")!.estimatedCostGbp);
  assert.equal(before, after);
  assert.ok(inside > before);
});

test("estimateRoyalMailRates marks every result as surchargesApplied", () => {
  const rates = estimateRoyalMailRates({ weightGrams: 500, destinationCountryCode: "GB", shipDate: "2026-06-01" });
  for (const rate of rates) {
    assert.equal(rate.surchargesApplied, true);
  }
});
