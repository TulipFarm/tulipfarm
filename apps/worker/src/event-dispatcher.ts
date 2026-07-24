import type { EventOutboxPort } from "@tulipfarm/storage";

export interface EventOutboxDispatcherOptions {
  outbox: EventOutboxPort;
  businessId: string;
  owner: string;
  consumer: string;
  handler: (message: Awaited<ReturnType<EventOutboxPort["claim"]>>[number]) => Promise<void>;
  now: () => string;
  leaseDurationMs?: number;
  batchSize?: number;
  maxAttempts?: number;
  quarantineOwner?: string;
}

export interface DispatchBatchResult {
  claimed: number;
  dispatched: number;
  failed: number;
}

export class EventOutboxDispatcher {
  constructor(private readonly options: EventOutboxDispatcherOptions) {}

  async dispatchBatch(): Promise<DispatchBatchResult> {
    const messages = await this.options.outbox.claim({
      businessId: this.options.businessId,
      owner: this.options.owner,
      now: this.options.now(),
      leaseDurationMs: this.options.leaseDurationMs ?? 60_000,
      limit: this.options.batchSize ?? 25,
    });
    let dispatched = 0;
    let failed = 0;
    for (const message of messages) {
      try {
        await this.options.handler(message);
        await this.options.outbox.complete(
          message.businessId,
          message.id,
          this.options.owner,
          this.options.consumer
        );
        dispatched += 1;
      } catch {
        await this.options.outbox.fail(message.businessId, message.id, this.options.owner, {
          code: "handler_failed",
          maxAttempts: this.options.maxAttempts ?? 5,
          quarantineOwner: this.options.quarantineOwner ?? "integration-operations",
          replayEligible: true,
        });
        failed += 1;
      }
    }
    return { claimed: messages.length, dispatched, failed };
  }
}
