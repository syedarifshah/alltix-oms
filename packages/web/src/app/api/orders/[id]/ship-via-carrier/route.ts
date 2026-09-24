import type { NextRequest } from "next/server";
import { withTenant } from "@alltix/db";
import { createRoyalMailConnectorFromCarrierConnection } from "@alltix/carrier-connectors";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { getWarehouseService } from "@/lib/services";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";
import { checkRateLimit, RATE_LIMIT_ERROR_MESSAGE } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * POST /api/orders/[id]/ship-via-carrier -- the new step task #59 adds
 * ahead of the existing /api/orders/[id]/ship route: actually generates a
 * real Royal Mail shipping label (RoyalMailConnector.createShipment()) for
 * a 'packed' order, records it in `shipments` (migration 0039), and then
 * -- only once Royal Mail has returned a real tracking number -- calls the
 * EXACT SAME WarehouseService.confirmShipment() the manual free-text
 * /picklists form already calls, so a Royal Mail-generated shipment and a
 * manually-typed one both flow through one, already-tested confirmation
 * path (channel notified, sale events recorded, packed -> shipped) rather
 * than two parallel ones.
 *
 * Deliberately a SEPARATE route from /ship, not a parameter on it: this
 * one makes a real, mutating call to an external carrier (a label costs
 * real money once Royal Mail's account is live) before ever touching this
 * app's own order state, while /ship assumes a label/tracking number
 * already exists from wherever the tenant got it (a Royal Mail-generated
 * one via this route, or one from a carrier this codebase hasn't built a
 * connector for yet, typed in by hand). /picklists renders both options.
 *
 * v1 scope, deliberately narrow, same "tenant-supplied form field over
 * auto-resolved channel data" precedent eBay's own categoryId/imageUrl
 * form fields already set (CLAUDE.md §4.6): recipient address and package
 * weight are typed into this form, not auto-extracted from
 * orders.shipping_address. That JSONB blob's shape genuinely differs per
 * channel (Amazon/Shopify/Walmart/eBay each use different field names --
 * see extractUsShippingZip()'s own doc comment in order-service for how
 * much per-channel-specific work a real parser would need), and no
 * products/order_lines column in this schema carries a weight at all yet
 * (grepped before writing this) -- building a real per-channel address
 * parser plus a weight data model is a separate, substantial piece of
 * work, not a small addition to this pass.
 *
 * UNVERIFIED IN PRACTICE, same status RoyalMailConnector itself carries:
 * no real Royal Mail credentials exist anywhere in this codebase or Arif's
 * account yet -- this route's logic is complete and typechecked, but
 * nobody has generated a real label through it.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const pool = getAppPool();
  const user = await requireCurrentUser(req, pool);
  if (!user) {
    return redirectWithError(req, "/picklists", "not signed in");
  }

  if (await checkRateLimit(pool, user.tenantId, "orders.ship_via_carrier")) {
    return redirectWithError(req, "/picklists", RATE_LIMIT_ERROR_MESSAGE);
  }

  const { id } = await ctx.params;
  const formData = await req.formData();
  const recipientName = String(formData.get("recipientName") ?? "").trim();
  const addressLine1 = String(formData.get("addressLine1") ?? "").trim();
  const city = String(formData.get("city") ?? "").trim();
  const postalCode = String(formData.get("postalCode") ?? "").trim();
  const countryCode = String(formData.get("countryCode") ?? "GB").trim().toUpperCase();
  const weightGrams = Number(formData.get("weightGrams") ?? 0);
  const shippingCostChargedGbp = String(formData.get("shippingCostChargedGbp") ?? "0").trim();
  const serviceCode = String(formData.get("serviceCode") ?? "").trim();

  if (!recipientName || !addressLine1 || !city || !postalCode || !weightGrams) {
    return redirectWithError(req, "/picklists", "Recipient address and package weight are required.");
  }

  try {
    const order = await withTenant(pool, user.tenantId, async (client) => {
      const orderResult = await client.query<{
        id: string;
        external_order_id: string;
        status: string;
        placed_at: string | null;
      }>(`SELECT id, external_order_id, status, placed_at FROM orders WHERE id = $1 AND tenant_id = $2`, [
        id,
        user.tenantId,
      ]);
      const orderRow = orderResult.rows[0];
      if (!orderRow) {
        throw new Error(`Order ${id} not found`);
      }
      if (orderRow.status !== "packed") {
        throw new Error(`Order ${id} is in status '${orderRow.status}', not 'packed' -- cannot ship via carrier`);
      }

      const linesResult = await client.query<{
        internal_sku: string | null;
        name: string | null;
        quantity: number;
        unit_price: string;
      }>(
        `SELECT p.internal_sku, p.name, ol.quantity, ol.unit_price
           FROM order_lines ol
           JOIN products p ON p.id = ol.product_id
          WHERE ol.order_id = $1`,
        [orderRow.id],
      );

      return { ...orderRow, lines: linesResult.rows };
    });

    const subtotal = order.lines.reduce((sum, line) => sum + Number(line.unit_price) * line.quantity, 0);
    const total = subtotal + Number(shippingCostChargedGbp || "0");

    const connector = await createRoyalMailConnectorFromCarrierConnection(pool, user.tenantId);
    const shipment = await connector.createShipment({
      orderId: order.id,
      orderReference: order.external_order_id.slice(0, 40),
      orderDate: order.placed_at ?? new Date().toISOString(),
      recipient: { name: recipientName, addressLine1, city, postalCode, countryCode },
      subtotalGbp: subtotal.toFixed(2),
      shippingCostChargedGbp: Number(shippingCostChargedGbp || "0").toFixed(2),
      totalGbp: total.toFixed(2),
      serviceCode: serviceCode || undefined,
      packages: [
        {
          weightGrams,
          packageFormat: "parcel",
          items: order.lines.map((line) => ({
            name: line.name ?? "Item",
            sku: line.internal_sku ?? undefined,
            quantity: line.quantity,
            unitValueGbp: Number(line.unit_price).toFixed(2),
          })),
        },
      ],
    });

    await withTenant(pool, user.tenantId, async (client) => {
      await client.query(
        `INSERT INTO shipments
           (tenant_id, order_id, carrier, service_code, carrier_order_id, tracking_number, label_base64, weight_grams, cost, status, raw_payload)
         VALUES ($1, $2, 'royal_mail', $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          user.tenantId,
          order.id,
          serviceCode || null,
          shipment.carrierOrderId,
          shipment.trackingNumber,
          shipment.labelBase64,
          weightGrams,
          Number(shippingCostChargedGbp || "0"),
          shipment.trackingNumber ? "created" : "error",
          JSON.stringify(shipment.raw),
        ],
      );
    });

    if (!shipment.trackingNumber) {
      // A real, documented split outcome (see RoyalMailConnector.createShipment()'s
      // own doc comment): the order was created on Royal Mail's side but no
      // tracking number came back, so there's nothing real to hand the
      // channel yet. The order stays 'packed' -- same "don't transition on
      // a degraded outcome" discipline WarehouseService.confirmShipment()
      // already applies when the channel call itself fails.
      return redirectWithError(
        req,
        "/picklists",
        `Royal Mail created order ${shipment.carrierOrderId} but returned no tracking number -- check the shipment and retry.`,
      );
    }

    await getWarehouseService().confirmShipment(
      user.tenantId,
      order.id,
      { carrier: "Royal Mail", trackingNumber: shipment.trackingNumber, shippedAt: new Date().toISOString() },
      user.id,
    );
  } catch (err) {
    return redirectWithError(req, "/picklists", errorMessage(err));
  }

  return redirectTo(req, "/picklists");
}
