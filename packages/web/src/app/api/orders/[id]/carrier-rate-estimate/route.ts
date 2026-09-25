import { NextResponse, type NextRequest } from "next/server";
import {
  createFedExConnectorFromCarrierConnection,
  createUpsConnectorFromCarrierConnection,
  createDhlConnectorFromCarrierConnection,
  type CarrierConnector,
} from "@alltix/carrier-connectors";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectWithError, errorMessage } from "@/lib/route-helpers";
import { checkRateLimit, RATE_LIMIT_ERROR_MESSAGE } from "@/lib/rate-limit";
import { isCarrierEnabledForTenant, type Carrier } from "@/lib/carrier-flags";

export const dynamic = "force-dynamic";

/**
 * POST /api/orders/[id]/carrier-rate-estimate -- wires FedExConnector's/
 * UpsConnector's/DhlConnector's own real live `getRateEstimate()` calls
 * (CLAUDE.md §19.3/§19.5/§19.6) into `/picklists` for the first time. Every
 * one of the 7 carriers' own "Ship via connected carrier" form still asks
 * the tenant to type in `shippingCostChargedGbp` by hand -- for Royal Mail
 * (§19.1, no rate endpoint, only a static price table + confirmed
 * surcharges), Evri/DPD (§19.2/§19.7, no rate endpoint found for Sapient),
 * and Parcelforce (§19.4, no rate endpoint found either), that's the only
 * option there is. FedEx/UPS/DHL are genuinely different: all three have a
 * real, confirmed rate-shopping endpoint their own connector already
 * implements, and until this route existed nothing in the app ever called
 * it -- a real, documented gap every one of those three sections' own
 * "Deliberately NOT wired this pass" paragraph named directly.
 *
 * Deliberately a SEPARATE route from ship-via-carrier, not a parameter on
 * it, mirroring that route's own "separate route, not a flag" reasoning for
 * a materially different reason here: a rate estimate is a read-only call
 * (no shipment is created, no label costs money, no order state changes),
 * so it doesn't belong behind the same order-status/carrier-connection
 * mutation path a real label-generating POST does. It also only ever needs
 * the same `{weightGrams, destinationCountryCode, shipDate}` triple
 * `CarrierConnector.getRateEstimate()` itself takes (`connector.ts`'s own
 * interface) -- genuinely less than ship-via-carrier's own recipient-
 * address/service-code fields, so this is its own small form on
 * `/picklists`, not a "preview" step bolted onto the existing one.
 *
 * Only FedEx/UPS/DHL are ever offered here -- Royal Mail/Evri/Parcelforce/
 * DPD's own `getRateEstimate()` implementations either return a static
 * table (Royal Mail) or an empty array (Evri, Parcelforce, DPD), so listing
 * them in this route's own map would just be a silently-empty or
 * misleadingly-labeled "live rate," not a bug this route needs to guard
 * against so much as a reason those three were never added here at all.
 *
 * Deliberately does NOT auto-fill the quote into the ship-via-carrier
 * form's own `shippingCostChargedGbp` field -- this app has no client JS
 * anywhere (`/hr`, `/locations`, `/products` etc. all use the same plain
 * form-POST-then-redirect convention, see those pages' own doc comments),
 * so there is no in-browser way to copy a value from one form into another
 * without introducing exactly the client-side scripting this codebase has
 * deliberately avoided everywhere else. The quote is rendered as plain
 * read-only text next to the ship form instead; the tenant reads it and
 * types the number in by hand, same "wire it now, don't over-build the UX"
 * discipline every other v1 pass in this carrier layer already follows.
 *
 * Renders the result via a redirect carrying `rateQuoteOrderId`/
 * `rateQuoteCarrier`/`rateQuote` (a JSON-encoded `RateEstimate[]`) query
 * params rather than a session/flash mechanism this codebase doesn't have
 * -- the same "state travels in the redirect URL, the page reads
 * searchParams" shape `redirectWithError`'s own `?error=` convention
 * already establishes, just carrying a small JSON payload instead of a
 * single string. `/picklists` only ever renders this alongside the ONE
 * order card whose id matches `rateQuoteOrderId`, so a quote never
 * "leaks" onto a different order's card after a redirect.
 *
 * UNVERIFIED IN PRACTICE, same status every other carrier feature in this
 * layer carries: no real FedEx/UPS/DHL credentials exist anywhere in this
 * codebase or Arif's account yet, so this route's own live network call has
 * never actually round-tripped against real carrier infrastructure --
 * complete and typechecked, not proven.
 */
const RATE_ESTIMATE_CONNECTORS: Record<
  string,
  { displayName: string; createConnector: (pool: ReturnType<typeof getAppPool>, tenantId: string) => Promise<CarrierConnector> }
> = {
  fedex: { displayName: "FedEx", createConnector: createFedExConnectorFromCarrierConnection },
  ups: { displayName: "UPS", createConnector: createUpsConnectorFromCarrierConnection },
  dhl: { displayName: "DHL", createConnector: createDhlConnectorFromCarrierConnection },
};

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const pool = getAppPool();
  const user = await requireCurrentUser(req, pool);
  if (!user) {
    return redirectWithError(req, "/picklists", "not signed in");
  }

  if (await checkRateLimit(pool, user.tenantId, "orders.carrier_rate_estimate")) {
    return redirectWithError(req, "/picklists", RATE_LIMIT_ERROR_MESSAGE);
  }

  const { id } = await ctx.params;
  const formData = await req.formData();
  const carrier = String(formData.get("carrier") ?? "").trim();
  const carrierConfig = RATE_ESTIMATE_CONNECTORS[carrier];
  if (!carrierConfig) {
    return redirectWithError(
      req,
      "/picklists",
      `'${carrier}' has no live rate-shopping endpoint -- only FedEx, UPS, and DHL do (CLAUDE.md §19.3/§19.5/§19.6).`,
    );
  }

  // Same ongoing-use carrier feature-flag gate ship-via-carrier's own route
  // already applies (CLAUDE.md's "Carrier Feature Flags" section) -- a
  // tenant a carrier is disabled for shouldn't be able to pull a live rate
  // from it either, even though this call itself never touches
  // carrier_connections' own credentials beyond reading them.
  if (!(await isCarrierEnabledForTenant(pool, user.tenantId, carrier as Carrier))) {
    return redirectWithError(req, "/picklists", `${carrierConfig.displayName} is not enabled for your account.`);
  }

  const weightGrams = Number(formData.get("weightGrams") ?? 0);
  const countryCode = String(formData.get("countryCode") ?? "GB").trim().toUpperCase();
  if (!weightGrams || weightGrams <= 0) {
    return redirectWithError(req, "/picklists", "Package weight is required to get a rate estimate.");
  }

  try {
    const connector = await carrierConfig.createConnector(pool, user.tenantId);
    const estimates = await connector.getRateEstimate({
      weightGrams,
      destinationCountryCode: countryCode,
      shipDate: new Date().toISOString(),
    });

    const url = new URL("/picklists", req.url);
    url.searchParams.set("rateQuoteOrderId", id);
    url.searchParams.set("rateQuoteCarrier", carrierConfig.displayName);
    url.searchParams.set("rateQuote", JSON.stringify(estimates));
    return NextResponse.redirect(url, { status: 303 });
  } catch (err) {
    return redirectWithError(req, "/picklists", errorMessage(err));
  }
}
