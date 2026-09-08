// Ad-hoc demo data for a visual preview walkthrough. Not part of the
// committed codebase -- creates one realistic tenant with products,
// inventory, orders in several real states, a picklist, and a rule, using
// the actual service classes wherever the state machine allows it (not
// hand-crafted end states), so the screenshots taken against this data
// reflect the real app, not a mockup.

import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { createAppPool, withTenant, withTenantAndUser } from "@alltix/db";
import { InventoryService } from "@alltix/inventory-service";
import { OrderService } from "@alltix/order-service";
import { WarehouseService } from "@alltix/warehouse-service";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
loadEnv({ path: join(REPO_ROOT, ".env") });

const pool = createAppPool({ connectionString: process.env.APP_DATABASE_URL! });

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const CLERK_USER_ID = "demo-preview-user";

async function main() {
  await withTenantAndUser(pool, { tenantId: TENANT_ID, clerkUserId: CLERK_USER_ID }, async (client) => {
    await client.query(
      `INSERT INTO tenants (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      [TENANT_ID, "Northwind Outdoor Supply"],
    );
    await client.query(
      `INSERT INTO users (tenant_id, clerk_user_id, email) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [TENANT_ID, CLERK_USER_ID, "demo@northwind-outdoor.example"],
    );
  });

  const locationId = await withTenant(pool, TENANT_ID, async (client) => {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM locations WHERE tenant_id = $1 AND name = 'Main Fulfillment Center'`,
      [TENANT_ID],
    );
    if (existing.rows[0]) return existing.rows[0].id;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO locations (tenant_id, name, type) VALUES ($1, 'Main Fulfillment Center', 'warehouse') RETURNING id`,
      [TENANT_ID],
    );
    return inserted.rows[0]!.id;
  });

  const products = [
    { sku: "NW-TENT-2P", name: "Northwind 2-Person Backpacking Tent", receipt: 42 },
    { sku: "NW-STOVE-01", name: "Northwind Camp Stove", receipt: 3 },
    { sku: "NW-PACK-40L", name: "Northwind 40L Daypack", receipt: 0 },
    { sku: "NW-BOTTLE-1L", name: "Northwind Insulated Bottle 1L", receipt: 130 },
  ];

  const inventoryService = new InventoryService(pool);
  const productIds: Record<string, string> = {};

  for (const p of products) {
    const productId = await withTenant(pool, TENANT_ID, async (client) => {
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM products WHERE tenant_id = $1 AND internal_sku = $2`,
        [TENANT_ID, p.sku],
      );
      if (existing.rows[0]) return existing.rows[0].id;
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO products (tenant_id, internal_sku, name) VALUES ($1, $2, $3) RETURNING id`,
        [TENANT_ID, p.sku, p.name],
      );
      return inserted.rows[0]!.id;
    });
    productIds[p.sku] = productId;

    if (p.receipt > 0) {
      await inventoryService.recordInventoryEvent({
        tenantId: TENANT_ID,
        productId,
        locationId,
        eventType: "receipt",
        quantityDelta: p.receipt,
        referenceType: "po",
        idempotencyKey: `demo-receipt:${productId}`,
      });
    } else {
      // Force an inventory_levels row to exist at zero, so the ATS page's
      // "OUT OF STOCK" badge has something real to show rather than the
      // product simply not appearing.
      await withTenant(pool, TENANT_ID, (client) =>
        client.query(
          `INSERT INTO inventory_levels (tenant_id, product_id, location_id, on_hand, reserved)
           VALUES ($1, $2, $3, 0, 0) ON CONFLICT (product_id, location_id) DO NOTHING`,
          [TENANT_ID, productId, locationId],
        ),
      );
    }
  }

  const orderService = new OrderService(pool);
  const warehouseService = new WarehouseService(pool, orderService);

  async function makeOrder(externalId: string, channel: string, lines: Array<{ sku: string; qty: number }>) {
    return withTenant(pool, TENANT_ID, async (client) => {
      const order = await client.query<{ id: string }>(
        `INSERT INTO orders (tenant_id, channel, external_order_id, status, customer, shipping_address, placed_at)
         VALUES ($1, $2, $3, 'received', $4, $5, now())
         ON CONFLICT (tenant_id, channel, external_order_id) DO UPDATE SET external_order_id = EXCLUDED.external_order_id
         RETURNING id`,
        [
          TENANT_ID,
          channel,
          externalId,
          JSON.stringify({ name: "Jordan Rivera" }),
          JSON.stringify({ city: "Boise", state: "ID", country: "US" }),
        ],
      );
      const orderId = order.rows[0]!.id;
      for (const line of lines) {
        await client.query(
          `INSERT INTO order_lines (tenant_id, order_id, product_id, quantity, unit_price, fulfillment_type)
           SELECT $1, $2, id, $3, $4, 'seller_fulfilled' FROM products WHERE tenant_id = $1 AND internal_sku = $5
           ON CONFLICT DO NOTHING`,
          [TENANT_ID, orderId, line.qty, 49.99, line.sku],
        );
      }
      return orderId;
    });
  }

  // 1. Sits at 'received' -- untouched, to show the front of the pipeline.
  await makeOrder("AMZ-1001", "amazon", [{ sku: "NW-BOTTLE-1L", qty: 2 }]);

  // 2. Walked to 'allocated' -- plenty of stock.
  const allocatedOrderId = await makeOrder("AMZ-1002", "amazon", [{ sku: "NW-TENT-2P", qty: 1 }]);
  await orderService.transition(TENANT_ID, allocatedOrderId, "received", "validated");
  await orderService.transition(TENANT_ID, allocatedOrderId, "validated", "allocated");

  // 3. Walked to 'backordered' -- zero stock on NW-PACK-40L.
  const backorderedOrderId = await makeOrder("SHOP-2001", "shopify", [{ sku: "NW-PACK-40L", qty: 1 }]);
  await orderService.transition(TENANT_ID, backorderedOrderId, "received", "validated");
  await orderService.transition(TENANT_ID, backorderedOrderId, "validated", "allocated");

  // 4. Walked all the way to 'picking', with a real picklist generated and
  //    assigned, to show the warehouse workflow.
  const pickingOrderId = await makeOrder("AMZ-1003", "amazon", [{ sku: "NW-STOVE-01", qty: 1 }]);
  await orderService.transition(TENANT_ID, pickingOrderId, "received", "validated");
  await orderService.transition(TENANT_ID, pickingOrderId, "validated", "allocated");
  const picklists = await warehouseService.generatePicklist(TENANT_ID, [pickingOrderId]);
  // users' RLS policy is self-lookup-only (scoped by app.clerk_user_id, not
  // app.tenant_id -- see migration 0010), so a plain withTenant() session
  // can't see it; go through the schema-owning admin connection instead,
  // same pattern the test files use for tables app_user can't fully query.
  const { Client } = await import("pg");
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  const pickerResult = await admin.query<{ id: string }>(
    `SELECT id FROM users WHERE tenant_id = $1 AND clerk_user_id = $2`,
    [TENANT_ID, CLERK_USER_ID],
  );
  await admin.end();
  const pickerId = pickerResult.rows[0]!.id;
  if (picklists[0]) {
    await warehouseService.assignPicklist(TENANT_ID, picklists[0].id, pickerId);
  }

  // A routing rule, real shape RulesEngine actually implements.
  await withTenant(pool, TENANT_ID, (client) =>
    client.query(
      `INSERT INTO automation_rules (tenant_id, name, trigger_event, conditions, actions, priority, enabled)
       VALUES ($1, $2, 'order.received', $3, $4, 100, true)
       ON CONFLICT DO NOTHING`,
      [
        TENANT_ID,
        "Route Amazon orders to Main Fulfillment Center",
        JSON.stringify([{ field: "channel", op: "eq", value: "amazon" }]),
        JSON.stringify([{ type: "route_to_warehouse", value: locationId }]),
      ],
    ),
  );

  console.log("Seeded tenant:", TENANT_ID);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
