import type { ClaimedOutboxMessage, EventOutboxPort, OutboxFailure } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { EventOutboxDispatcher } from "./event-dispatcher";

class FakeOutbox implements EventOutboxPort {
  readonly failures: OutboxFailure[] = [];
  readonly completed: string[] = [];
  messages: ClaimedOutboxMessage[] = [];

  async claim(): Promise<readonly ClaimedOutboxMessage[]> {
    return this.messages.splice(0);
  }

  async complete(_businessId: string, messageId: string): Promise<"recorded" | "duplicate"> {
    this.completed.push(messageId);
    return "recorded";
  }

  async fail(
    _businessId: string,
    _messageId: string,
    _owner: string,
    failure: OutboxFailure
  ): Promise<"released" | "quarantined"> {
    this.failures.push(failure);
    return "released";
  }
}

const MESSAGE: ClaimedOutboxMessage = {
  id: "message-1",
  businessId: "business-1",
  inboxId: "inbox-1",
  topic: "event.accepted",
  payload: { inboxId: "inbox-1", eventId: "event-1" },
  attempts: 1,
  leaseOwner: "worker-1",
  leaseExpiresAt: "2026-07-24T10:01:00.000Z",
};

describe("EventOutboxDispatcher", () => {
  it("records a receipt only after successful delivery", async () => {
    const outbox = new FakeOutbox();
    outbox.messages.push(MESSAGE);
    const delivered: string[] = [];
    const dispatcher = new EventOutboxDispatcher({
      outbox,
      businessId: "business-1",
      owner: "worker-1",
      consumer: "trigger-router",
      now: () => "2026-07-24T10:00:00.000Z",
      handler: async (message) => {
        delivered.push(message.id);
      },
    });

    expect(await dispatcher.dispatchBatch()).toEqual({ claimed: 1, dispatched: 1, failed: 0 });
    expect(delivered).toEqual(["message-1"]);
    expect(outbox.completed).toEqual(["message-1"]);
  });

  it("uses a bounded safe failure code without retaining a thrown protected payload", async () => {
    const outbox = new FakeOutbox();
    outbox.messages.push(MESSAGE);
    const dispatcher = new EventOutboxDispatcher({
      outbox,
      businessId: "business-1",
      owner: "worker-1",
      consumer: "trigger-router",
      now: () => "2026-07-24T10:00:00.000Z",
      handler: async () => {
        throw new Error("secret webhook payload");
      },
    });

    expect(await dispatcher.dispatchBatch()).toEqual({ claimed: 1, dispatched: 0, failed: 1 });
    expect(outbox.completed).toEqual([]);
    expect(outbox.failures).toEqual([
      {
        code: "handler_failed",
        maxAttempts: 5,
        quarantineOwner: "integration-operations",
        replayEligible: true,
      },
    ]);
    expect(JSON.stringify(outbox.failures)).not.toContain("secret webhook payload");
  });
});
