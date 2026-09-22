import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { withTenant, recordAuditEvent } from "@alltix/db";
import {
  DomainEvent,
  InProcessEventBus,
  type EventBus,
  type InventoryChangedPayload,
  type InventoryEventType,
  type InventoryReferenceType,
} from "@alltix/shared";

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

export interface TransferStockInput {
  tenantId: string;
  productId: string;
  fromLocationId: string;
  toLocationId: string;
  /** Must be a positive integer -- see {@link InventoryService.transferStock}'s
   *  doc comment for why this transfers *available* stock, not raw on_hand. */
  quantity: number;
  /** Base key for this transfer -- see transferStock()'s doc comment for how
   *  it becomes two distinct inventory_events.idempotency_key values (one
   *  per leg), and why checking just the outbound leg is enough to detect
   *  "already applied." */
  idempotencyKey: string;
  /** Who initiated this transfer, for the `inventory.transferred` audit
   *  event recorded alongside it -- null (the default) for an internal/
   *  automatic caller, same null-means-no-human-actor semantics
   *  OrderService.transition()'s own `actorUserId` option carries. */
  actorUserId?: string | null;
}

export interface TransferStockResult {
  /** false if `idempotencyKey`'s outbound leg already existed -- this
   *  transfer (both legs; see the doc comment on why checking one leg is
   *  sufficient) was already applied by an earlier call, so this call was a
   *  safe no-op. */
  applied: boolean;
  /** The shared `reference_id` linking this transfer's two inventory_events
   *  rows (reference_type = 'transfer') -- null when `applied` is false,
   *  since nothing new was recorded to link. */
  transferId: string | null;
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
 *   - transfer:             not handled here -- moving stock between two
 *                           locations needs a two-location signature this
 *                           method doesn't have; use {@link
 *                           InventoryService.transferStock} instead. This
 *                           method still throws outright on eventType ===
 *                           'transfer' rather than silently doing the
 *                           wrong thing with one location.
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
 *
 * Publishes `inventory.changed` (DomainEvent.InventoryChanged,
 * {@link InventoryChangedPayload}) after a mutation actually applies --
 * closing CLAUDE.md §1's own stated architecture ("Inventory Service ...
 * publishes `inventory.changed` events"), which until now was true only of
 * the constant's existence, not its behavior: nothing in this codebase ever
 * called `eventBus.publish()` for it. Same "default to a private
 * in-process bus, share a real one when a caller actually has subscribers"
 * shape as OrderService/WarehouseService's own constructors -- and same
 * "publish only after the transaction that made the change has committed"
 * discipline OrderService.persistPulledOrders() already established, so a
 * subscriber's own DB work (a future low-stock notifier, say) is a
 * genuinely separate transaction, never nested inside this one. Not
 * retroactive: the two inline call sites this doc comment already flags
 * above (OrderService.allocateOrder, WarehouseService.packOrder's
 * pack-shortfall path) don't call through this class, so reservation/
 * backorder events and pack-shortfall adjustments do NOT publish
 * `inventory.changed` yet -- only `recordInventoryEvent` and
 * `transferStock`'s real callers do (warehouse-service's own sale
 * consumption during packing, and the manual `/inventory` transfer route).
 * Extending this to the other two flows is the same already-flagged,
 * deliberately-deferred refactor, not a new gap introduced here.
 */
export class InventoryService {
  constructor(
    private readonly pool: Pool,
    private readonly eventBus: EventBus = new InProcessEventBus(),
  ) {}

  private async publishInventoryChanged(tenantId: string, payload: InventoryChangedPayload): Promise<void> {
    await this.eventBus.publish({
      name: DomainEvent.InventoryChanged,
      tenantId,
      occurredAt: new Date().toISOString(),
      payload,
    });
  }

  async recordInventoryEvent(input: RecordInventoryEventInput): Promise<RecordInventoryEventResult> {
    const { tenantId, productId, locationId, eventType, quantityDelta, idempotencyKey } = input;
    const referenceType = input.referenceType ?? null;
    const referenceId = input.referenceId ?? null;

    if (eventType === "transfer") {
      throw new Error(
        "InventoryService.recordInventoryEvent: 'transfer' is not implemented on this method -- moving stock " +
          "between two locations needs a two-location signature this method doesn't have; call " +
          "InventoryService.transferStock() instead",
      );
    }

    const { onHandDelta, reservedDelta } = columnDeltasFor(eventType, quantityDelta);

    const outcome = await withTenant(this.pool, tenantId, async (client) => {
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
        return { applied: false as const, eventId: null, levels: null };
      }

      const levels = await client.query<{ on_hand: number; reserved: number; available: number }>(
        `INSERT INTO inventory_levels (tenant_id, product_id, location_id, on_hand, reserved)
           VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (product_id, location_id) DO UPDATE SET
           on_hand = inventory_levels.on_hand + EXCLUDED.on_hand,
           reserved = inventory_levels.reserved + EXCLUDED.reserved,
           updated_at = now()
         RETURNING on_hand, reserved, available`,
        [tenantId, productId, locationId, onHandDelta, reservedDelta],
      );

      return { applied: true as const, eventId: eventRow.id, levels: levels.rows[0]! };
    });

    // Published after the transaction above has committed -- see this
    // class's own doc comment for why (a subscriber's own DB work must
    // never nest inside this one). No-op (nothing to publish) on the
    // idempotent-replay branch: inventory_levels didn't change, so there is
    // no new state for a subscriber to react to.
    if (outcome.applied) {
      await this.publishInventoryChanged(tenantId, {
        productId,
        locationId,
        eventType,
        onHand: outcome.levels.on_hand,
        reserved: outcome.levels.reserved,
        available: outcome.levels.available,
      });
    }

    return { applied: outcome.applied, eventId: outcome.eventId };
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

  /**
   * Moves stock between two locations for the same product -- the
   * multi-warehouse/3PL capability CLAUDE.md §8 Phase 4 calls for and
   * `recordInventoryEvent`'s own doc comment above flagged as needing a
   * two-location signature it doesn't have. This is that signature.
   *
   * Only ever moves `on_hand`, never `reserved`: a transfer moves physical
   * stock that's actually free to move, not stock a specific order at the
   * source location is already counting on. That's why the sufficiency
   * check below is against `available` (on_hand - reserved), not raw
   * on_hand -- moving reserved-but-not-yet-shipped stock out from under a
   * live reservation would leave that order's allocation pointing at stock
   * that's no longer there. If a tenant genuinely needs to move reserved
   * stock, the order has to be released/re-routed first (a separate,
   * deliberate action) -- this method won't do that implicitly.
   *
   * Concurrency: locks the source (product, location) row with
   * `SELECT ... FOR UPDATE` and re-checks `available` under that lock
   * before mutating anything -- the exact same check-then-act-under-lock
   * discipline `OrderService.allocateOrder` uses (CLAUDE.md §3's "must be
   * atomic... to prevent two orders allocating the last unit
   * simultaneously" applies just as much to two concurrent transfers, or a
   * transfer racing an allocation, draining the same source). The
   * destination side needs no equivalent lock: its mutation is a plain
   * increment (`on_hand + $delta`) via the same upsert-on-first-write
   * pattern `recordInventoryEvent` already uses, which Postgres applies
   * atomically per row regardless of what else is concurrently touching it.
   *
   * Ledger shape: records TWO `inventory_events` rows, both
   * `event_type = 'transfer'` -- one with a negative `quantity_delta` at
   * `fromLocationId`, one with a positive `quantity_delta` at
   * `toLocationId` -- sharing one freshly generated `reference_id`
   * (`reference_type = 'transfer'`, migration
   * 0022_inventory_events_transfer_reference_type.sql) so the two legs of
   * one transfer can be found and displayed together later, the same role
   * reference_type/reference_id already play for 'order' and 'po'. Both
   * legs are inserted in the same DB transaction as the two
   * `inventory_levels` mutations -- either the whole transfer lands or
   * none of it does, never a decrement with no matching increment.
   *
   * Idempotent, like `recordInventoryEvent`: `idempotencyKey` becomes two
   * distinct `inventory_events.idempotency_key` values under the hood
   * (`${idempotencyKey}:out` / `${idempotencyKey}:in`, since the column is
   * UNIQUE per row and this writes two rows) -- but checking whether the
   * outbound leg already exists is enough to know the *whole* transfer
   * already committed, since both legs are always written together in one
   * transaction. A retried call with the same key is therefore a safe
   * no-op, exactly like `recordInventoryEvent`'s own idempotency contract.
   *
   * Throws (nothing is written) for: `fromLocationId === toLocationId`
   * (nonsensical -- there's nothing to move), a non-positive or
   * non-integer `quantity`, or insufficient `available` stock at the
   * source under the lock above.
   *
   * Records one `inventory.transferred` audit event (`input.actorUserId`,
   * defaulting to null) in the same transaction as both legs above -- see
   * recordAuditEvent's own doc comment for why that atomicity matters. Not
   * recorded on the idempotent-replay branch (nothing new happened).
   */
  async transferStock(input: TransferStockInput): Promise<TransferStockResult> {
    const { tenantId, productId, fromLocationId, toLocationId, quantity, idempotencyKey } = input;
    const actorUserId = input.actorUserId ?? null;

    if (fromLocationId === toLocationId) {
      throw new Error("InventoryService.transferStock: fromLocationId and toLocationId must be different locations");
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error(`InventoryService.transferStock: quantity must be a positive integer, got ${quantity}`);
    }

    const outboundKey = `${idempotencyKey}:out`;
    const inboundKey = `${idempotencyKey}:in`;

    const outcome = await withTenant(this.pool, tenantId, async (client) => {
      // Lock the source row and re-check available stock under that lock --
      // see this method's doc comment for why this mirrors
      // OrderService.allocateOrder's own check-then-act discipline.
      const sourceLevel = await client.query<{ available: number }>(
        `SELECT available FROM inventory_levels WHERE product_id = $1 AND location_id = $2 FOR UPDATE`,
        [productId, fromLocationId],
      );
      const availableAtSource = sourceLevel.rows[0]?.available ?? 0;
      if (availableAtSource < quantity) {
        throw new Error(
          `InventoryService.transferStock: insufficient available stock at source location ` +
            `(have ${availableAtSource}, need ${quantity})`,
        );
      }

      // Idempotency check comes after the lock+read above (cheap, and
      // keeps the lock-then-verify order identical regardless of whether
      // this is a fresh call or a retry) but before any write: if the
      // outbound leg already exists, the whole transfer already committed
      // in an earlier call, so there is nothing left to do.
      const existingOutbound = await client.query<{ id: string }>(
        `SELECT id FROM inventory_events WHERE idempotency_key = $1`,
        [outboundKey],
      );
      if (existingOutbound.rows[0]) {
        return { applied: false as const, transferId: null, sourceLevels: null, destLevels: null };
      }

      const transferId = randomUUID();

      await client.query(
        `INSERT INTO inventory_events
           (tenant_id, product_id, location_id, event_type, quantity_delta, reference_type, reference_id, idempotency_key)
         VALUES ($1, $2, $3, 'transfer', $4, 'transfer', $5, $6)`,
        [tenantId, productId, fromLocationId, -quantity, transferId, outboundKey],
      );
      // A plain UPDATE, not the upsert `recordInventoryEvent` uses for its
      // single-location writes -- the sufficiency check above already
      // proved an inventory_levels row exists at the source (a nonexistent
      // row reads available as 0, which fails that check for any positive
      // quantity), so there's nothing to upsert here.
      const sourceLevels = await client.query<{ on_hand: number; reserved: number; available: number }>(
        `UPDATE inventory_levels SET on_hand = on_hand - $1, updated_at = now()
           WHERE product_id = $2 AND location_id = $3
         RETURNING on_hand, reserved, available`,
        [quantity, productId, fromLocationId],
      );

      await client.query(
        `INSERT INTO inventory_events
           (tenant_id, product_id, location_id, event_type, quantity_delta, reference_type, reference_id, idempotency_key)
         VALUES ($1, $2, $3, 'transfer', $4, 'transfer', $5, $6)`,
        [tenantId, productId, toLocationId, quantity, transferId, inboundKey],
      );
      // Upsert here, unlike the source: the destination may be receiving
      // its first-ever stock for this product, exactly the "first event
      // creates the row on the fly" case this class's own doc comment
      // above describes for recordInventoryEvent.
      const destLevels = await client.query<{ on_hand: number; reserved: number; available: number }>(
        `INSERT INTO inventory_levels (tenant_id, product_id, location_id, on_hand, reserved)
           VALUES ($1, $2, $3, $4, 0)
         ON CONFLICT (product_id, location_id) DO UPDATE SET
           on_hand = inventory_levels.on_hand + EXCLUDED.on_hand,
           updated_at = now()
         RETURNING on_hand, reserved, available`,
        [tenantId, productId, toLocationId, quantity],
      );

      // Same transaction as both inventory_events/inventory_levels writes
      // above -- see recordAuditEvent's own doc comment for why that
      // matters (a rolled-back transfer never leaves a committed audit row
      // behind).
      await recordAuditEvent(client, {
        tenantId,
        userId: actorUserId,
        action: "inventory.transferred",
        entityType: "product",
        entityId: productId,
        details: { fromLocationId, toLocationId, quantity, transferId },
      });

      return { applied: true as const, transferId, sourceLevels: sourceLevels.rows[0]!, destLevels: destLevels.rows[0]! };
    });

    // Two events, not one -- see this class's own doc comment and
    // InventoryChangedPayload's own doc comment for why a transfer that
    // touches two (product, location) pairs publishes once per pair rather
    // than one dual-location event. Published after the transaction above
    // has committed, same reasoning as recordInventoryEvent. No-op on the
    // idempotent-replay branch, same reasoning too.
    if (outcome.applied) {
      await this.publishInventoryChanged(tenantId, {
        productId,
        locationId: fromLocationId,
        eventType: "transfer",
        onHand: outcome.sourceLevels.on_hand,
        reserved: outcome.sourceLevels.reserved,
        available: outcome.sourceLevels.available,
      });
      await this.publishInventoryChanged(tenantId, {
        productId,
        locationId: toLocationId,
        eventType: "transfer",
        onHand: outcome.destLevels.on_hand,
        reserved: outcome.destLevels.reserved,
        available: outcome.destLevels.available,
      });
    }

    return { applied: outcome.applied, transferId: outcome.transferId };
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

// --- Stock forecasting (CLAUDE.md §8 Phase 5's "stock forecasting" line,
// v1 scope) -----------------------------------------------------------
//
// Deliberately simple: recent-sales-velocity divided into current available
// stock, nothing more. NOT a demand-forecasting model -- no seasonality, no
// trend detection, no external signals, no purchase-order automation. The
// same "start simple, earn the complexity later" call this codebase already
// made for the event bus, job queue, and /reports' own plain-queries-not-CDC
// approach (see that page's own doc comment). Pure functions, no DB access
// -- callers (currently /inventory and /reports) are responsible for
// aggregating `unitsSoldInWindow` themselves (a `sum(-quantity_delta) WHERE
// event_type = 'sale' AND created_at >= since` query against
// `inventory_events`, grouped by product_id/location_id -- the same ledger
// table every other figure in this app is computed from, never a separate
// count) and for choosing their own window, matching this file's other
// pure-function precedent (`extractUsShippingZip`/`rankByDistanceToShippingZip`
// in `packages/order-service/src/index.ts`): easy to unit test without a
// live Postgres, easy to reuse across pages with different windows.

/** No spec pins this down -- an admittedly arbitrary but documented default
 *  (two weeks), the same "simple heuristic, not a precise one" status
 *  `/inventory`'s own `LOW_STOCK_FALLBACK_THRESHOLD` already carries.
 *  Callers may override it (see `assessStockForecast`'s own `reorderThresholdDays`
 *  parameter) -- not yet exposed as a real per-tenant setting anywhere, that
 *  would be a genuine scope increase, not attempted here. */
export const DEFAULT_REORDER_THRESHOLD_DAYS = 14;

/** Units sold per day over the caller's own lookback window. Guards against
 *  a non-positive `windowDays` (returns 0 rather than dividing by zero or a
 *  negative number) -- defensive against a caller bug, not an expected input,
 *  since every real caller derives `windowDays` from a fixed constant or a
 *  validated period selector, never raw user input. */
export function computeDailyVelocity(unitsSoldInWindow: number, windowDays: number): number {
  if (windowDays <= 0) return 0;
  return unitsSoldInWindow / windowDays;
}

/**
 * Estimated days until `available` reaches zero at the given daily
 * velocity. Two deliberately distinct non-numeric-feeling cases, both real
 * and both worth telling apart in a UI rather than collapsing into one:
 *
 *   - `available <= 0`: already out (or oversold) right now -- returns 0,
 *     not null. This is a real, known answer, not missing information.
 *   - `dailyVelocity <= 0` (available > 0, but no sales in the window):
 *     returns `null`, meaning "can't estimate" -- deliberately NOT
 *     `Infinity`. A product with plenty of stock and zero recent sales
 *     could mean healthy surplus or could mean it stopped selling
 *     entirely; this function has no way to tell those apart, so it says
 *     "unknown" rather than implying "forever safe."
 */
export function computeDaysOfStockRemaining(available: number, dailyVelocity: number): number | null {
  if (available <= 0) return 0;
  if (dailyVelocity <= 0) return null;
  return available / dailyVelocity;
}

export interface StockForecast {
  dailyVelocity: number;
  /** null means "no recent sales activity to estimate from" -- see
   *  {@link computeDaysOfStockRemaining}'s own doc comment. Render this as
   *  "no recent sales" or similar, never as an empty/zero value, which
   *  would misleadingly read as "already out." */
  daysRemaining: number | null;
  /** True only when `daysRemaining` is a real, known number at or below the
   *  threshold -- `null` (unknown) never flags true. This is a real,
   *  documented limitation: a low-stock product with zero recent sales
   *  activity (e.g. a brand-new SKU) will NOT be flagged here, even though
   *  it may genuinely need attention -- that case is already covered by
   *  `/inventory`'s separate, velocity-independent risk badge
   *  (`assessRisk`, buffer/threshold-based), which this is a complement to,
   *  not a replacement for. */
  reorderSoon: boolean;
}

/** Combines the two functions above into the one call site callers actually
 *  want -- see this section's own header comment for what "window" means
 *  and where `unitsSoldInWindow` comes from. */
export function assessStockForecast(
  available: number,
  unitsSoldInWindow: number,
  windowDays: number,
  reorderThresholdDays: number = DEFAULT_REORDER_THRESHOLD_DAYS,
): StockForecast {
  const dailyVelocity = computeDailyVelocity(unitsSoldInWindow, windowDays);
  const daysRemaining = computeDaysOfStockRemaining(available, dailyVelocity);
  const reorderSoon = daysRemaining !== null && daysRemaining <= reorderThresholdDays;
  return { dailyVelocity, daysRemaining, reorderSoon };
}
