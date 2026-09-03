import type { DomainEventEnvelope, DomainEventName } from "./events.js";

export type EventHandler<T = unknown> = (event: DomainEventEnvelope<T>) => void | Promise<void>;

/**
 * The seam CLAUDE.md §1's Event Bus (Kafka / SNS+SQS) sits behind once the
 * platform actually needs it -- built now, in-process, per §1's "start as a
 * modular monolith, split out only when scale demands it." Publishers
 * (OrderService) and subscribers (RulesEngine) depend only on this
 * interface, never on each other or on the in-process implementation, so
 * swapping InProcessEventBus for a real SNS+SQS-backed one later is a
 * wiring change, not a rewrite of either side.
 */
export interface EventBus {
  publish<T>(event: DomainEventEnvelope<T>): Promise<void>;
  subscribe<T>(name: DomainEventName, handler: EventHandler<T>): void;
}

/**
 * In-process implementation. One deliberate, documented departure from
 * what a real distributed bus would guarantee: publish() awaits every
 * subscriber's handler before resolving, so a publisher can rely on
 * subscribers having already reacted by the time publish() returns (this
 * is exactly what lets order-service publish 'order.received' and have a
 * routing rule's effect land before allocateOrder() runs next).
 *
 * A real SNS+SQS-backed bus would NOT provide that guarantee -- publish
 * would hand off and return immediately, delivery would be eventually
 * consistent (CLAUDE.md §11 item 1's exact warning). Code relying on
 * synchronous-completion semantics (today: the order.received -> routing ->
 * allocate ordering) is coupling itself to this in-process implementation
 * detail, not to the EventBus interface itself, and will need rework
 * whenever this is actually swapped for a distributed bus. Flagged here
 * rather than left to be discovered later.
 *
 * A single misbehaving subscriber must not be able to take down order
 * ingestion: each handler's error is caught and logged individually,
 * never propagated to the publisher or to other subscribers of the same
 * event. This is the same "keep the pipeline up" reasoning RulesEngine
 * applies one level down for a single rule's own execution failure (see
 * its doc comment) -- applied here one level higher, for a whole
 * subscriber's failure.
 */
export class InProcessEventBus implements EventBus {
  private readonly handlers = new Map<DomainEventName, Array<EventHandler<never>>>();

  async publish<T>(event: DomainEventEnvelope<T>): Promise<void> {
    const handlers = this.handlers.get(event.name) ?? [];
    for (const handler of handlers) {
      try {
        await handler(event as DomainEventEnvelope<never>);
      } catch (err) {
        console.error(`EventBus: subscriber for '${event.name}' threw, continuing`, err);
      }
    }
  }

  subscribe<T>(name: DomainEventName, handler: EventHandler<T>): void {
    const existing = this.handlers.get(name) ?? [];
    existing.push(handler as EventHandler<never>);
    this.handlers.set(name, existing);
  }
}
