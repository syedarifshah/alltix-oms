// Shared between /inventory's settings form (bounds for the number input)
// and /api/inventory/reorder-threshold's own validation -- kept in lockstep
// with migrations/0031_tenants_reorder_threshold_days.sql's CHECK constraint
// (1-365), the same "app-layer check as defense-in-depth, never rely on one
// layer alone" principle CLAUDE.md §6 applies to tenant isolation, applied
// here to input validation instead.
export const MIN_REORDER_THRESHOLD_DAYS = 1;
export const MAX_REORDER_THRESHOLD_DAYS = 365;

/**
 * Parses a tenant-submitted reorder-threshold form value. Returns null for
 * anything that isn't a whole number of days within [MIN, MAX] -- a blank
 * field, a decimal, a negative number, zero, or something absurdly large
 * (guarding against fat-fingering a value that would make every in-stock
 * product read as "reorder soon" forever, or never). Pure, no DB, so it's
 * unit-testable directly without a live Postgres -- same "extract the pure
 * decision, test it directly" precedent extractUsShippingZip/
 * rankByDistanceToShippingZip already set in
 * packages/order-service/src/index.ts.
 */
export function parseReorderThresholdDays(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) {
    return null;
  }
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < MIN_REORDER_THRESHOLD_DAYS || value > MAX_REORDER_THRESHOLD_DAYS) {
    return null;
  }
  return value;
}
