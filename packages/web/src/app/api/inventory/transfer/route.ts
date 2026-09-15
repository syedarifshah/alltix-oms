import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { getInventoryService } from "@/lib/services";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

/**
 * POST /api/inventory/transfer -- the /inventory page's "Transfer stock"
 * form, backed by InventoryService.transferStock() (the multi-warehouse
 * capability that used to just throw "not implemented" -- see that
 * method's own doc comment). Same form-POST-then-redirect-with-?error=
 * shape as every other page-driven mutation in this app (e.g.
 * /api/products/create, /api/orders/[id]/cancel) -- a plain HTML form with
 * no client JS, per CLAUDE.md's Next.js conventions.
 *
 * A fresh `idempotencyKey` is generated per submission (not derived from
 * form fields) -- unlike, say, a channel connector's pull/allocation flow,
 * there's no natural externally-supplied key for a human clicking a button
 * once; a random UUID per POST means a genuine double-click/resubmit from
 * the browser is NOT deduped (each one is a distinct, deliberate transfer
 * request as far as this route is concerned) -- deduping a truly accidental
 * double-submit would need a client-side disable-on-submit or a
 * form-generated nonce, neither of which exists yet anywhere else in this
 * app's plain-form mutations, so this doesn't invent one just for transfers.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireCurrentUser(req, getAppPool());
  if (!user) {
    return redirectWithError(req, "/inventory", "not signed in");
  }

  const formData = await req.formData();
  const productId = String(formData.get("productId") ?? "").trim();
  const fromLocationId = String(formData.get("fromLocationId") ?? "").trim();
  const toLocationId = String(formData.get("toLocationId") ?? "").trim();
  const quantityRaw = String(formData.get("quantity") ?? "").trim();
  const quantity = Number(quantityRaw);

  if (!productId || !fromLocationId || !toLocationId || !quantityRaw) {
    return redirectWithError(req, "/inventory", "inventory_transfer_missing_fields");
  }

  try {
    await getInventoryService().transferStock({
      tenantId: user.tenantId,
      productId,
      fromLocationId,
      toLocationId,
      quantity,
      idempotencyKey: `manual-transfer:${user.tenantId}:${randomUUID()}`,
    });
  } catch (err) {
    const message = errorMessage(err);
    if (message.includes("must be different locations")) {
      return redirectWithError(req, "/inventory", "inventory_transfer_same_location");
    }
    if (message.includes("positive integer")) {
      return redirectWithError(req, "/inventory", "inventory_transfer_invalid_quantity");
    }
    if (message.includes("insufficient available stock")) {
      return redirectWithError(req, "/inventory", `inventory_transfer_insufficient_stock:${message}`);
    }
    return redirectWithError(req, "/inventory", `inventory_transfer_failed:${message}`);
  }

  return redirectTo(req, "/inventory?transferred=1");
}
