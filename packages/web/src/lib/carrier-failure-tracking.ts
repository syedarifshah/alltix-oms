import type { Pool } from "pg";
import { withTenant } from "@alltix/db";
import { captureAlert } from "@alltix/shared";
import type { Carrier } from "./carrier-flags";

/**
 * Cross-run circuit-breaker for carrier connections -- the carrier-layer
 * counterpart of @alltix/scheduler's own recordSyncFailure()/
 * recordSyncSuccess() (CLAUDE.md §4.4's "Cross-run sync failure
 * tracking/alerting"), applied to `carrier_connections` (migration 0039)
 * instead of `channel_connections` (migration 0021). The SCHEMA for this
 * has existed since carrier_connections was first created --
 * `consecutive_failures`/`last_failure_at`/`last_failure_message`/
 * `status IN (..., 'error')` are all original migration-0039 columns -- but
 * nothing ever wrote to them until now.
 *
 * Structurally different from the scheduler's own version, for a real
 * reason, not an oversight: channels have a cron-driven scheduler job that
 * discovers `status = 'active'` connections on a schedule, so
 * recordSyncFailure()/recordSyncSuccess() run against an admin pool from a
 * background process with no tenant session of its own. Carriers have NO
 * scheduler job at all (carrier-flags.ts's own header comment already says
 * so) -- a carrier connection is only ever used synchronously, from a
 * signed-in tenant's own real request (ship-via-carrier's real label call,
 * carrier-rate-estimate's real rate-shopping call). So these functions take
 * the ordinary tenant-scoped `pool` every other route-level helper in this
 * codebase already takes (checkRateLimit, isCarrierEnabledForTenant) and
 * open their own short-lived `withTenant` transaction, rather than an
 * already-open `client` the way audit-log.ts's `recordAuditEvent` does --
 * there's no existing open transaction at either call site worth reusing
 * (the label-generating INSERT into `shipments` is its own separate
 * `withTenant` block, on purpose, so a failed carrier call never rolls back
 * alongside it).
 *
 * Deliberately only ever called around the real, live connector method call
 * itself (`connector.createShipment()`/`connector.getRateEstimate()`) --
 * NEVER around `createXConnectorFromCarrierConnection()`'s own credential
 * load. That load already fails on its own, separate, unrelated condition
 * ("no active carrier_connections row for this tenant/carrier at all" --
 * every `loadXCredentialsFromCarrierConnection()` in
 * `@alltix/carrier-connectors` already filters `WHERE ... AND status =
 * 'active'`), which is not a carrier API failure to circuit-break on, it's
 * simply "not connected" (or already tripped to 'error' by an earlier
 * failure -- see below). Counting that as a fresh failure would double-count
 * the same outage forever.
 *
 * A genuinely useful consequence of that same `status = 'active'` filter,
 * worth being explicit about: once `recordCarrierFailure()` trips a
 * connection to `status = 'error'`, every one of those load functions stops
 * returning a row for it on the very next call -- `createXConnectorFromCarrierConnection()`
 * throws `No active 'x' carrier_connections row found for tenant ...`
 * instead, which both routes' own existing catch blocks already turn into a
 * `redirectWithError` the tenant sees on `/picklists`. So "exclude a
 * tripped connection from being dispatched to" (the open design question
 * this feature used to carry) doesn't need any new code at all -- it falls
 * out of infrastructure that was already built for an unrelated reason.
 * Recovery is the same "manual, via reconnect" story channels already
 * carry (§4.4's own doc comment): the tenant re-submits their credentials
 * on `/settings/carriers`, which re-verifies live via `verifyConnection()`
 * before writing `status = 'active'` again -- nothing here auto-retries an
 * `error` row.
 */

/** Same threshold @alltix/scheduler's own channel-level circuit breaker
 *  uses (CONSECUTIVE_FAILURE_ERROR_THRESHOLD, packages/scheduler/src/index.ts)
 *  -- not shared/imported from there (scheduler depends on nothing carrier-
 *  related and shouldn't gain a dependency just to re-export one constant),
 *  kept as its own literal instead, same "two independent copies of a small
 *  shared idea" precedent channel-flags.ts/carrier-flags.ts's own
 *  ALL_CHANNELS/ALL_CARRIERS lists already established for this codebase. */
export const CARRIER_CONSECUTIVE_FAILURE_ERROR_THRESHOLD = 3;

/**
 * Records a failed live carrier API call: increments
 * `carrier_connections.consecutive_failures`, stamps
 * `last_failure_at`/`last_failure_message`, and -- once
 * {@link CARRIER_CONSECUTIVE_FAILURE_ERROR_THRESHOLD} consecutive failures
 * have piled up -- flips `status` to `'error'` in the same statement, same
 * single-UPDATE-with-a-CASE shape `recordSyncFailure()` already uses so two
 * concurrent failing calls can't both read a stale count and both under-
 * count the trip. A single `[ALERT]`-tagged log line plus a Sentry event
 * (`captureAlert()`) fires exactly once, on the call that actually crosses
 * the threshold -- not on every failure after it, same "log-based alerting,
 * not alert fatigue" discipline every other `[ALERT]` site in this codebase
 * already follows (CLAUDE.md §4.4/§13).
 *
 * A no-op (zero rows matched) if no `carrier_connections` row exists for
 * this (tenant, carrier) at all -- shouldn't happen given the calling
 * discipline above (only ever called once a real connector call has
 * already been made, which itself required a real row to load credentials
 * from), but a defensive no-op is safer than throwing a SECOND error out of
 * an already-failing call's own error-handling path.
 */
export async function recordCarrierFailure(
  pool: Pool,
  tenantId: string,
  carrier: Carrier,
  message: string,
): Promise<void> {
  await withTenant(pool, tenantId, async (client) => {
    const result = await client.query<{ consecutive_failures: number; status: string }>(
      `UPDATE carrier_connections
          SET consecutive_failures = consecutive_failures + 1,
              last_failure_at = now(),
              last_failure_message = $1,
              status = CASE WHEN consecutive_failures + 1 >= $2 THEN 'error' ELSE status END,
              updated_at = now()
        WHERE tenant_id = $3 AND carrier = $4
        RETURNING consecutive_failures, status`,
      // Truncated defensively, same precedent recordSyncFailure() sets --
      // last_failure_message is TEXT (unbounded), but an underlying carrier
      // error message could in principle be huge.
      [message.slice(0, 2000), CARRIER_CONSECUTIVE_FAILURE_ERROR_THRESHOLD, tenantId, carrier],
    );

    const row = result.rows[0];
    if (row?.status === "error" && row.consecutive_failures === CARRIER_CONSECUTIVE_FAILURE_ERROR_THRESHOLD) {
      const alertMessage =
        `[ALERT] ${carrier} carrier_connections for tenant ${tenantId} has failed ${row.consecutive_failures} ` +
        `consecutive attempts and is now status='error' -- it will NOT be used again until the tenant ` +
        `reconnects via /settings/carriers.`;
      console.error(alertMessage);
      captureAlert(alertMessage, { tenantId, carrier, consecutiveFailures: row.consecutive_failures });
    }
  });
}

/**
 * Records a successful live carrier API call, resetting
 * `consecutive_failures` back to 0 -- the counterpart to
 * {@link recordCarrierFailure}, called after every successful
 * `createShipment()`/`getRateEstimate()` call. Deliberately leaves
 * `last_failure_at`/`last_failure_message` in place on a reset, same "a
 * resolved incident stays visible, not erased" precedent
 * `recordSyncSuccess()` already sets -- `/settings/carriers` can still show
 * a connection's last known failure even once it's healthy again.
 * `AND consecutive_failures > 0` is the same "don't write a no-op UPDATE
 * into a perfectly healthy row's own `updated_at`" guard
 * `recordSyncSuccess()` already uses, not a correctness requirement.
 */
export async function recordCarrierSuccess(pool: Pool, tenantId: string, carrier: Carrier): Promise<void> {
  await withTenant(pool, tenantId, async (client) => {
    await client.query(
      `UPDATE carrier_connections
          SET consecutive_failures = 0, updated_at = now()
        WHERE tenant_id = $1 AND carrier = $2 AND consecutive_failures > 0`,
      [tenantId, carrier],
    );
  });
}
