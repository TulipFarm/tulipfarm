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

/**
 * Maps a claimed outbox message to the target that owns its topic.
 *
 * Empty at composition today: nothing writes `outbox_messages` yet, and the Integration delivery
 * targets arrive with the adapters in PR 6. Running the loop anyway is deliberate — it proves the
 * claim/complete/fail path end to end now, and an unmatched message quarantines after
 * `maxAttempts` with a named reason instead of being marked dispatched to nowhere.
 */
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
