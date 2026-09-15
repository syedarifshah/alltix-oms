import type { Pool, PoolClient } from "pg";
import { withTenant } from "@alltix/db";
import {
  DomainEvent,
  InProcessEventBus,
  isValidOrderTransition,
  type DomainEventName,
  type EventBus,
  type Order,
  type OrderReceivedPayload,
  type OrderStatus,
  type ReturnDisposition,
} from "@alltix/shared";
import type { NormalizedOrder } from "@alltix/channel-connectors";

export interface PersistPulledOrdersResult {
  insertedOrderIds: string[];
  skippedExternalOrderIds: string[];
}

/** The event each simpleTransition() `to` status publishes once its UPDATE
 *  commits. 'allocated' isn't here -- allocateOrder() publishes its own
 *  (either OrderAllocated or OrderBackordered) since it has two possible
 *  outcomes and a richer payload than a plain status flip.
 *
 *  'validated' covers two distinct callers with the same event: a fresh
 *  channel pull's received -> validated step, and a released hold's
 *  on_hold -> validated step (see order-state-machine.ts's ON_HOLD /
 *  BACKORDERED RESOLUTION comment) -- both are "this order is now in the
 *  normal flow, pending allocation," so one event name is correct for
 *  either origin.
 *
 *  'returned' is deliberately NOT here -- it moved to its own dedicated
 *  {@link returnOrder} (see transition()'s dispatch and returnOrder's own
 *  doc comment for why: unlike every other flip below, it needs a
 *  disposition decision and a real ledger side effect for 'sellable',
 *  neither of which a plain guarded UPDATE can express). It still
 *  publishes DomainEvent.OrderReturned itself, just not through this map. */
const SIMPLE_TRANSITION_EVENT: Partial<Record<OrderStatus, DomainEventName>> = {
  validated: DomainEvent.OrderValidated,
  on_hold: DomainEvent.OrderOnHold,
  picking: DomainEvent.OrderPicking,
  packed: DomainEvent.OrderPacked,
  shipped: DomainEvent.OrderShipped,
  delivered: DomainEvent.OrderDelivered,
  refunded: DomainEvent.OrderRefunded,
};

/**
 * Normalizes orders from every channel into one shape and owns the order
 * state machine (CLAUDE.md §1, §3). Skeleton only — no channel connector
 * writes into this yet, and method bodies are unimplemented.
 *
 * Publishes a DomainEvent (packages/shared/src/events.ts) after every
 * successful status change, via the injected EventBus -- defaulted to a
 * fresh InProcessEventBus so every existing call site keeps compiling
 * unchanged, but a real caller (or a test asserting on rule execution)
 * passes a shared bus so RulesEngine can subscribe to it. OrderService
 * never imports or references RulesEngine -- publish-without-knowing-
 * subscribers is the whole point (CLAUDE.md §1).
 */
export class OrderService {
  constructor(
    private readonly pool: Pool,
    private readonly eventBus: EventBus = new InProcessEventBus(),
  ) {}

  private async publish<T>(tenantId: string, name: DomainEventName, payload: T): Promise<void> {
    await this.eventBus.publish({ name, tenantId, occurredAt: new Date().toISOString(), payload });
  }

  /** One-row status lookup -- see persistPulledOrders()'s doc comment for
   *  why it re-checks this after publish() rather than trusting the order
   *  is still 'received'. */
  private async currentStatus(tenantId: string, orderId: string): Promise<OrderStatus> {
    return withTenant(this.pool, tenantId, async (client) => {
      const result = await client.query<{ status: OrderStatus }>(
        `SELECT status FROM orders WHERE id = $1 AND tenant_id = $2`,
        [orderId, tenantId],
      );
      const status = result.rows[0]?.status;
      if (!status) {
        throw new Error(`Order ${orderId} not found for tenant ${tenantId}`);
      }
      return status;
    });
  }

  async receiveOrder(tenantId: string, order: Omit<Order, "id" | "tenantId" | "status">): Promise<Order> {
    return withTenant(this.pool, tenantId, async () => {
      void order;
      throw new Error("OrderService.receiveOrder: not implemented");
    });
  }

  /**
   * Moves an order to `to`, rejecting transitions the state machine
   * (packages/shared/src/order-state-machine.ts) doesn't allow. Returns the
   * order's actual resulting status, which for `to === 'allocated'` can
   * differ from what was requested: an allocation attempt that finds
   * insufficient stock lands the order in 'backordered' instead (CLAUDE.md
   * §3) rather than throwing, since that's an expected outcome of the
   * attempt, not a caller error.
   *
   * 'validated', 'on_hold', 'picking', 'packed', 'shipped', 'delivered',
   * and 'refunded' are all plain guarded status flips (see
   * {@link simpleTransition}) -- 'validated' is a pass-through today (only
   * the state-machine edge is enforced, no real validation logic exists
   * yet), reached either from 'received' (a fresh channel pull) or from
   * 'on_hold' (a released hold, see order-state-machine.ts's ON_HOLD /
   * BACKORDERED RESOLUTION comment); 'on_hold' itself is reachable here
   * (from 'validated') for a caller that already has the order there and
   * wants to place a hold directly -- note RulesEngine's own 'hold_order'
   * automation action does NOT call this method to do it, see that class's
   * doc comment for why (atomicity with its rule_executions bookkeeping
   * write); 'picking'/'packed'/'shipped' are
   * called by WarehouseService (CLAUDE.md §1) once it's done its own
   * picklist/inventory-adjustment/channel-confirmation work, so the order
   * state machine stays owned in exactly one place rather than
   * WarehouseService writing to `orders.status` itself; 'delivered' and
   * 'refunded' are two of the three branches CLAUDE.md §3 draws off
   * 'shipped', and touch nothing in the inventory ledger -- 'refunded' is a
   * money-side event with no physical-goods counterpart in this state
   * machine (it's only reachable directly from 'shipped', not via
   * 'returned'). 'allocated' goes through
   * {@link allocateOrder} instead since it has a real sufficiency check and
   * two possible outcomes -- reachable from 'validated' (the normal path)
   * or 'backordered' (a manual retry once stock may have arrived; same
   * check either way, so a retry that's still short just lands back on
   * 'backordered' rather than throwing). 'cancelled' goes through
   * {@link cancelOrder} instead, since (unlike the plain flips above) it
   * sometimes has to release a live reservation first -- see its own doc
   * comment. 'returned' -- CLAUDE.md §3's third branch off 'shipped' --
   * goes through {@link returnOrder} instead: `options.disposition` is
   * REQUIRED for this `to` value (throws otherwise, see returnOrder's own
   * doc comment for why there's deliberately no default) and decides
   * whether this restocks the exact quantity the order's own 'sale' ledger
   * events say it consumed when shipped. No other `to` value is
   * implemented.
   */
  async transition(
    tenantId: string,
    orderId: string,
    from: OrderStatus,
    to: OrderStatus,
    options?: { disposition?: ReturnDisposition },
  ): Promise<OrderStatus> {
    if (!isValidOrderTransition(from, to)) {
      throw new Error(`Invalid order transition: ${from} -> ${to}`);
    }

    if (to === "allocated") {
      return this.allocateOrder(tenantId, orderId, from);
    }

    if (to === "returned") {
      return this.returnOrder(tenantId, orderId, from, options?.disposition);
    }

    if (
      to === "validated" ||
      to === "on_hold" ||
      to === "picking" ||
      to === "packed" ||
      to === "shipped" ||
      to === "delivered" ||
      to === "refunded"
    ) {
      return this.simpleTransition(tenantId, orderId, from, to);
    }

    if (to === "cancelled") {
      return this.cancelOrder(tenantId, orderId, from);
    }

    throw new Error(`OrderService.transition: '${from}' -> '${to}' is not implemented yet`);
  }

  /** States {@link cancelOrder} has already reserved inventory to release
   *  for -- see its own doc comment. Every other cancellable state
   *  (received/validated/on_hold/backordered) never got as far as
   *  allocateOrder(), so there's nothing to release. */
  private static readonly CANCEL_RELEASES_RESERVATION: ReadonlySet<OrderStatus> = new Set(["allocated", "picking"]);

  /**
   * Cancels an order from `from` (packages/shared/src/order-state-machine.ts
   * decides which `from` values are even reachable here -- transition()
   * already rejected anything else before this runs). CLAUDE.md §3:
   * "Cancellation after allocation must emit a release inventory event, not
   * just delete the reservation -- the ledger should show *why* stock came
   * back."
   *
   * Everything happens in one transaction -- the guarded status flip and
   * (when one exists) the reservation release -- same "an order is never
   * left half-mutated" discipline {@link allocateOrder} uses, and for the
   * same reason: releasing inventory for a cancellation that then turns out
   * to lose a concurrent race (the `WHERE status = from` guard fails) would
   * let a competing order allocate stock this one hadn't actually given up
   * yet. Written inline rather than through InventoryService
   * (@alltix/inventory-service) because that class always opens its own
   * separate transaction -- composing it here would mean either two
   * round-trips with a window between them, or not composing at all; this
   * codebase's own precedent for this exact situation is
   * {@link allocateOrder} staying inline for the same reason (see
   * InventoryService's class doc comment).
   *
   * For 'allocated'/'picking' (the two states with a live reservation --
   * see CANCEL_RELEASES_RESERVATION above), releases exactly what the
   * ledger itself recorded as reserved for this order: reads every
   * still-standing 'reservation' inventory_events row for
   * (reference_type='order', reference_id=orderId) and emits one matching
   * 'release' event per row -- the ledger's own record of what was reserved
   * is the source of truth, not a fresh recomputation from order_lines that
   * could drift from it. One release event per original reservation event
   * (not aggregated by product) so the idempotency key can just reuse that
   * event's own id -- naturally unique, no risk of colliding with itself if
   * an order has two lines for the same product at the same location
   * (allocateOrder inserts one reservation row per order_line, not per
   * product -- see its own comment). Same idempotency-safe shape
   * InventoryService.recordInventoryEvent uses: the inventory_levels UPDATE
   * only runs if the INSERT actually inserted a new event row (RETURNING
   * id), so retrying this method after a partial failure can never
   * double-release.
   *
   * No reservation exists yet for the other cancellable states
   * (received/validated/on_hold/backordered never reached allocateOrder()),
   * so those are a plain guarded status flip with nothing to release.
   *
   * Why only up to 'picking', not 'packed': decided explicitly (see
   * order-state-machine.ts's CANCELLATION SCOPE comment) -- past 'packed'
   * the order is physically boxed, and undoing that needs a person to
   * unpack it, not a button in this app. 'shipped' already has its own
   * CLAUDE.md §3-drawn path to returned/refunded instead of cancellation.
   */
  private async cancelOrder(tenantId: string, orderId: string, from: OrderStatus): Promise<OrderStatus> {
    await withTenant(this.pool, tenantId, async (client) => {
      const result = await client.query(
        `UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = $1 AND tenant_id = $2 AND status = $3`,
        [orderId, tenantId, from],
      );
      if (result.rowCount === 0) {
        throw new Error(
          `Order ${orderId} is not in status '${from}' -- refusing cancellation (concurrent update?)`,
        );
      }

      if (!OrderService.CANCEL_RELEASES_RESERVATION.has(from)) {
        return;
      }

      const reservations = await client.query<{
        id: string;
        product_id: string;
        location_id: string;
        quantity_delta: number;
      }>(
        `SELECT id, product_id, location_id, quantity_delta FROM inventory_events
          WHERE tenant_id = $1 AND reference_type = 'order' AND reference_id = $2 AND event_type = 'reservation'`,
        [tenantId, orderId],
      );

      for (const row of reservations.rows) {
        // Reservation rows store a negative quantity_delta (CLAUDE.md
        // §2.2: "reserved -= delta"); releasing needs the positive
        // magnitude being given back.
        const releaseQuantity = -row.quantity_delta;
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO inventory_events
             (tenant_id, product_id, location_id, event_type, quantity_delta, reference_type, reference_id, idempotency_key)
           VALUES ($1, $2, $3, 'release', $4, 'order', $5, $6)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING id`,
          [tenantId, row.product_id, row.location_id, releaseQuantity, orderId, `order-cancellation:${orderId}:${row.id}`],
        );
        if (inserted.rows[0]) {
          await client.query(
            `UPDATE inventory_levels SET reserved = reserved - $1, updated_at = now()
               WHERE product_id = $2 AND location_id = $3`,
            [releaseQuantity, row.product_id, row.location_id],
          );
        }
      }
    });

    await this.publish(tenantId, DomainEvent.OrderCancelled, { orderId });
    return "cancelled";
  }

  /**
   * shipped -> returned, with the inventory disposition decision CLAUDE.md
   * §3 always described as "a separate manual inventory adjustment" now
   * folded into this one call instead of being left as an unstated,
   * un-auditable manual step a human might or might not remember to do
   * later. `disposition` is REQUIRED -- there is no default, because
   * guessing either way would be wrong for some real return: silently
   * restocking a genuinely damaged unit inflates on_hand with stock that
   * doesn't really exist to sell, and silently NOT restocking a perfectly
   * sellable return quietly loses real, sellable inventory forever. A
   * caller (the order detail page's dedicated return form, see
   * order-status.ts) must say which one this is.
   *
   *  - 'sellable': restocks exactly what {@link
   *    WarehouseService.recordShipmentSaleEvents} (packages/warehouse-service)
   *    consumed when this order shipped -- read back off the ORDER'S OWN
   *    'sale' inventory_events rows (same product/location/quantity), not
   *    recomputed from order_lines independently. Same "the ledger's own
   *    record is the source of truth" precedent {@link cancelOrder} already
   *    established for releasing reservations off the matching 'reservation'
   *    rows, applied here to 'sale' rows instead. Written as a 'receipt'
   *    event (CLAUDE.md's own eventType table: "new stock in," which a
   *    sellable return genuinely is) with `reference_type = 'return'`
   *    (packages/shared/src/types.ts's InventoryReferenceType) -- that
   *    reference type has existed in the schema since the inventory ledger
   *    was first designed but was never actually written anywhere until
   *    this method. Idempotency key `order-return:<orderId>:<saleEventId>`,
   *    keyed off the sale event's own row id (mirroring cancelOrder's own
   *    `order-cancellation:<orderId>:<reservationEventId>` shape) -- a
   *    distinct event from the sale it's reversing, not a literal
   *    reversal-by-reference of that row.
   *  - 'damaged': flips status with no restock at all -- the unit is gone,
   *    not back on a shelf to sell, so there's nothing for the ledger to
   *    add back. (A tenant that wants an explicit shrinkage/write-off record
   *    for a damaged return can still log one separately via
   *    InventoryService.recordInventoryEvent's 'damage' eventType -- this
   *    method doesn't do that automatically, since there's no quantity this
   *    method itself knows to attribute the write-off to beyond what the
   *    sale already consumed.)
   *
   * If this order has no matching 'sale' events at all (it shipped before
   * WarehouseService.recordShipmentSaleEvents existed, or has zero lines),
   * 'sellable' silently restocks nothing rather than throwing -- a missing
   * historical sale event is a pre-existing data gap this method shouldn't
   * block a real return over.
   *
   * Everything -- the guarded flip and every restock event/inventory_levels
   * update for 'sellable' -- happens in one transaction, same "an order is
   * never left half-mutated" discipline {@link cancelOrder} uses: a return
   * that loses a concurrent race (the order already moved off 'shipped')
   * must not have already restocked inventory for a return that didn't
   * actually happen. Written inline against inventory_events/inventory_levels
   * rather than composed through InventoryService, for the same
   * transaction-boundary reason cancelOrder() already gives for doing the
   * same thing with its own release events.
   */
  private async returnOrder(
    tenantId: string,
    orderId: string,
    from: OrderStatus,
    disposition: ReturnDisposition | undefined,
  ): Promise<OrderStatus> {
    if (!disposition) {
      throw new Error(
        "OrderService.transition: 'returned' requires options.disposition ('sellable' or 'damaged') -- " +
          "restocking behavior depends on it, so this can't default silently either way",
      );
    }

    await withTenant(this.pool, tenantId, async (client) => {
      const result = await client.query(
        `UPDATE orders SET status = 'returned', updated_at = now() WHERE id = $1 AND tenant_id = $2 AND status = $3`,
        [orderId, tenantId, from],
      );
      if (result.rowCount === 0) {
        throw new Error(
          `Order ${orderId} is not in status '${from}' -- refusing return (concurrent update?)`,
        );
      }

      if (disposition !== "sellable") {
        return;
      }

      const soldLines = await client.query<{
        id: string;
        product_id: string;
        location_id: string;
        quantity_delta: number;
      }>(
        `SELECT id, product_id, location_id, quantity_delta FROM inventory_events
          WHERE tenant_id = $1 AND reference_type = 'order' AND reference_id = $2 AND event_type = 'sale'`,
        [tenantId, orderId],
      );

      for (const row of soldLines.rows) {
        // Sale rows store a negative quantity_delta (on_hand/reserved both
        // dropped when it shipped) -- restocking needs the positive
        // magnitude being given back.
        const restockQuantity = -row.quantity_delta;
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO inventory_events
             (tenant_id, product_id, location_id, event_type, quantity_delta, reference_type, reference_id, idempotency_key)
           VALUES ($1, $2, $3, 'receipt', $4, 'return', $5, $6)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING id`,
          [tenantId, row.product_id, row.location_id, restockQuantity, orderId, `order-return:${orderId}:${row.id}`],
        );
        if (inserted.rows[0]) {
          await client.query(
            `UPDATE inventory_levels SET on_hand = on_hand + $1, updated_at = now()
               WHERE product_id = $2 AND location_id = $3`,
            [restockQuantity, row.product_id, row.location_id],
          );
        }
      }
    });

    await this.publish(tenantId, DomainEvent.OrderReturned, { orderId, disposition });
    return "returned";
  }

  /** A status flip with no side effects beyond the guarded UPDATE itself --
   *  the `WHERE status = from` clause is the concurrency guard (a
   *  concurrent transition away from `from` makes this a no-op, caught via
   *  `rowCount === 0`), the same pattern {@link allocateOrder} uses via an
   *  explicit row lock instead, appropriate here since there's no
   *  multi-step read-then-decide logic to protect. */
  private async simpleTransition(
    tenantId: string,
    orderId: string,
    from: OrderStatus,
    to: OrderStatus,
  ): Promise<OrderStatus> {
    await withTenant(this.pool, tenantId, async (client) => {
      const result = await client.query(
        `UPDATE orders SET status = $1, updated_at = now() WHERE id = $2 AND tenant_id = $3 AND status = $4`,
        [to, orderId, tenantId, from],
      );
      if (result.rowCount === 0) {
        throw new Error(
          `Order ${orderId} is not in status '${from}' -- refusing transition to '${to}' (concurrent update?)`,
        );
      }
    });

    const eventName = SIMPLE_TRANSITION_EVENT[to];
    if (eventName) {
      await this.publish(tenantId, eventName, { orderId });
    }
    return to;
  }

  /**
   * Attempts to allocate `orderId`: for each order_line, locks its product's
   * inventory_levels row (SELECT ... FOR UPDATE) so two concurrent
   * allocation attempts against the same product serialize instead of both
   * reading stale `available` and both succeeding (CLAUDE.md §3, §7, §11.2)
   * -- Postgres re-reads the row's latest committed value once a blocked
   * FOR UPDATE lock is granted, even under the default READ COMMITTED
   * isolation level, which is exactly what makes this check-then-act safe
   * without a stronger isolation level.
   *
   * All locks are taken, and the sufficiency decision made, before any
   * mutation -- an order is never partially allocated. If every line has
   * enough stock: inserts one 'reservation' inventory_events row per line,
   * increments inventory_levels.reserved for each (inventory_levels is a
   * derived rollup per CLAUDE.md §2.2 with no trigger to refresh it yet, so
   * the app must update it explicitly, in the same transaction as the
   * event), and moves the order to 'allocated'. Otherwise the order moves
   * to 'backordered' and nothing is reserved.
   *
   * An order with zero order_lines is treated as vacuously allocatable
   * (nothing to reserve, nothing that can be insufficient) rather than an
   * error. AmazonConnector.pullOrders() now fetches real line items, but a
   * channel adapter with no items on an order (or a future channel that
   * genuinely has none) shouldn't be unable to ever leave 'validated'.
   *
   * Location selection is now stock-aware across every one of the tenant's
   * warehouse locations, not just one: resolveCandidateLocations() builds
   * an ordered list -- orders.preferred_location_id first (a
   * route_to_warehouse rule action applied while the order was still
   * 'received' -- see RulesEngine and events.ts's OrderReceivedPayload),
   * which must resolve to a real, tenant-owned, type='warehouse' location
   * or this throws outright (a routing decision that points at garbage
   * should fail loudly, not be silently ignored), then every other
   * warehouse location oldest-created-first as fallbacks. This method
   * locks every (location, product) pair across ALL candidates before
   * choosing, then walks the candidates in that priority order and
   * allocates entirely against the first one with enough stock for every
   * line -- the order still never splits across locations, and this does
   * NOT do nearest-by-shipping-address or per-SKU routing (CLAUDE.md §8
   * Phase 4 tracks both as separately-scoped, not-yet-built gaps). If no
   * candidate has enough stock, the order backorders exactly as before.
   */
  private async allocateOrder(tenantId: string, orderId: string, expectedFromStatus: OrderStatus): Promise<OrderStatus> {
    const result = await withTenant(this.pool, tenantId, async (client) => {
      const orderResult = await client.query<{ status: OrderStatus; preferred_location_id: string | null }>(
        `SELECT status, preferred_location_id FROM orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [orderId, tenantId],
      );
      const orderRow = orderResult.rows[0];
      if (!orderRow) {
        throw new Error(`Order ${orderId} not found for tenant ${tenantId}`);
      }
      if (orderRow.status !== expectedFromStatus) {
        throw new Error(
          `Order ${orderId} is in status '${orderRow.status}', not '${expectedFromStatus}' -- refusing allocation (concurrent update?)`,
        );
      }

      const lines = await client.query<{ id: string; product_id: string; quantity: number }>(
        `SELECT id, product_id, quantity FROM order_lines WHERE order_id = $1 AND tenant_id = $2`,
        [orderId, tenantId],
      );

      if (lines.rows.length === 0) {
        await client.query(
          `UPDATE orders SET status = 'allocated', updated_at = now() WHERE id = $1 AND tenant_id = $2`,
          [orderId, tenantId],
        );
        return { status: "allocated" as const, locationId: null };
      }

      const candidateLocationIds = await this.resolveCandidateLocations(
        client,
        tenantId,
        orderRow.preferred_location_id,
      );

      // Sum requested quantity per product first (an order can have more
      // than one line for the same product) so each product's row is only
      // locked once per location.
      const requestedByProduct = new Map<string, number>();
      for (const line of lines.rows) {
        requestedByProduct.set(line.product_id, (requestedByProduct.get(line.product_id) ?? 0) + line.quantity);
      }
      const productIds = [...requestedByProduct.keys()];

      // Lock every (location, product) pair this order might use, across
      // ALL candidate locations, in one GLOBAL canonical order -- sorted by
      // location_id then product_id, the SAME order regardless of this
      // order's own preferred_location_id. Two concurrent allocation
      // attempts can have opposite location preferences (order A prefers
      // WH-1 then WH-2; order B prefers WH-2 then WH-1) with overlapping
      // products -- locking in each order's own priority order could
      // deadlock them against each other. Locking in one shared,
      // order-independent order avoids that, while still gathering full
      // availability data (across every candidate) before any location is
      // chosen.
      const sortedLocationIds = [...candidateLocationIds].sort();
      const sortedProductIds = [...productIds].sort();
      const availableByLocation = new Map<string, Map<string, number>>();
      for (const locationId of sortedLocationIds) {
        const availableByProduct = new Map<string, number>();
        for (const productId of sortedProductIds) {
          const levelResult = await client.query<{ available: number }>(
            `SELECT available FROM inventory_levels WHERE product_id = $1 AND location_id = $2 FOR UPDATE`,
            [productId, locationId],
          );
          availableByProduct.set(productId, levelResult.rows[0]?.available ?? 0);
        }
        availableByLocation.set(locationId, availableByProduct);
      }

      // Now choose, in PRIORITY order (preferred first, then
      // oldest-created fallbacks), the first candidate location where
      // every product's available quantity -- from the data just gathered
      // under lock above, not a fresh read -- covers what this order
      // needs.
      let chosenLocationId: string | null = null;
      for (const locationId of candidateLocationIds) {
        const availableByProduct = availableByLocation.get(locationId)!;
        const sufficient = [...requestedByProduct.entries()].every(
          ([productId, quantity]) => (availableByProduct.get(productId) ?? 0) >= quantity,
        );
        if (sufficient) {
          chosenLocationId = locationId;
          break;
        }
      }

      if (!chosenLocationId) {
        await client.query(
          `UPDATE orders SET status = 'backordered', updated_at = now() WHERE id = $1 AND tenant_id = $2`,
          [orderId, tenantId],
        );
        return { status: "backordered" as const, locationId: null };
      }

      for (const line of lines.rows) {
        await client.query(
          `INSERT INTO inventory_events
             (tenant_id, product_id, location_id, event_type, quantity_delta, reference_type, reference_id, idempotency_key)
           VALUES ($1, $2, $3, 'reservation', $4, 'order', $5, $6)`,
          [
            tenantId,
            line.product_id,
            chosenLocationId,
            -line.quantity,
            orderId,
            `order-allocation:${orderId}:${line.id}`,
          ],
        );
        await client.query(
          `UPDATE inventory_levels SET reserved = reserved + $1, updated_at = now()
             WHERE product_id = $2 AND location_id = $3`,
          [line.quantity, line.product_id, chosenLocationId],
        );
      }

      await client.query(
        `UPDATE orders SET status = 'allocated', updated_at = now() WHERE id = $1 AND tenant_id = $2`,
        [orderId, tenantId],
      );
      return { status: "allocated" as const, locationId: chosenLocationId };
    });

    if (result.status === "allocated") {
      await this.publish(tenantId, DomainEvent.OrderAllocated, { orderId, locationId: result.locationId });
    } else {
      await this.publish(tenantId, DomainEvent.OrderBackordered, { orderId });
    }
    return result.status;
  }

  /** Resolves the ORDERED list of warehouse locations allocateOrder() may
   *  reserve against, in priority order. `preferredLocationId` (from
   *  orders.preferred_location_id) is tried first when present and must
   *  resolve to a real, tenant-owned, type='warehouse' location -- throws
   *  otherwise rather than silently falling back or silently excluding it
   *  from the list. Every other tenant warehouse location follows,
   *  oldest-created first (the original single-location default, now a
   *  fallback rather than the only option) -- this is what lets
   *  allocateOrder() try a second warehouse instead of backordering the
   *  moment the preferred/default one is short. Throws if the tenant has
   *  no warehouse location at all. */
  private async resolveCandidateLocations(
    client: PoolClient,
    tenantId: string,
    preferredLocationId: string | null,
  ): Promise<string[]> {
    let preferred: string | null = null;
    if (preferredLocationId) {
      const preferredResult = await client.query<{ id: string }>(
        `SELECT id FROM locations WHERE id = $1 AND tenant_id = $2 AND type = 'warehouse'`,
        [preferredLocationId, tenantId],
      );
      const preferredRow = preferredResult.rows[0];
      if (!preferredRow) {
        throw new Error(
          `Order's preferred_location_id ${preferredLocationId} does not resolve to a real ` +
            `'warehouse' location for tenant ${tenantId} -- refusing to fall back silently`,
        );
      }
      preferred = preferredRow.id;
    }

    const others = await client.query<{ id: string }>(
      preferred
        ? `SELECT id FROM locations WHERE tenant_id = $1 AND type = 'warehouse' AND id <> $2 ORDER BY created_at ASC`
        : `SELECT id FROM locations WHERE tenant_id = $1 AND type = 'warehouse' ORDER BY created_at ASC`,
      preferred ? [tenantId, preferred] : [tenantId],
    );

    const candidates = preferred ? [preferred, ...others.rows.map((r) => r.id)] : others.rows.map((r) => r.id);
    if (candidates.length === 0) {
      throw new Error(`Tenant ${tenantId} has no warehouse location to allocate against`);
    }
    return candidates;
  }

  /**
   * Persists orders pulled from a ChannelConnector.pullOrders() call
   * (CLAUDE.md §4.3) into orders/order_lines. New orders land in 'received'
   * (CLAUDE.md §3) -- the state machine hasn't run yet, so a channel's own
   * status (`NormalizedOrder.channelStatus`) is intentionally not consulted
   * here. Dedupes on the (tenant_id, channel, external_order_id) UNIQUE
   * constraint (CLAUDE.md §2.3) via ON CONFLICT DO NOTHING, so re-pulling an
   * overlapping time window is idempotent rather than a duplicate-insert
   * error or a silent overwrite of whatever status the order has since
   * moved to. The insert batch is one transaction (via withTenant): if any
   * order's lines can't be persisted, none of the batch is.
   *
   * Once inserts are committed, every newly-inserted order (not skipped
   * ones -- they already went through this before) publishes 'order.received'
   * and is walked through received -> validated -> allocated so it doesn't
   * sit at 'received' forever. That has to happen *after* the insert
   * transaction commits, in its own transaction per order: allocateOrder()
   * runs on a different connection (via its own withTenant), and until this
   * transaction commits, that connection's MVCC snapshot can't see the row
   * this one just inserted.
   *
   * 'order.received' is published *before* the validated/allocated
   * transitions specifically so a routing rule (RulesEngine, subscribed to
   * OrderReceived) has a chance to set orders.preferred_location_id before
   * allocateOrder() reads it -- see resolveCandidateLocations(). A
   * *different* kind of rule (RulesEngine's 'hold_order' action) can instead
   * move the order all the way to 'on_hold' during that same publish() call
   * (InProcessEventBus.publish() awaits every subscriber before returning,
   * so this already happened by the time publish() resolves below) -- this
   * loop re-checks the order's actual status before continuing its own
   * chain and skips it if a subscriber already moved it off 'received',
   * rather than blindly issuing 'received' -> 'validated' next: that guarded
   * UPDATE would match zero rows and throw, and since nothing here catches
   * per-order errors, an uncaught throw would abort the rest of this whole
   * batch, not just this one order.
   */
  async persistPulledOrders(tenantId: string, orders: NormalizedOrder[]): Promise<PersistPulledOrdersResult> {
    const { insertedOrders, skippedExternalOrderIds } = await withTenant(this.pool, tenantId, async (client) => {
      const insertedOrders: Array<{ id: string; order: NormalizedOrder }> = [];
      const skippedExternalOrderIds: string[] = [];

      for (const order of orders) {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO orders
             (tenant_id, channel, external_order_id, status, customer, shipping_address, placed_at, raw_payload)
           VALUES ($1, $2, $3, 'received', $4, $5, $6, $7)
           ON CONFLICT (tenant_id, channel, external_order_id) DO NOTHING
           RETURNING id`,
          [
            tenantId,
            order.channel,
            order.externalOrderId,
            JSON.stringify(order.customer),
            JSON.stringify(order.shippingAddress),
            order.placedAt,
            JSON.stringify(order.rawPayload),
          ],
        );

        const orderRow = inserted.rows[0];
        if (!orderRow) {
          skippedExternalOrderIds.push(order.externalOrderId);
          continue;
        }

        insertedOrders.push({ id: orderRow.id, order });
        await insertOrderLines(client, tenantId, orderRow.id, order);
        await incrementOrdersProcessedUsage(client, tenantId);
      }

      return { insertedOrders, skippedExternalOrderIds };
    });

    for (const { id: orderId, order } of insertedOrders) {
      const payload: OrderReceivedPayload = {
        orderId,
        channel: order.channel,
        channelMarketplace: order.channelMarketplace,
        externalOrderId: order.externalOrderId,
        shippingAddress: order.shippingAddress,
      };
      await this.publish(tenantId, DomainEvent.OrderReceived, payload);

      const statusAfterPublish = await this.currentStatus(tenantId, orderId);
      if (statusAfterPublish !== "received") {
        continue;
      }

      await this.transition(tenantId, orderId, "received", "validated");
      await this.transition(tenantId, orderId, "validated", "allocated");
    }

    return { insertedOrderIds: insertedOrders.map((o) => o.id), skippedExternalOrderIds };
  }
}

/**
 * Bumps this tenant's current-month order count (CLAUDE.md §1 Billing:
 * "usage metering (orders processed, SKUs, users)" -- see migration
 * 0016_billing.sql for why this is a real incremented counter rather than a
 * derived COUNT(*), and why it lives here in the same transaction as the
 * order insert instead of behind a decoupled event subscriber: an order
 * that's inserted but not counted (or vice versa) is a billing-usage bug,
 * not a "some optional side effect didn't run" -- the ledger and the
 * counter must never be able to drift apart. One UPSERT, atomic with the
 * INSERT into `orders` above.
 */
async function incrementOrdersProcessedUsage(client: PoolClient, tenantId: string): Promise<void> {
  const month = new Date().toISOString().slice(0, 7); // 'YYYY-MM', UTC
  await client.query(
    `INSERT INTO tenant_usage (tenant_id, month, orders_processed)
     VALUES ($1, $2, 1)
     ON CONFLICT (tenant_id) DO UPDATE SET
       orders_processed = CASE WHEN tenant_usage.month = EXCLUDED.month THEN tenant_usage.orders_processed + 1 ELSE 1 END,
       month = EXCLUDED.month,
       updated_at = now()`,
    [tenantId, month],
  );
}

/**
 * Resolves each line's product via channel_listings (channel + external_sku
 * -> product_id, CLAUDE.md §2.1) and inserts it. Fails loudly (aborting the
 * whole batch's transaction) rather than silently dropping a line on an
 * unresolved SKU -- a real seller catalog must be synced into
 * channel_listings before its orders can be persisted with lines intact.
 */
async function insertOrderLines(
  client: PoolClient,
  tenantId: string,
  orderId: string,
  order: NormalizedOrder,
): Promise<void> {
  for (const line of order.lines) {
    const listing = await client.query<{ product_id: string }>(
      `SELECT product_id FROM channel_listings WHERE channel = $1 AND external_sku = $2 LIMIT 1`,
      [order.channel, line.externalSku],
    );
    const productId = listing.rows[0]?.product_id;
    if (!productId) {
      throw new Error(
        `No channel_listings match for channel=${order.channel} external_sku=${line.externalSku} ` +
          `(order ${order.externalOrderId}) -- cannot resolve product_id for order_lines`,
      );
    }
    await client.query(
      `INSERT INTO order_lines (tenant_id, order_id, product_id, quantity, unit_price, fulfillment_type)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenantId, orderId, productId, line.quantity, line.unitPrice, line.fulfillmentType],
    );
  }
}
