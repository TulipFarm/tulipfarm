import type { ClaimedOutboxMessage } from "@tulipfarm/storage";

/** Delivers one claimed outbox message to its destination. Registered per topic at composition. */
export type DeliveryTarget = (message: ClaimedOutboxMessage) => Promise<void>;

export class UnregisteredDeliveryTargetError extends Error {
  readonly name = "UnregisteredDeliveryTargetError";

  constructor(
    readonly topic: string,
    readonly messageId: string
  ) {
    super(`no delivery target registered for topic "${topic}" (message ${messageId})`);
  }
}

/** Unmatched topics throw so the outbox loop quarantines them, never marks them delivered. */
export class DeliveryTargetRegistry {
  private readonly targets = new Map<string, DeliveryTarget>();

  register(topic: string, target: DeliveryTarget): void {
    if (this.targets.has(topic)) {
      throw new Error(`duplicate delivery target registered for topic "${topic}"`);
    }
    this.targets.set(topic, target);
  }

  get size(): number {
    return this.targets.size;
  }

  async deliver(message: ClaimedOutboxMessage): Promise<void> {
    const target = this.targets.get(message.topic);
    if (!target) throw new UnregisteredDeliveryTargetError(message.topic, message.id);
    await target(message);
  }
}
