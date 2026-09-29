import { NextResponse, type NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { captureAlert } from "@alltix/shared";
import { getAppPool } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * eBay's own Marketplace Account Deletion/Closure Notifications endpoint --
 * built as a discovered PREREQUISITE for Production OAuth, not a standalone
 * feature request. Researched live against developer.ebay.com's own
 * "Marketplace account deletion notifications" guide when Arif asked to
 * resume eBay's Production OAuth setup (CLAUDE.md §4.6): a Production
 * keyset with any OAuth scope that can touch personal data is blocked
 * ("Your key set is currently invalid") until the developer either
 * subscribes to this exact workflow or formally opts out declaring no eBay
 * user data is retained. This codebase genuinely retains eBay buyer data
 * (orders.customer/orders.shipping_address, pulled per order via
 * EbayConnector.pullOrders(), CLAUDE.md §4.6) -- opting out would be a false
 * declaration to eBay, so subscribing is the only honest path, not a
 * preference. See migrations/0046_ebay_account_deletion_requests.sql's own
 * header comment for the full reasoning and the honest scope line on why
 * this doesn't attempt automated cross-tenant PII erasure.
 *
 * TWO REQUESTS, ONE ROUTE, PER EBAY'S OWN CONFIRMED SPEC:
 *
 * GET  -- the one-time verification challenge eBay sends immediately after
 *         this endpoint URL is saved in the Developer Portal (Application
 *         Keys > Notifications > Marketplace Account Deletion). eBay sends
 *         `?challenge_code=<value>` and expects back
 *         `{"challengeResponse": sha256hex(challengeCode + verificationToken + endpoint)}`
 *         -- CONFIRMED literal field order from developer.ebay.com's own
 *         guide: challengeCode, then verificationToken, then the endpoint
 *         URL itself, concatenated with no separator, then SHA-256 hex
 *         digest. Also re-used by eBay's own "Send Test Notification"
 *         button and whenever the endpoint URL is re-saved.
 * POST -- the real notification, sent whenever an eBay user (buyer or
 *         seller) closes their account or requests deletion. Acknowledged
 *         with a 2xx status regardless of parse completeness -- eBay's own
 *         docs don't publish a specific retry/backoff schedule for this
 *         notification type the way Sapient's tracking webhook does
 *         (CLAUDE.md §19.9), but the same "never retry-bait an endpoint
 *         that can't resolve the payload" discipline applies: a malformed
 *         or partially-recognized payload is logged and still acknowledged,
 *         never returned as an error, since eBay has no way to fix a
 *         payload shape this route doesn't recognize and retrying it
 *         changes nothing.
 *
 * VERIFICATION_TOKEN and ENDPOINT are both required for the GET handler's
 * own hash to match what eBay computes on its side -- see
 * EBAY_MARKETPLACE_DELETION_VERIFICATION_TOKEN/
 * EBAY_MARKETPLACE_DELETION_ENDPOINT_URL in .env.example. ENDPOINT must be
 * the exact literal URL string configured in eBay's own Developer Portal
 * (protocol + host + path, no trailing slash difference, no query string) --
 * eBay's own guide is explicit the hash includes the endpoint as a literal
 * string, not a normalized/parsed one, so a mismatch here (e.g. this env
 * var drifting from what's actually saved in eBay's portal after a domain
 * change) silently breaks the challenge response with no error surfaced
 * anywhere except eBay's own portal UI.
 *
 * WHAT THIS ROUTE DELIBERATELY DOES NOT DO: automatically resolve a
 * notified eBay username/userId/eiasToken to specific rows in this
 * tenant-scoped app's own orders/order_lines and erase or anonymize them.
 * A notification names an eBay MARKETPLACE user, which this schema has no
 * reliable way to resolve to one specific tenant's own order rows at
 * ingestion time (no eBay username/userId/eiasToken is stored anywhere on
 * the orders/order_lines schema today -- only the raw shipping address/
 * customer JSONB pulled from eBay's own order payload, CLAUDE.md §2.3).
 * Building that resolution+erasure pipeline is real, separate, materially
 * larger scope (deciding what "erase" means against an already-shipped,
 * already-audited order) -- this pass scopes to the mandatory unblocking
 * piece (the GET challenge-response, without which eBay refuses to
 * activate the subscription at all) plus an honest, minimal record-and-
 * alert mechanism: every real notification is durably recorded in
 * ebay_account_deletion_requests (INSERT-only for app_user, no SELECT
 * grant -- reading a received request back out and acting on it is a
 * deliberately manual operator task today, done directly against
 * DATABASE_URL's owner role, which bypasses RLS) and a captureAlert() fires
 * so a real deletion request is visible once Sentry is configured
 * (CLAUDE.md §13), not silently buried in a database row nobody looks at.
 */

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

/**
 * GET /api/webhooks/ebay/marketplace-account-deletion -- eBay's own
 * verification challenge. See this file's header comment for the exact
 * confirmed hash construction.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const challengeCode = req.nextUrl.searchParams.get("challenge_code");
  if (!challengeCode) {
    return NextResponse.json({ error: "missing challenge_code" }, { status: 400 });
  }

  const verificationToken = readEnv("EBAY_MARKETPLACE_DELETION_VERIFICATION_TOKEN");
  const endpoint = readEnv("EBAY_MARKETPLACE_DELETION_ENDPOINT_URL");
  if (!verificationToken || !endpoint) {
    // Fails loudly rather than silently no-op'ing -- same "missing env var"
    // discipline readEbayOAuthAppConfig() already establishes
    // (packages/web/src/lib/ebay-oauth-config.ts) -- eBay's own portal will
    // show this as a failed verification, which is the correct outcome for
    // an unconfigured deployment rather than a misleadingly-successful one.
    return NextResponse.json(
      { error: "EBAY_MARKETPLACE_DELETION_VERIFICATION_TOKEN/EBAY_MARKETPLACE_DELETION_ENDPOINT_URL not configured" },
      { status: 500 },
    );
  }

  const challengeResponse = createHash("sha256")
    .update(challengeCode)
    .update(verificationToken)
    .update(endpoint)
    .digest("hex");

  // Content-Type application/json with no BOM -- eBay's own guide calls
  // this out explicitly as a real, confirmed failure mode of some JSON
  // libraries. NextResponse.json() emits a plain UTF-8 JSON body with no
  // BOM (confirmed by inspection -- it delegates to Response/JSON.stringify,
  // neither of which ever prepends one), so no special handling is needed
  // beyond using it rather than hand-writing a body string.
  return NextResponse.json({ challengeResponse });
}

interface EbayAccountDeletionNotification {
  metadata?: {
    topic?: unknown;
    schemaVersion?: unknown;
    deprecated?: unknown;
  };
  notification?: {
    notificationId?: unknown;
    eventDate?: unknown;
    publishDate?: unknown;
    publishAttemptCount?: unknown;
    data?: {
      username?: unknown;
      userId?: unknown;
      eiasToken?: unknown;
    };
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * POST /api/webhooks/ebay/marketplace-account-deletion -- the real
 * notification. See this file's header comment for the confirmed payload
 * shape and the honest "record + alert, not automated erasure" scope.
 */
export async function POST(req: NextRequest): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    // Acknowledge anyway -- eBay has no way to fix a request this route
    // can't parse, and there's nothing useful to retry into. Same
    // "never retry-bait an unresolvable delivery" discipline
    // packages/web/src/app/api/webhooks/sapient/route.ts already
    // establishes for a different carrier notification (CLAUDE.md §19.9).
    console.warn("eBay marketplace account deletion webhook: received a non-JSON body -- acknowledging, nothing to record.");
    return NextResponse.json({ status: "ok", recorded: false });
  }

  const notification = (body as EbayAccountDeletionNotification | null)?.notification;
  const data = notification?.data;

  const ebayUsername = asString(data?.username);
  const ebayUserId = asString(data?.userId);
  const eiasToken = asString(data?.eiasToken);
  const eventDate = asDate(notification?.eventDate);

  if (!ebayUsername && !ebayUserId && !eiasToken) {
    console.warn(
      "eBay marketplace account deletion webhook: received a delivery with no recognizable username/userId/eiasToken -- acknowledging, raw payload kept in raw_payload only.",
    );
  }

  try {
    const pool = getAppPool();
    // Tenant-less, INSERT-only -- mirrors demo_requests' own shape
    // (migrations/0017_demo_requests.sql), same reasoning
    // migrations/0046_ebay_account_deletion_requests.sql's own header
    // comment gives: a notification names an eBay marketplace user, not
    // one of this app's own tenants, so there is no tenant to scope this
    // write by. No SELECT grant for app_user -- reading these back out is
    // a deliberate manual operator task against DATABASE_URL's owner role.
    await pool.query(
      `INSERT INTO ebay_account_deletion_requests
         (ebay_username, ebay_user_id, eias_token, event_date, raw_payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [ebayUsername, ebayUserId, eiasToken, eventDate, JSON.stringify(body)],
    );
  } catch (err) {
    // Still acknowledge -- a DB error here is this app's own problem to
    // fix, not eBay's to retry into indefinitely; captureAlert() below is
    // what actually surfaces it.
    console.error("eBay marketplace account deletion webhook: failed to record notification.", err);
    captureAlert("eBay marketplace account deletion webhook: failed to record a real notification", {
      ebayUsername,
      ebayUserId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ status: "ok", recorded: false });
  }

  // A real eBay account-deletion request is exactly the kind of
  // incident-worthy-from-data condition captureAlert() exists for
  // (CLAUDE.md §13's own "conditions detected from data, not caught
  // exceptions" framing) -- this is not an error in this app, but it does
  // need a human to look at it and manually resolve/erase whatever order
  // data actually matches, per this file's own header comment on why that
  // resolution isn't automated.
  captureAlert("eBay marketplace account deletion request received", {
    ebayUsername,
    ebayUserId,
  });

  return NextResponse.json({ status: "ok", recorded: true });
}
