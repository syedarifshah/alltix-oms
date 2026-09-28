import type { PoolClient } from "pg";

/**
 * True global idempotency for `inventory_events.idempotency_key`, now that
 * `inventory_events` itself is partitioned by `created_at` (migration
 * 0044_inventory_events_partitioning.sql) and can therefore no longer carry
 * a plain `UNIQUE(idempotency_key)` constraint -- Postgres requires every
 * unique constraint on a partitioned table to include the partition key,
 * and `idempotency_key` deliberately is NOT that key (a real, deterministic
 * key like `order-sale:<orderId>:<orderLineId>` has no natural relationship
 * to which calendar month the resulting event lands in, and weakening the
 * constraint to `(idempotency_key, created_at)` would silently stop
 * protecting against exactly the redelivery/retry scenario it exists for --
 * see that migration's own doc comment for the full reasoning).
 *
 * `inventory_event_idempotency_keys` (same migration) is a small,
 * deliberately NOT partitioned sidecar table whose own
 * `PRIMARY KEY (idempotency_key)` is the one place true, table-wide
 * uniqueness is still enforced. Every real write path must claim a key here
 * FIRST, inside the SAME transaction as the real `inventory_events` insert,
 * so a rolled-back claim never leaves an orphaned "claimed but never
 * written" key behind -- and so a claim that fails aborts the whole write,
 * exactly like the old table-level UNIQUE constraint would have.
 *
 * Two call shapes here, matching the two idempotency behaviors this
 * codebase's own `inventory_events` call sites already had *before*
 * partitioning forced this table to exist -- this file doesn't invent new
 * behavior, it preserves each call site's existing one exactly:
 *
 *   - {@link claimInventoryEventIdempotencyKey} mirrors the old
 *     `ON CONFLICT (idempotency_key) DO NOTHING RETURNING id` shape --
 *     returns `false` (a silent, safe no-op) instead of throwing when the
 *     key is already claimed. For the "this may legitimately be a retry"
 *     call sites: `InventoryService.recordInventoryEvent`,
 *     `OrderService`'s own cancellation-release and return-restock inserts.
 *   - {@link claimInventoryEventIdempotencyKeyOrThrow} mirrors the old
 *     plain `INSERT ...` shape with no `ON CONFLICT` clause, which relied
 *     on the table's own UNIQUE constraint to throw a real error on a
 *     genuine duplicate. For the "this should never legitimately fire
 *     twice, and if it does that's a real bug worth crashing loudly on"
 *     call sites: `InventoryService.transferStock`'s two legs,
 *     `WarehouseService.packOrder`'s pack-shortfall adjustment,
 *     `OrderService.allocateOrder`'s reservation insert.
 *
 * Every caller pre-generates the `inventory_events.id` it's about to use
 * (`randomUUID()`) and passes it in here as `inventoryEventId` *before*
 * inserting the real row with that same explicit id -- `id` still has
 * `DEFAULT gen_random_uuid()` at the table level (for the rare direct-SQL
 * caller, e.g. a test fixture, that doesn't go through these functions),
 * but every real application write path supplies it explicitly now, so the
 * claimed key and the row it's claimed for always agree on the same id.
 */

export async function claimInventoryEventIdempotencyKey(
  client: PoolClient,
  idempotencyKey: string,
  inventoryEventId: string,
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO inventory_event_idempotency_keys (idempotency_key, inventory_event_id)
     VALUES ($1, $2)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING idempotency_key`,
    [idempotencyKey, inventoryEventId],
  );
  return result.rows.length > 0;
}

export async function claimInventoryEventIdempotencyKeyOrThrow(
  client: PoolClient,
  idempotencyKey: string,
  inventoryEventId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO inventory_event_idempotency_keys (idempotency_key, inventory_event_id)
     VALUES ($1, $2)`,
    [idempotencyKey, inventoryEventId],
  );
}
