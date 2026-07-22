/**
 * Provider-neutral queue-optimization port.
 *
 * Capability id `queue` (optional accelerator — see `@tulipfarm/observability`
 * capability catalog). This port only accelerates dispatch; it is never the
 * authoritative handoff. The durable cross-process contract is the PostgreSQL
 * transactional outbox/inbox (dependency-rules §6), so losing this accelerator
 * cannot lose an event or a side effect.
 */

export interface QueueMessage<T> {
  readonly id: string;
  readonly body: T;
}

export interface QueueAcceleratorPort {
  enqueue<T>(topic: string, body: T): Promise<void>;
  reserve<T>(topic: string, max: number): Promise<QueueMessage<T>[]>;
  ack(id: string): Promise<void>;
}
