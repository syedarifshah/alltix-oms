import { NextResponse, type NextRequest } from "next/server";
import { withTenantAuth, type TenantRequestContext } from "@/lib/with-tenant-auth";

export const dynamic = "force-dynamic";

async function listProducts(_req: NextRequest, { client }: TenantRequestContext): Promise<Response> {
  // No WHERE tenant_id = ... here on purpose: the RLS policy on `products`
  // (packages/db/migrations/0003_products.sql) already scopes every row to
  // whatever withTenantAuth set via SET LOCAL app.tenant_id. That's the
  // point of the exercise -- isolation holds even if a handler is sloppy.
  const result = await client.query("SELECT id, tenant_id, internal_sku, name FROM products ORDER BY internal_sku");
  return NextResponse.json({ products: result.rows });
}

async function createProduct(req: NextRequest, { client, tenantId }: TenantRequestContext): Promise<Response> {
  const body = (await req.json()) as { internalSku?: string; name?: string };
  if (!body.internalSku || !body.name) {
    return NextResponse.json({ error: "internalSku and name are required" }, { status: 400 });
  }

  const result = await client.query(
    "INSERT INTO products (tenant_id, internal_sku, name) VALUES ($1, $2, $3) RETURNING id, tenant_id, internal_sku, name",
    [tenantId, body.internalSku, body.name],
  );
  return NextResponse.json({ product: result.rows[0] }, { status: 201 });
}

export const GET = withTenantAuth(listProducts);
export const POST = withTenantAuth(createProduct);
