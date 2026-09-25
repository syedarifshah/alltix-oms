import type { ReactElement } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { withTenant } from "@alltix/db";
import { getAppPool } from "@/lib/db";
import { getAuthContext } from "@/lib/auth-context";
import { resolveTenantId } from "@/lib/with-tenant-auth";
import { getEnabledCarriers } from "@/lib/carrier-flags";

export const dynamic = "force-dynamic";

/** consecutive_failures/last_failure_at/last_failure_message mirror
 *  channel_connections' own failure-tracking columns (migration 0021) --
 *  carrier_connections (migration 0039) was given the identical shape from
 *  the start. Update: these are now real, written columns, not just
 *  reserved schema -- CLAUDE.md §19.11's cross-run circuit-breaker pass
 *  (packages/web/src/lib/carrier-failure-tracking.ts) wires
 *  recordCarrierFailure()/recordCarrierSuccess() into ship-via-carrier's own
 *  connector.createShipment() call and carrier-rate-estimate's own
 *  connector.getRateEstimate() call -- the only two places a carrier
 *  connection is ever used after connect (still no scheduler job exists for
 *  carriers the way there is for channel order-sync, so both writers are
 *  triggered by a real synchronous tenant request, not a cron tick). */
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
 * Settings UI for the Carrier Integration layer (CLAUDE.md §19) -- the
 * shipping-side counterpart to /settings/channels' marketplace connections.
 * Royal Mail (carrier #1, §19.1), Evri (carrier #2, §19.2), FedEx (carrier
 * #3, §19.3), Parcelforce (carrier #4, §19.4, built once Arif explicitly
 * picked it -- overriding the UPS recommendation -- as "the next carrier" a
 * third time), UPS (carrier #5, §19.5, built once Arif went WITH the
 * recommendation this time), DHL (carrier #6, §19.6, Arif's own explicit
 * pick again), and DPD (carrier #7, §19.7, Arif's own explicit
 * "Yes, build DPD now" confirmation, the last of the original 7 carriers)
 * are all seven with a real connector as of this pass -- Hermes itself was
 * folded into "Evri" per that connector's own research (Hermes UK rebranded
 * to Evri in 2022, one carrier not two), so this closes out the full
 * originally-requested lineup.
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

  const {
    royalMailConnection,
    evriConnection,
    fedexConnection,
    parcelforceConnection,
    upsConnection,
    dhlConnection,
    dpdConnection,
    enabledCarriers,
  } = await withTenant(pool, tenantId, async (client) => {
    const result = await client.query<CarrierConnectionRow>(
      `SELECT id, carrier, external_account_id, status, consecutive_failures, last_failure_at, last_failure_message, created_at
         FROM carrier_connections
        WHERE carrier IN ('royal_mail', 'evri', 'fedex', 'parcelforce', 'ups', 'dhl', 'dpd')
        ORDER BY created_at DESC`,
    );
    const enabledCarriers = await getEnabledCarriers(client, tenantId);
    return {
      royalMailConnection: result.rows.find((r) => r.carrier === "royal_mail") ?? null,
      evriConnection: result.rows.find((r) => r.carrier === "evri") ?? null,
      fedexConnection: result.rows.find((r) => r.carrier === "fedex") ?? null,
      parcelforceConnection: result.rows.find((r) => r.carrier === "parcelforce") ?? null,
      upsConnection: result.rows.find((r) => r.carrier === "ups") ?? null,
      dhlConnection: result.rows.find((r) => r.carrier === "dhl") ?? null,
      dpdConnection: result.rows.find((r) => r.carrier === "dpd") ?? null,
      enabledCarriers,
    };
  });

  const isRoyalMailConnected = royalMailConnection?.status === "active";
  const isEvriConnected = evriConnection?.status === "active";
  const isFedExConnected = fedexConnection?.status === "active";
  const isParcelforceConnected = parcelforceConnection?.status === "active";
  const isUpsConnected = upsConnection?.status === "active";
  const isDhlConnected = dhlConnection?.status === "active";
  const isDpdConnected = dpdConnection?.status === "active";

  // Feature-flag gate -- see the enabledCarriers query above and
  // CarrierNotEnabledNotice below. Only consulted for the "not connected
  // yet" branch of each carrier's own card: an already-connected carrier's
  // settings card is unaffected by this flag either way, same "the flag
  // change takes effect for that tenant's *use*, not by rewriting what
  // their settings page shows for a carrier they've already connected"
  // design channel-flags.ts's own precedent (CLAUDE.md §15) already
  // established.
  const isRoyalMailEnabled = enabledCarriers.includes("royal_mail");
  const isEvriEnabled = enabledCarriers.includes("evri");
  const isFedExEnabled = enabledCarriers.includes("fedex");
  const isParcelforceEnabled = enabledCarriers.includes("parcelforce");
  const isUpsEnabled = enabledCarriers.includes("ups");
  const isDhlEnabled = enabledCarriers.includes("dhl");
  const isDpdEnabled = enabledCarriers.includes("dpd");

  return (
    <main className="page">
      <h1>Carriers</h1>
      <p className="subtitle">
        Real carrier label generation and tracking, separate from the marketplace connections on{" "}
        <a href="/settings/channels">Channels</a>. Royal Mail, Evri, FedEx, Parcelforce, UPS, DHL, and DPD are all
        seven of the originally-requested carriers, now built — see the pack/ship workflow on{" "}
        <a href="/picklists">Picklists</a> for where a connected carrier is actually used to generate a real shipping
        label.
      </p>

      {connected === "royal_mail" && <div className="alert alert-success">Royal Mail connected.</div>}
      {connected === "evri" && <div className="alert alert-success">Evri connected.</div>}
      {connected === "fedex" && <div className="alert alert-success">FedEx connected.</div>}
      {connected === "parcelforce" && <div className="alert alert-success">Parcelforce connected.</div>}
      {connected === "ups" && <div className="alert alert-success">UPS connected.</div>}
      {connected === "dhl" && <div className="alert alert-success">DHL connected.</div>}
      {connected === "dpd" && <div className="alert alert-success">DPD connected.</div>}
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
      {error?.startsWith("evri_missing_fields") && (
        <div className="alert alert-danger">The Sapient client ID and client secret are both required.</div>
      )}
      {error?.startsWith("evri_verify_failed") && (
        <div className="alert alert-danger">
          Sapient rejected that client ID/secret pair ({error.slice("evri_verify_failed:".length)}).
        </div>
      )}
      {error?.startsWith("evri_save_failed") && (
        <div className="alert alert-danger">
          Couldn&apos;t save this connection ({error.slice("evri_save_failed:".length)}).
        </div>
      )}
      {error?.startsWith("fedex_missing_fields") && (
        <div className="alert alert-danger">The FedEx client ID, client secret, and account number are all required.</div>
      )}
      {error?.startsWith("fedex_verify_failed") && (
        <div className="alert alert-danger">
          FedEx rejected that credential set ({error.slice("fedex_verify_failed:".length)}).
        </div>
      )}
      {error?.startsWith("fedex_save_failed") && (
        <div className="alert alert-danger">
          Couldn&apos;t save this connection ({error.slice("fedex_save_failed:".length)}).
        </div>
      )}
      {error?.startsWith("parcelforce_missing_fields") && (
        <div className="alert alert-danger">The expressLink username, password, and contract number are all required.</div>
      )}
      {error?.startsWith("parcelforce_verify_failed") && (
        <div className="alert alert-danger">
          Parcelforce rejected that credential set ({error.slice("parcelforce_verify_failed:".length)}).
        </div>
      )}
      {error?.startsWith("parcelforce_save_failed") && (
        <div className="alert alert-danger">
          Couldn&apos;t save this connection ({error.slice("parcelforce_save_failed:".length)}).
        </div>
      )}
      {error?.startsWith("ups_missing_fields") && (
        <div className="alert alert-danger">The UPS client ID, client secret, and account number are all required.</div>
      )}
      {error?.startsWith("ups_verify_failed") && (
        <div className="alert alert-danger">
          UPS rejected that credential set ({error.slice("ups_verify_failed:".length)}).
        </div>
      )}
      {error?.startsWith("ups_save_failed") && (
        <div className="alert alert-danger">
          Couldn&apos;t save this connection ({error.slice("ups_save_failed:".length)}).
        </div>
      )}
      {error?.startsWith("dhl_missing_fields") && (
        <div className="alert alert-danger">The DHL API key, API secret, and account number are all required.</div>
      )}
      {error?.startsWith("dhl_verify_failed") && (
        <div className="alert alert-danger">
          DHL rejected that credential set ({error.slice("dhl_verify_failed:".length)}).
        </div>
      )}
      {error?.startsWith("dhl_save_failed") && (
        <div className="alert alert-danger">
          Couldn&apos;t save this connection ({error.slice("dhl_save_failed:".length)}).
        </div>
      )}
      {error?.startsWith("dpd_missing_fields") && (
        <div className="alert alert-danger">The Sapient client ID and client secret are both required.</div>
      )}
      {error?.startsWith("dpd_verify_failed") && (
        <div className="alert alert-danger">
          Sapient rejected that client ID/secret pair ({error.slice("dpd_verify_failed:".length)}).
        </div>
      )}
      {error?.startsWith("dpd_save_failed") && (
        <div className="alert alert-danger">
          Couldn&apos;t save this connection ({error.slice("dpd_save_failed:".length)}).
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
        ) : isRoyalMailEnabled ? (
          <RoyalMailConnectForm buttonLabel="Connect Royal Mail" />
        ) : (
          <CarrierNotEnabledNotice carrier="Royal Mail" />
        )}
      </div>

      <h2 style={{ marginTop: 24 }}>Evri</h2>
      <div className="card">
        <div className="alert alert-info" style={{ marginBottom: 12 }}>
          UNVERIFIED against real Sapient/Evri infrastructure — Evri itself publishes no self-serve API of any kind,
          so this integrates via the <strong>Sapient/Intersoft CORE API gateway</strong> instead (a real, credible
          third-party multi-carrier shipping gateway), not a direct Evri API. No real client ID/secret has
          round-tripped against it yet. Also worth knowing: no live rate-shopping endpoint was found for Sapient
          either — rate estimates return empty (unlike Royal Mail, no confirmed Evri surcharge or base-price data
          exists to estimate from). Real-time tracking is now received via a Sapient-configured webhook — see{" "}
          <a href="/orders">Orders</a> for the tracking history on a shipped order, once one exists. This is not
          something this codebase can configure automatically (Sapient&apos;s own webhook setup is a 5-step PORTAL
          process, not a REST call) — once you have a real Sapient account, point its tracking webhook callback URL
          at <code>/api/webhooks/sapient</code> on this app&apos;s own domain. Sapient publishes no signature/HMAC
          mechanism to verify a delivery is genuinely from them; if the <code>SAPIENT_WEBHOOK_SHARED_SECRET</code>{" "}
          environment variable is set, append <code>?token=&lt;that value&gt;</code> to the callback URL as this
          app&apos;s own mitigation.
        </div>
        {evriConnection ? (
          <div className="stack">
            <div className="row">
              <span className={isEvriConnected ? "badge badge-success" : "badge badge-danger"}>
                {evriConnection.status}
              </span>
            </div>
            <div className="muted">Connected since {new Date(evriConnection.created_at).toISOString()}</div>
            {evriConnection.status === "error" && (
              <div className="alert alert-danger" style={{ marginTop: 8, marginBottom: 0 }}>
                {evriConnection.consecutive_failures} consecutive failure(s)
                {evriConnection.last_failure_message && `: ${evriConnection.last_failure_message}`}.
                Reconnect below once the underlying issue is fixed.
              </div>
            )}
            <EvriConnectForm buttonLabel="Reconnect Evri" />
          </div>
        ) : isEvriEnabled ? (
          <EvriConnectForm buttonLabel="Connect Evri" />
        ) : (
          <CarrierNotEnabledNotice carrier="Evri" />
        )}
      </div>

      <h2 style={{ marginTop: 24 }}>FedEx</h2>
      <div className="card">
        <div className="alert alert-info" style={{ marginBottom: 12 }}>
          UNVERIFIED against real FedEx infrastructure — built against FedEx&apos;s own official, self-serve
          developer.fedex.com docs, including a real rendered OAuth example (the best-documented carrier here so
          far), but no real Project API Key/Secret has round-tripped against it yet. Also worth knowing: unlike
          Royal Mail and Evri, FedEx <strong>does</strong> expose a live rate-shopping endpoint — rate estimates
          shown during shipping are a real, live FedEx quote, not a static table.
        </div>
        {fedexConnection ? (
          <div className="stack">
            <div className="row">
              <span className={isFedExConnected ? "badge badge-success" : "badge badge-danger"}>
                {fedexConnection.status}
              </span>
            </div>
            <div className="muted">Connected since {new Date(fedexConnection.created_at).toISOString()}</div>
            {fedexConnection.status === "error" && (
              <div className="alert alert-danger" style={{ marginTop: 8, marginBottom: 0 }}>
                {fedexConnection.consecutive_failures} consecutive failure(s)
                {fedexConnection.last_failure_message && `: ${fedexConnection.last_failure_message}`}.
                Reconnect below once the underlying issue is fixed.
              </div>
            )}
            <FedExConnectForm buttonLabel="Reconnect FedEx" />
          </div>
        ) : isFedExEnabled ? (
          <FedExConnectForm buttonLabel="Connect FedEx" />
        ) : (
          <CarrierNotEnabledNotice carrier="FedEx" />
        )}
      </div>

      <h2 style={{ marginTop: 24 }}>Parcelforce</h2>
      <div className="card">
        <div className="alert alert-info" style={{ marginBottom: 12 }}>
          UNVERIFIED against real Parcelforce infrastructure — integrates via Parcelforce&apos;s own expressLink SOAP
          API (the first non-REST carrier here), a <strong>closed, contract-gated API</strong> like Evri&apos;s own
          Sapient gateway, not a self-serve one like Royal Mail&apos;s or FedEx&apos;s — real test credentials can
          only be obtained by contacting Parcelforce&apos;s own Customer Solutions Team directly. No real
          username/password/contract number has round-tripped against it yet. Also worth knowing: unlike Royal Mail,
          Parcelforce <strong>does</strong> expose a confirmed cancel-shipment operation, but — like Royal Mail and
          Evri — no live rate-shopping endpoint was found, so rate estimates return empty.
        </div>
        {parcelforceConnection ? (
          <div className="stack">
            <div className="row">
              <span className={isParcelforceConnected ? "badge badge-success" : "badge badge-danger"}>
                {parcelforceConnection.status}
              </span>
            </div>
            <div className="muted">Connected since {new Date(parcelforceConnection.created_at).toISOString()}</div>
            {parcelforceConnection.status === "error" && (
              <div className="alert alert-danger" style={{ marginTop: 8, marginBottom: 0 }}>
                {parcelforceConnection.consecutive_failures} consecutive failure(s)
                {parcelforceConnection.last_failure_message && `: ${parcelforceConnection.last_failure_message}`}.
                Reconnect below once the underlying issue is fixed.
              </div>
            )}
            <ParcelforceConnectForm buttonLabel="Reconnect Parcelforce" />
          </div>
        ) : isParcelforceEnabled ? (
          <ParcelforceConnectForm buttonLabel="Connect Parcelforce" />
        ) : (
          <CarrierNotEnabledNotice carrier="Parcelforce" />
        )}
      </div>

      <h2 style={{ marginTop: 24 }}>UPS</h2>
      <div className="card">
        <div className="alert alert-info" style={{ marginBottom: 12 }}>
          UNVERIFIED against real UPS infrastructure — built against UPS&apos;s own public OpenAPI spec repository
          (github.com/UPS-API/api-documentation), this codebase&apos;s best-sourced carrier connector so far, but no
          real Client ID/Secret or account number has round-tripped against it yet. Also worth knowing: like FedEx,
          UPS <strong>does</strong> expose a live rate-shopping endpoint, and — like Royal Mail and Parcelforce —
          UPS has a confirmed cancel-shipment (void) operation too.
        </div>
        {upsConnection ? (
          <div className="stack">
            <div className="row">
              <span className={isUpsConnected ? "badge badge-success" : "badge badge-danger"}>{upsConnection.status}</span>
            </div>
            <div className="muted">Connected since {new Date(upsConnection.created_at).toISOString()}</div>
            {upsConnection.status === "error" && (
              <div className="alert alert-danger" style={{ marginTop: 8, marginBottom: 0 }}>
                {upsConnection.consecutive_failures} consecutive failure(s)
                {upsConnection.last_failure_message && `: ${upsConnection.last_failure_message}`}.
                Reconnect below once the underlying issue is fixed.
              </div>
            )}
            <UpsConnectForm buttonLabel="Reconnect UPS" />
          </div>
        ) : isUpsEnabled ? (
          <UpsConnectForm buttonLabel="Connect UPS" />
        ) : (
          <CarrierNotEnabledNotice carrier="UPS" />
        )}
      </div>

      <h2 style={{ marginTop: 24 }}>DHL</h2>
      <div className="card">
        <div className="alert alert-info" style={{ marginBottom: 12 }}>
          UNVERIFIED against real DHL infrastructure — built against DHL Express&apos;s own public, self-serve
          MyDHL API, but no real API key/secret or account number has round-tripped against it yet. DHL splits
          shipping/rating and tracking across <strong>two separate DHL APIs with two different auth models</strong>
          — the same shape Royal Mail&apos;s own two-API split established — so tracking needs a second, optional
          Unified Tracking API key; a tenant can connect labels/rates without it. Also worth knowing: like FedEx and
          UPS, DHL <strong>does</strong> expose a live rate-shopping endpoint, but — unlike Royal Mail, Parcelforce,
          and UPS — DHL Express has <strong>no cancel/void-shipment endpoint at all</strong> (confirmed: DHL&apos;s
          own cancel operation only cancels a pickup request, not the shipment/label itself).
        </div>
        {dhlConnection ? (
          <div className="stack">
            <div className="row">
              <span className={isDhlConnected ? "badge badge-success" : "badge badge-danger"}>{dhlConnection.status}</span>
            </div>
            <div className="muted">Connected since {new Date(dhlConnection.created_at).toISOString()}</div>
            {dhlConnection.status === "error" && (
              <div className="alert alert-danger" style={{ marginTop: 8, marginBottom: 0 }}>
                {dhlConnection.consecutive_failures} consecutive failure(s)
                {dhlConnection.last_failure_message && `: ${dhlConnection.last_failure_message}`}.
                Reconnect below once the underlying issue is fixed.
              </div>
            )}
            <DhlConnectForm buttonLabel="Reconnect DHL" />
          </div>
        ) : isDhlEnabled ? (
          <DhlConnectForm buttonLabel="Connect DHL" />
        ) : (
          <CarrierNotEnabledNotice carrier="DHL" />
        )}
      </div>

      <h2 style={{ marginTop: 24 }}>DPD</h2>
      <div className="card">
        <div className="alert alert-info" style={{ marginBottom: 12 }}>
          UNVERIFIED against real Sapient/DPD infrastructure — DPD UK&apos;s own direct API is confirmed to exist
          (a real, closed, contract-gated onboarding via a signed DPD contract and a physical label audit), but has
          no publicly-readable technical reference, so — like Evri — this integrates via the{" "}
          <strong>same Sapient/Intersoft CORE API gateway</strong> instead, not DPD UK&apos;s own direct API. No real
          client ID/secret has round-tripped against it yet. Also worth knowing: no live rate-shopping endpoint was
          found for Sapient either — rate estimates return empty (same as Evri, no confirmed DPD surcharge or
          base-price data exists to estimate from), and — like Evri — no confirmed cancel-shipment endpoint was
          found, so void is not implemented. Real-time tracking is now received via the same Sapient-configured
          webhook as Evri&apos;s — see <a href="/orders">Orders</a> for the tracking history on a shipped order, once
          one exists. Once you have a real Sapient account, point its tracking webhook callback URL at{" "}
          <code>/api/webhooks/sapient</code> on this app&apos;s own domain (the same one endpoint handles both
          carriers — see Evri&apos;s own card above for the shared-secret note).
        </div>
        {dpdConnection ? (
          <div className="stack">
            <div className="row">
              <span className={isDpdConnected ? "badge badge-success" : "badge badge-danger"}>{dpdConnection.status}</span>
            </div>
            <div className="muted">Connected since {new Date(dpdConnection.created_at).toISOString()}</div>
            {dpdConnection.status === "error" && (
              <div className="alert alert-danger" style={{ marginTop: 8, marginBottom: 0 }}>
                {dpdConnection.consecutive_failures} consecutive failure(s)
                {dpdConnection.last_failure_message && `: ${dpdConnection.last_failure_message}`}.
                Reconnect below once the underlying issue is fixed.
              </div>
            )}
            <DpdConnectForm buttonLabel="Reconnect DPD" />
          </div>
        ) : isDpdEnabled ? (
          <DpdConnectForm buttonLabel="Connect DPD" />
        ) : (
          <CarrierNotEnabledNotice carrier="DPD" />
        )}
      </div>
    </main>
  );
}

/**
 * Mirrors ChannelNotEnabledNotice (/settings/channels' own page component)
 * exactly -- see CLAUDE.md's "Carrier Feature Flags" section for the full
 * design. Only ever shown for a carrier with NO existing connection (see
 * isXEnabled's own comment above): an already-connected carrier keeps its
 * normal connected-state card regardless of this flag.
 */
function CarrierNotEnabledNotice({ carrier }: { carrier: string }): ReactElement {
  return <p className="muted">{carrier} isn&apos;t available for your account yet.</p>;
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

function FedExConnectForm({ buttonLabel }: { buttonLabel: string }): ReactElement {
  return (
    <form action="/api/carriers/fedex/connect" method="POST" className="stack" style={{ marginTop: 8 }}>
      <label>
        FedEx Project API Key (client ID)
        <input type="text" name="clientId" placeholder="From developer.fedex.com" required />
      </label>
      <label>
        FedEx Project API Secret Key (client secret)
        <input type="password" name="clientSecret" placeholder="From developer.fedex.com" required />
      </label>
      <label>
        FedEx account number
        <input type="text" name="accountNumber" placeholder="Required on every Ship/Rate request" required />
      </label>
      <button type="submit">{buttonLabel}</button>
    </form>
  );
}

function EvriConnectForm({ buttonLabel }: { buttonLabel: string }): ReactElement {
  return (
    <form action="/api/carriers/evri/connect" method="POST" className="stack" style={{ marginTop: 8 }}>
      <label>
        Sapient client ID
        <input type="text" name="clientId" placeholder="Issued by Intersoft Sapient" required />
      </label>
      <label>
        Sapient client secret
        <input type="password" name="clientSecret" placeholder="Issued by Intersoft Sapient" required />
      </label>
      <button type="submit">{buttonLabel}</button>
    </form>
  );
}

function ParcelforceConnectForm({ buttonLabel }: { buttonLabel: string }): ReactElement {
  return (
    <form action="/api/carriers/parcelforce/connect" method="POST" className="stack" style={{ marginTop: 8 }}>
      <label>
        expressLink username
        <input type="text" name="username" placeholder="Issued by Parcelforce Customer Solutions" required />
      </label>
      <label>
        expressLink password
        <input type="password" name="password" placeholder="Issued by Parcelforce Customer Solutions" required />
      </label>
      <label>
        Contract number
        <input type="text" name="contractNumber" placeholder="Your Parcelforce contract number" required />
      </label>
      <button type="submit">{buttonLabel}</button>
    </form>
  );
}

function UpsConnectForm({ buttonLabel }: { buttonLabel: string }): ReactElement {
  return (
    <form action="/api/carriers/ups/connect" method="POST" className="stack" style={{ marginTop: 8 }}>
      <label>
        UPS Client ID
        <input type="text" name="clientId" placeholder="From the UPS Developer Portal" required />
      </label>
      <label>
        UPS Client Secret
        <input type="password" name="clientSecret" placeholder="From the UPS Developer Portal" required />
      </label>
      <label>
        UPS account number
        <input type="text" name="accountNumber" placeholder="Required on every Shipping/Rating request" required />
      </label>
      <button type="submit">{buttonLabel}</button>
    </form>
  );
}

function DhlConnectForm({ buttonLabel }: { buttonLabel: string }): ReactElement {
  return (
    <form action="/api/carriers/dhl/connect" method="POST" className="stack" style={{ marginTop: 8 }}>
      <label>
        DHL Express API key
        <input type="text" name="apiKey" placeholder="From developer.dhl.com" required />
      </label>
      <label>
        DHL Express API secret
        <input type="password" name="apiSecret" placeholder="From developer.dhl.com" required />
      </label>
      <label>
        DHL Express account number
        <input type="text" name="accountNumber" placeholder="Required on every Shipping/Rating request" required />
      </label>
      <label>
        Unified Tracking API key (optional)
        <input type="password" name="trackingApiKey" placeholder="Leave blank to skip live tracking" />
      </label>
      <button type="submit">{buttonLabel}</button>
    </form>
  );
}

function DpdConnectForm({ buttonLabel }: { buttonLabel: string }): ReactElement {
  return (
    <form action="/api/carriers/dpd/connect" method="POST" className="stack" style={{ marginTop: 8 }}>
      <label>
        Sapient client ID
        <input type="text" name="clientId" placeholder="Issued by Intersoft Sapient" required />
      </label>
      <label>
        Sapient client secret
        <input type="password" name="clientSecret" placeholder="Issued by Intersoft Sapient" required />
      </label>
      <button type="submit">{buttonLabel}</button>
    </form>
  );
}
