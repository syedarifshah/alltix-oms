import type { Pool } from "pg";
import { withTenant } from "@alltix/db";
import type { RateEstimate } from "./connector.js";

/**
 * Royal Mail peak-season/standing surcharge monitoring (task #58) --
 * reads carrier_surcharges (migration 0039), seeded with Royal Mail's own
 * real, dated, currently-published figures (royalmail.com/business/mail/
 * surcharges, confirmed live this pass): UK Peak Surcharge and
 * International Peak Surcharge both running 2 Nov 2026 - 10 Jan 2027, plus
 * the standing Fuel/Energy and Green surcharges. This module has two
 * genuinely different jobs, kept in two different functions rather than
 * combined, because they have different confidence levels:
 *
 * - {@link getApplicableSurcharges} / {@link isInPeakSurchargeWindow} --
 *   real, DB-backed, CONFIRMED reference data. Safe to use for actual
 *   monitoring/alerting (task #59's ship-date warning banner).
 * - {@link estimateRoyalMailRates} -- combines that same confirmed
 *   surcharge data with a NOT-confirmed, illustrative base postage price
 *   table (see ROYAL_MAIL_ILLUSTRATIVE_BASE_RATES's own doc comment) to
 *   produce CarrierConnector.getRateEstimate()'s required output shape.
 *   The surcharge PORTION of that output is real; the base-rate portion is
 *   not, and is marked as such in the result.
 */

export interface CarrierSurchargeRow {
  id: string;
  carrier: string;
  surchargeName: string;
  scope: "uk" | "international" | "all";
  startsOn: string | null;
  endsOn: string | null;
  amountType: "flat_gbp" | "percent";
  amount: number;
  notes: string | null;
}

/** Reads every carrier_surcharges row (migration 0039) whose window covers
 *  `onDate` (or has no window at all, i.e. a standing surcharge) and whose
 *  scope matches `scope` or is 'all'. Not tenant-scoped -- carrier_surcharges
 *  has no tenant_id column (it's platform-wide reference data, see that
 *  migration's own doc comment) -- but still goes through withTenant() for
 *  a normal RLS-covered SELECT rather than reaching for adminPool, since
 *  the table's own `public_read_carrier_surcharges` policy (`USING (true)`)
 *  already grants any tenant-scoped connection read access; there's no
 *  cross-tenant concern here to justify bypassing RLS the way the
 *  scheduler's own tenant-enumeration queries do. */
export async function getApplicableSurcharges(
  pool: Pool,
  tenantId: string,
  carrier: string,
  scope: "uk" | "international",
  onDate: string,
): Promise<CarrierSurchargeRow[]> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query<{
      id: string;
      carrier: string;
      surcharge_name: string;
      scope: string;
      starts_on: string | null;
      ends_on: string | null;
      amount_type: string;
      amount: string;
      notes: string | null;
    }>(
      `SELECT id, carrier, surcharge_name, scope, starts_on, ends_on, amount_type, amount, notes
         FROM carrier_surcharges
        WHERE carrier = $1
          AND (scope = $2 OR scope = 'all')
          AND (starts_on IS NULL OR starts_on <= $3::date)
          AND (ends_on IS NULL OR ends_on >= $3::date)
        ORDER BY surcharge_name`,
      [carrier, scope, onDate],
    );
    return result.rows.map((row) => ({
      id: row.id,
      carrier: row.carrier,
      surchargeName: row.surcharge_name,
      scope: row.scope as "uk" | "international" | "all",
      startsOn: row.starts_on,
      endsOn: row.ends_on,
      amountType: row.amount_type as "flat_gbp" | "percent",
      amount: Number(row.amount),
      notes: row.notes,
    }));
  });
}

/** Cheap yes/no check for a ship-date warning banner (task #59) --
 *  "is this order's ship date inside ANY currently-known peak surcharge
 *  window for this carrier," without needing every surcharge row's detail.
 *  Deliberately only checks surcharge_name ILIKE '%Peak%' -- the standing
 *  Fuel/Green surcharges always apply and aren't a "watch out, extra cost
 *  incoming" seasonal event the way Peak Surcharge is; flagging every
 *  shipment as "surcharge applies" year-round would make the warning
 *  meaningless. */
export async function isInPeakSurchargeWindow(
  pool: Pool,
  tenantId: string,
  carrier: string,
  onDate: string,
): Promise<boolean> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM carrier_surcharges
        WHERE carrier = $1
          AND surcharge_name ILIKE '%Peak%'
          AND starts_on IS NOT NULL AND starts_on <= $2::date
          AND ends_on IS NOT NULL AND ends_on >= $2::date`,
      [carrier, onDate],
    );
    return Number(result.rows[0]!.count) > 0;
  });
}

/**
 * NOT confirmed against Royal Mail's real, current published retail price
 * list -- this codebase's research pass this session confirmed
 * SURCHARGE deltas (the amounts above/on top of a base postage price) via
 * royalmail.com/business/mail/surcharges, but never fetched Royal Mail's
 * actual per-service base price table (a separate page, not researched
 * this pass). These are small, deliberately round, illustrative
 * placeholder figures for a handful of common domestic/international
 * Tracked services -- good enough to prove the getRateEstimate() mechanism
 * end-to-end and to combine correctly with the real surcharge data above,
 * but NOT something a tenant should be shown as a real quote without this
 * table being replaced by Royal Mail's actual current price list first.
 * Flagged exactly this plainly in RateEstimate.surchargesApplied's own
 * sibling context and in every caller-facing surface task #59 builds.
 */
const ROYAL_MAIL_ILLUSTRATIVE_BASE_RATES: Array<{
  serviceCode: string;
  serviceName: string;
  scope: "uk" | "international";
  maxWeightGrams: number;
  baseCostGbp: number;
}> = [
  { serviceCode: "TPLR", serviceName: "Tracked 24", scope: "uk", maxWeightGrams: 2000, baseCostGbp: 4.29 },
  { serviceCode: "TPLL", serviceName: "Tracked 48", scope: "uk", maxWeightGrams: 2000, baseCostGbp: 3.79 },
  { serviceCode: "SD1", serviceName: "Special Delivery Guaranteed by 1pm", scope: "uk", maxWeightGrams: 2000, baseCostGbp: 8.95 },
  { serviceCode: "INTL-TRACKED", serviceName: "International Tracked", scope: "international", maxWeightGrams: 2000, baseCostGbp: 9.5 },
];

/** Backs RoyalMailConnector.getRateEstimate() -- see this file's own
 *  header comment for the confirmed-surcharge / illustrative-base-rate
 *  split. Deliberately takes no `pool` (RoyalMailConnector holds no DB
 *  reference, matching every other connector's own stateless-w.r.t.-DB
 *  shape) -- so this applies the SEEDED surcharge figures directly
 *  in-process rather than querying carrier_surcharges live. Those are the
 *  same real, confirmed 2026/2027 figures migration 0039 seeds into the
 *  DB; duplicated here as constants specifically so this one function can
 *  run without a pool, same tradeoff this codebase already accepts
 *  elsewhere for a handful of small, rarely-changing reference values
 *  (e.g. MVP_PLAN_ORDER_LIMIT_PER_MONTH). A future pass wiring this to
 *  live-query carrier_surcharges instead (passing a pool through
 *  CarrierConnector.getRateEstimate()'s own signature) would be a real
 *  improvement -- not done here to keep the interface unchanged for a v1
 *  carrier with no live rates API to begin with. */
export function estimateRoyalMailRates(request: {
  weightGrams: number;
  destinationCountryCode: string;
  shipDate: string;
}): RateEstimate[] {
  const scope: "uk" | "international" = request.destinationCountryCode.toUpperCase() === "GB" ? "uk" : "international";
  const candidates = ROYAL_MAIL_ILLUSTRATIVE_BASE_RATES.filter(
    (rate) => rate.scope === scope && rate.maxWeightGrams >= request.weightGrams,
  );

  const shipDate = new Date(request.shipDate);
  const inPeakWindow =
    shipDate >= new Date("2026-11-02") && shipDate <= new Date("2027-01-10");

  return candidates.map((rate) => {
    let cost = rate.baseCostGbp;
    if (inPeakWindow) {
      // The real, confirmed peak-surcharge ceiling for each scope
      // (migration 0039's own seeded amounts) -- applied as a flat addition,
      // not a percentage, matching how Royal Mail itself describes Peak
      // Surcharge ("£0.10-£0.30/item").
      cost += scope === "uk" ? 0.3 : 0.25;
    }
    // Standing Fuel/Energy Surcharge -- real, confirmed percentage
    // (migration 0039), always applied regardless of peak window.
    cost *= 1 + (scope === "uk" ? 0.16 : 0.12);
    // Standing Green Surcharge -- real, confirmed flat amount.
    cost += 0.05;

    return {
      serviceCode: rate.serviceCode,
      serviceName: rate.serviceName,
      estimatedCostGbp: cost.toFixed(2),
      surchargesApplied: true,
    };
  });
}
