/** Optional queue accelerator only; PostgreSQL outbox/inbox remains the durable handoff. */

export interface QueueMessage<T> {
  readonly id: string;
  readonly body: T;
}

export interface QueueAcceleratorPort {
  enqueue<T>(topic: string, body: T): Promise<void>;
  reserve<T>(topic: string, max: number): Promise<QueueMessage<T>[]>;
  ack(id: string): Promise<void>;
}
