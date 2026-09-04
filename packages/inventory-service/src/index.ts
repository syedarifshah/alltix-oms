import type { Pool } from "pg";
import { withTenant } from "@alltix/db";
import type { InventoryEventType, InventoryReferenceType } from "@alltix/shared";

export interface RecordInventoryEventInput {
  tenantId: string;
  productId: string;
  locationId: string;
  eventType: InventoryEventType;
  quantityDelta: number;
  referenceType?: InventoryReferenceType;
  referenceId?: string;
  idempotencyKey: string;
}

export interface RecordInventoryEventResult {
  /** false if `idempotencyKey` already existed on inventory_events -- the
   *  event (and its inventory_levels effect) was already applied by an
   *  earlier call, so this call was a safe no-op. */
  applied: boolean;
  eventId: string | null;
}

/**
 * Owns the stock ledger and the derived `inventory_levels` rollup
 * (CLAUDE.md §1, §2.2). Every stock mutation should go through
 * `recordInventoryEvent` -- nothing else should write to `inventory_levels`
 * directly.
 *
 * Two call sites predate this implementation and still write
 * inventory_events/inventory_levels inline instead of calling through here:
 * OrderService.allocateOrder (reservation/backorder) and
 * WarehouseService.packOrder (pack-shortfall adjustment/damage, which
 * corrects on_hand *and* reserved together -- see the eventType table
 * below). Migrating them to call this class is a follow-up, deliberately
 * not done as part of this change so as not to alter already-tested
 * allocation/pack behavior without new tests pinning down the refactor.
 *
 * `quantityDelta`'s sign always describes its effect on the ledger's view
 * of the change (positive = stock/reservation increasing, negative =
 * decreasing) -- which `inventory_levels` column(s) actually move is a
 * function of `eventType`:
 *
 *   - receipt:              on_hand  += delta   (delta > 0: new stock in)
 *   - sale:                 on_hand  += delta   AND reserved += delta
 *                           (delta < 0: physically consumes stock and
 *                           releases the reservation that was covering it
 *                           -- a sale only ever follows a prior
 *                           reservation, CLAUDE.md §3)
 *   - reservation:          reserved -= delta   (delta < 0: available
 *                           drops as reserved rises)
 *   - release:              reserved -= delta   (delta > 0: available
 *                           rises as reserved falls -- same formula as
 *                           reservation, just the opposite sign, since
 *                           releasing is reservation's inverse)
 *   - adjustment / damage:  on_hand  += delta   -- the standalone case:
 *                           e.g. a cycle-count correction or shrinkage with
 *                           nothing currently reserved against it. The
 *                           different "pack-shortfall" flavor -- correcting
 *                           on_hand *and* reserved together for a line that
 *                           was already reserved -- is a distinct
 *                           two-column case; WarehouseService.packOrder
 *                           still handles that inline rather than through
 *                           this method, since eventType alone can't tell
 *                           the two flavors apart.
 *   - transfer:             not implemented. Moving stock between two
 *                           locations needs a two-location signature this
 *                           method doesn't have yet -- throws rather than
 *                           silently doing the wrong thing with one.
 *
 * Idempotent: `idempotency_key` is UNIQUE on inventory_events (migration
 * 0005), so a retried call with the same key inserts nothing a second time
 * and returns `{ applied: false }` instead of double-applying the
 * inventory_levels mutation -- required since CLAUDE.md §4.4 promises every
 * event handler is safe to run twice.
 *
 * The first event ever recorded for a given (product, location) pair
 * creates its `inventory_levels` row on the fly (upsert), rather than
 * requiring one to be pre-seeded -- CLAUDE.md's own illustrative schema
 * doesn't show a separate "create inventory_levels row" step, and a fresh
 * product's first stock receipt is the natural place for that row to start
 * existing.
 */
export class InventoryService {
  constructor(private readonly pool: Pool) {}

  async recordInventoryEvent(input: RecordInventoryEventInput): Promise<RecordInventoryEventResult> {
    const { tenantId, productId, locationId, eventType, quantityDelta, idempotencyKey } = input;
    const referenceType = input.referenceType ?? null;
    const referenceId = input.referenceId ?? null;

    if (eventType === "transfer") {
      throw new Error(
        "InventoryService.recordInventoryEvent: 'transfer' is not implemented -- moving stock between two " +
          "locations needs a two-location signature this method doesn't have yet",
      );
    }

    const { onHandDelta, reservedDelta } = columnDeltasFor(eventType, quantityDelta);

    return withTenant(this.pool, tenantId, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO inventory_events
           (tenant_id, product_id, location_id, event_type, quantity_delta, reference_type, reference_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [tenantId, productId, locationId, eventType, quantityDelta, referenceType, referenceId, idempotencyKey],
      );

      const eventRow = inserted.rows[0];
      if (!eventRow) {
        // Already applied by an earlier call with this same idempotency
        // key -- inventory_levels was already updated then, so touching it
        // again here would double-apply the delta.
        return { applied: false, eventId: null };
      }

      await client.query(
        `INSERT INTO inventory_levels (tenant_id, product_id, location_id, on_hand, reserved)
           VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (product_id, location_id) DO UPDATE SET
           on_hand = inventory_levels.on_hand + EXCLUDED.on_hand,
           reserved = inventory_levels.reserved + EXCLUDED.reserved,
           updated_at = now()`,
        [tenantId, productId, locationId, onHandDelta, reservedDelta],
      );

      return { applied: true, eventId: eventRow.id };
    });
  }

  /** Postgres computes `available` as a STORED generated column
   *  (`on_hand - reserved`, migration 0006) -- this just reads it. Returns
   *  0 for a (product, location) pair with no inventory_levels row yet,
   *  same convention `OrderService.allocateOrder` uses (`?? 0`), rather
   *  than throwing for stock that simply hasn't arrived yet. */
  async getAvailableToSell(tenantId: string, productId: string, locationId: string): Promise<number> {
    return withTenant(this.pool, tenantId, async (client) => {
      const result = await client.query<{ available: number }>(
        `SELECT available FROM inventory_levels WHERE product_id = $1 AND location_id = $2`,
        [productId, locationId],
      );
      return result.rows[0]?.available ?? 0;
    });
  }
}

function columnDeltasFor(
  eventType: Exclude<InventoryEventType, "transfer">,
  quantityDelta: number,
): { onHandDelta: number; reservedDelta: number } {
  switch (eventType) {
    case "receipt":
    case "adjustment":
    case "damage":
      return { onHandDelta: quantityDelta, reservedDelta: 0 };
    case "sale":
      return { onHandDelta: quantityDelta, reservedDelta: quantityDelta };
    case "reservation":
    case "release":
      return { onHandDelta: 0, reservedDelta: -quantityDelta };
  }
}
