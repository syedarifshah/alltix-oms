import type { NextRequest } from "next/server";
import { withTenant } from "@alltix/db";
import { createWalmartConnectorFromChannelConnection, FeedStillProcessingError } from "@alltix/channel-connectors";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

/**
 * POST /api/channels/walmart/listings/[id]/check-status -- resolves a
 * 'pending' Walmart channel_listings row (created by
 * /api/channels/walmart/listings, see its own doc comment for why
 * submitListing() alone can't know the outcome yet) to a terminal state, via
 * WalmartConnector.getFeedStatus() on the feedId that route stashed in
 * raw_payload.
 *
 * Manual, tenant-triggered ("Check status" button on /products) rather than
 * an automatic poller: CLAUDE.md §4.4's rate-limited job queue is the right
 * home for that eventually, but this flow has exactly zero real callers to
 * build automatic polling infrastructure against yet (getFeedStatus() itself
 * had none before this pass either -- see CLAUDE.md's own note on this).
 * A manual check is honest about that rather than a background-cron
 * implementation this codebase can't yet verify against a real feed anyway.
 *
 * Three outcomes:
 *  - still processing (FeedStillProcessingError) -- no state change, redirect
 *    back with an informational note. Not an error.
 *  - succeeded -- listing_status -> 'active'.
 *  - failed -- listing_status -> 'error', with Walmart's own error message
 *    recorded in raw_payload for /products to show.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const pool = getAppPool();
  const user = await requireCurrentUser(req, pool);
  if (!user) {
    return redirectWithError(req, "/products", "not signed in");
  }

  const { id } = await ctx.params;

  const existing = await withTenant(pool, user.tenantId, (client) =>
    client.query<{ raw_payload: { feedId?: string } | null; listing_status: string }>(
      `SELECT raw_payload, listing_status FROM channel_listings WHERE id = $1 AND tenant_id = $2 AND channel = 'walmart'`,
      [id, user.tenantId],
    ),
  );
  const row = existing.rows[0];
  if (!row) {
    return redirectWithError(req, "/products", "walmart_listing_not_found");
  }
  const feedId = row.raw_payload?.feedId;
  if (row.listing_status !== "pending" || !feedId) {
    // Already resolved (or was never a real feed submission at all) --
    // nothing to check. Not an error: a stale/double-clicked button should
    // just no-op back to the current state, same "idempotent redelivery"
    // discipline used elsewhere in this codebase.
    return redirectTo(req, "/products");
  }

  let connector;
  try {
    connector = await createWalmartConnectorFromChannelConnection(pool, user.tenantId);
  } catch (err) {
    return redirectWithError(req, "/products", `walmart_listing_no_connection:${errorMessage(err)}`);
  }

  try {
    const result = await connector.getFeedStatus(feedId);
    await withTenant(pool, user.tenantId, (client) =>
      client.query(
        `UPDATE channel_listings
            SET listing_status = $1, raw_payload = raw_payload || $2::jsonb, last_synced_at = now(), updated_at = now()
          WHERE id = $3 AND tenant_id = $4`,
        [
          result.success ? "active" : "error",
          JSON.stringify({ lastCheckedAt: new Date().toISOString(), error: result.error ?? null }),
          id,
          user.tenantId,
        ],
      ),
    );
  } catch (err) {
    if (err instanceof FeedStillProcessingError) {
      return redirectTo(req, "/products?walmart_listing_still_processing=1");
    }
    return redirectWithError(req, "/products", `walmart_listing_status_check_failed:${errorMessage(err)}`);
  }

  return redirectTo(req, "/products?walmart_listing_status_checked=1");
}
