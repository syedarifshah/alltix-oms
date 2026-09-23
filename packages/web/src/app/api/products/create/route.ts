import type { NextRequest } from "next/server";
import { withTenant, recordAuditEvent } from "@alltix/db";
import { getAppPool } from "@/lib/db";
import { requireCurrentUser } from "@/lib/with-tenant-auth";
import { redirectTo, redirectWithError, errorMessage } from "@/lib/route-helpers";
import { checkRateLimit, RATE_LIMIT_ERROR_MESSAGE } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * POST /api/products/create -- the /products page's "Add a product" form.
 * A thin, form-based counterpart to the existing JSON `POST /api/products`
 * (src/app/api/products/route.ts): that route is a plain JSON API meant for
 * scripts/tests (see its own INSERT), takes a JSON body, and returns a JSON
 * response -- it can't be pointed at directly from a plain HTML <form>, and
 * this app's own convention for a page-driven mutation is a form POST that
 * redirects back with ?error=... on failure (see /api/rules' identical
 * shape). Added because /products (outbound Shopify listing creation) had
 * no way to get a *new* internal product into the catalog at all before
 * this -- every existing product had arrived via catalog sync or order
 * persistence, never a deliberate "start a new listing from scratch" path.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const pool = getAppPool();
  const user = await requireCurrentUser(req, pool);
  if (!user) {
    return redirectWithError(req, "/products", "not signed in");
  }

  if (await checkRateLimit(pool, user.tenantId, "products.create")) {
    return redirectWithError(req, "/products", RATE_LIMIT_ERROR_MESSAGE);
  }

  const formData = await req.formData();
  const internalSku = String(formData.get("internalSku") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();

  if (!internalSku || !name) {
    return redirectWithError(req, "/products", "product_missing_fields");
  }

  try {
    await withTenant(pool, user.tenantId, async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO products (tenant_id, internal_sku, name) VALUES ($1, $2, $3) RETURNING id`,
        [user.tenantId, internalSku, name],
      );
      // Same transaction as the INSERT above -- see recordAuditEvent's own
      // doc comment for why that matters.
      await recordAuditEvent(client, {
        tenantId: user.tenantId,
        userId: user.id,
        action: "product.created",
        entityType: "product",
        entityId: result.rows[0]!.id,
        details: { internalSku, name },
      });
    });
  } catch (err) {
    // Postgres unique_violation on (tenant_id, internal_sku) -- see
    // 0003_products.sql's own comment for why that constraint is scoped
    // per-tenant. Give a specific, friendly reason rather than the raw
    // constraint-name error text.
    const pgCode = (err as { code?: string } | null)?.code;
    if (pgCode === "23505") {
      return redirectWithError(req, "/products", "product_sku_already_exists");
    }
    return redirectWithError(req, "/products", `product_create_failed:${errorMessage(err)}`);
  }

  return redirectTo(req, "/products?product_created=1");
}
