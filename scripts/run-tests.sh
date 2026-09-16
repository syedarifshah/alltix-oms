#!/usr/bin/env bash
# Runs the test suite against a live Postgres (npm run db:migrate first).
# Test files are run one at a time (not node --test's default per-file
# parallelism) so concurrency-focused tests -- allocation-concurrency,
# assign-picklist-concurrency -- each get the DB connection pool to
# themselves rather than contending with other test files' pools.
#
# Default: every test that only needs Postgres. None of these ever touch
# the network. (Several test files existed on disk but were missing from
# this list -- meaning `npm test`/CI silently never ran them even though
# `npm run test --workspace=<pkg>` did locally. Add every new test file
# here, not just to its package's own test script, or it's effectively
# untested in CI.)
#
# --amazon-sandbox: the 4 tests that need a real Amazon sandbox app and
# real outbound network access to Amazon's endpoints (AMAZON_SANDBOX_* in
# .env). Never run in CI -- no sandbox credentials are ever put there, and
# most CI runners' network egress wouldn't reach Amazon anyway. Run these
# locally instead, whenever you want to actually re-verify the Amazon
# integration.
set -euo pipefail
cd "$(dirname "$0")/.."

SAFE_TESTS=(
  "packages/web/test/amazon-oauth-state.test.ts"
  "packages/web/test/tenant-isolation.e2e.test.ts"
  "packages/warehouse-service/test/generate-and-pick.test.ts"
  "packages/warehouse-service/test/assign-picklist-concurrency.test.ts"
  "packages/warehouse-service/test/short-pick-backorder-split.test.ts"
  "packages/warehouse-service/test/sale-consumption.test.ts"
  "packages/inventory-service/test/record-inventory-event.test.ts"
  "packages/inventory-service/test/transfer-stock.test.ts"
  "packages/inventory-service/test/transfer-stock-concurrency.test.ts"
  "packages/channel-connectors/test/amazon-connector.test.ts"
  "packages/channel-connectors/test/shopify-connector.test.ts"
  "packages/channel-connectors/test/walmart-connector.test.ts"
  "packages/channel-connectors/test/ebay-connector.test.ts"
  "packages/channel-connectors/test/temu-connector.test.ts"
  "packages/channel-connectors/test/retry.test.ts"
  "packages/db/test/channel-connections-rls.test.ts"
  "packages/rules-engine/test/evaluate-golden.test.ts"
  "packages/rules-engine/test/resolve-actions-priority.test.ts"
  "packages/rules-engine/test/order-received-integration.test.ts"
  "packages/rules-engine/test/hold-order-integration.test.ts"
  "packages/order-service/test/persist-and-allocate.test.ts"
  "packages/order-service/test/allocation-concurrency.test.ts"
  "packages/order-service/test/multi-warehouse-allocation.test.ts"
  "packages/order-service/test/nearest-location-routing.test.ts"
  "packages/order-service/test/early-cancellation.test.ts"
  "packages/order-service/test/cancel-order.test.ts"
  "packages/order-service/test/lifecycle-transitions.test.ts"
  "packages/scheduler/test/sync-failure-tracking.test.ts"
  "packages/scheduler/test/rate-limit-cooldown.test.ts"
)

# Each needs AMAZON_SANDBOX_CLIENT_ID/CLIENT_SECRET/REFRESH_TOKEN/SELLER_ID
# in .env, and real outbound network access to api.amazon.com and
# sellingpartnerapi-*.amazon.com.
AMAZON_SANDBOX_TESTS=(
  "packages/order-service/test/persist-pulled-orders.test.ts"
  "packages/order-service/test/pull-and-allocate-e2e.test.ts"
  "packages/warehouse-service/test/confirm-shipment-e2e.test.ts"
  "packages/scheduler/test/amazon-order-sync-e2e.test.ts"
)

if [[ "${1:-}" == "--amazon-sandbox" ]]; then
  TESTS=("${AMAZON_SANDBOX_TESTS[@]}")
  echo "Running Amazon-sandbox-dependent tests -- requires AMAZON_SANDBOX_* in .env and real network access to Amazon."
else
  TESTS=("${SAFE_TESTS[@]}")
fi

FAILED=()
for test_file in "${TESTS[@]}"; do
  echo ""
  echo "=== ${test_file} ==="
  if ! npx tsx --test "${test_file}"; then
    FAILED+=("${test_file}")
  fi
done

echo ""
if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo "FAILED (${#FAILED[@]}):"
  printf '  %s\n' "${FAILED[@]}"
  exit 1
fi
echo "All ${#TESTS[@]} test file(s) passed."
