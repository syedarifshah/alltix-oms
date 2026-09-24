import type { ReactElement } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { withTenant } from "@alltix/db";
import { getAppPool } from "@/lib/db";
import { getAuthContext } from "@/lib/auth-context";
import { resolveTenantId } from "@/lib/with-tenant-auth";

export const dynamic = "force-dynamic";

/** consecutive_failures/last_failure_at/last_failure_message mirror
 *  channel_connections' own failure-tracking columns (migration 0021) --
 *  carrier_connections (migration 0039) was given the identical shape from
 *  the start, but nothing writes to them yet (no scheduler job exists for
 *  carriers the way it does for channel order-sync -- a carrier connection
 *  is only ever used synchronously, from the pack/ship flow, task #59's own
 *  ship-via-carrier route, not polled on a cron). Kept on the row and shown
 *  here anyway so a future retry-tracking pass (mirroring CLAUDE.md §4.4)
 *  has somewhere to write without a schema change. */
interface CarrierConnectionRow {
  id: string;
  carrier: string;
  external_account_id: string | null;
  status: string;
  consecutive_failures: number;
  last_failure_at: string | null;
  last_failure_message: string | null;
  created_at: string;
}

interface CarrierSettingsPageProps {
  searchParams: Promise<{ connected?: string; error?: string }>;
}

/**
 * Settings UI for the new Carrier Integration layer (CLAUDE.md's new
 * Carrier Integration section, task #59) -- the shipping-side counterpart
 * to /settings/channels' marketplace connections. Royal Mail is the only
 * carrier with a real connector as of this pass (Arif's own explicit
 * "Royal Mail first, complete" phasing decision) -- the other 7
 * (FedEx/UPS/DHL/Parcelforce/DPD/Evri/Hermes) aren't listed here yet, same
 * "don't render a Connect option for something that doesn't exist"
 * discipline /settings/channels' own ChannelNotEnabledNotice applies to a
 * flagged-off channel.
 */
export default async function CarrierSettingsPage({
  searchParams,
}: CarrierSettingsPageProps): Promise<ReactElement> {
  const authContext = await getAuthContext(await headers());
  if (!authContext) {
    redirect("/sign-in");
  }

  const pool = getAppPool();
  const tenantId = await resolveTenantId(pool, authContext.clerkUserId);
  if (!tenantId) {
    redirect("/sign-in");
  }

  const { connected, error } = await searchParams;

  const royalMailConnection = await withTenant(pool, tenantId, async (client) => {
    const result = await client.query<CarrierConnectionRow>(
      `SELECT id, carrier, external_account_id, status, consecutive_failures, last_failure_at, last_failure_message, created_at
         FROM carrier_connections
        WHERE carrier = 'royal_mail'
        ORDER BY created_at DESC
        LIMIT 1`,
    );
    return result.rows[0] ?? null;
  });

  const isRoyalMailConnected = royalMailConnection?.status === "active";

  return (
    <main className="page">
      <h1>Carriers</h1>
      <p className="subtitle">
        Real carrier label generation and tracking, separate from the marketplace connections on{" "}
        <a href="/settings/channels">Channels</a>. Royal Mail is the only carrier built so far — see the pack/ship
        workflow on <a href="/picklists">Picklists</a> for where a connected carrier is actually used to generate a
        real shipping label.
      </p>

      {connected === "royal_mail" && <div className="alert alert-success">Royal Mail connected.</div>}
      {error?.startsWith("royal_mail_missing_fields") && (
        <div className="alert alert-danger">The Click &amp; Drop API key is required.</div>
      )}
      {error?.startsWith("royal_mail_verify_failed") && (
        <div className="alert alert-danger">
          Royal Mail rejected that API key ({error.slice("royal_mail_verify_failed:".length)}).
        </div>
      )}
      {error?.startsWith("royal_mail_save_failed") && (
        <div className="alert alert-danger">
          Couldn&apos;t save this connection ({error.slice("royal_mail_save_failed:".length)}).
        </div>
      )}
      {error === "not signed in" && <div className="alert alert-danger">Not signed in.</div>}

      <h2>Royal Mail</h2>
      <div className="card">
        <div className="alert alert-info" style={{ marginBottom: 12 }}>
          UNVERIFIED against real Royal Mail infrastructure — order/label creation is built against Royal Mail&apos;s
          own official Click &amp; Drop API spec, and tracking against its Tracking API v2, but no real API key has
          round-tripped against either yet. Also worth knowing: Royal Mail&apos;s Click &amp; Drop API has no live
          rate-shopping/quote endpoint at all — rate estimates shown during shipping use a static price table plus
          Royal Mail&apos;s own published peak-season surcharge figures, never a live quote.
        </div>
        {royalMailConnection ? (
          <div className="stack">
            <div className="row">
              <span className={isRoyalMailConnected ? "badge badge-success" : "badge badge-danger"}>
                {royalMailConnection.status}
              </span>
            </div>
            <div className="muted">Connected since {new Date(royalMailConnection.created_at).toISOString()}</div>
            {royalMailConnection.status === "error" && (
              <div className="alert alert-danger" style={{ marginTop: 8, marginBottom: 0 }}>
                {royalMailConnection.consecutive_failures} consecutive failure(s)
                {royalMailConnection.last_failure_message && `: ${royalMailConnection.last_failure_message}`}.
                Reconnect below once the underlying issue is fixed.
              </div>
            )}
            <RoyalMailConnectForm buttonLabel="Reconnect Royal Mail" />
          </div>
        ) : (
          <RoyalMailConnectForm buttonLabel="Connect Royal Mail" />
        )}
      </div>
    </main>
  );
}

function RoyalMailConnectForm({ buttonLabel }: { buttonLabel: string }): ReactElement {
  return (
    <form action="/api/carriers/royal-mail/connect" method="POST" className="stack" style={{ marginTop: 8 }}>
      <label>
        Click &amp; Drop API key
        <input type="password" name="clickAndDropApiKey" placeholder="From Click & Drop > Settings > Integrations" required />
      </label>
      <label>
        Tracking API client ID (optional)
        <input type="text" name="trackingClientId" placeholder="Leave blank to skip live tracking" />
      </label>
      <label>
        Tracking API client secret (optional)
        <input type="password" name="trackingClientSecret" placeholder="Leave blank to skip live tracking" />
      </label>
      <button type="submit">{buttonLabel}</button>
    </form>
  );
}
