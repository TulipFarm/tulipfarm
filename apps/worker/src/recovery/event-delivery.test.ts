import type { ClaimedOutboxMessage, EventOutboxPort, OutboxFailure } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { EventOutboxDispatcher } from "../event-dispatcher";

const BUSINESS_ID = "business-1";
const OWNER = "worker-1";
const CONSUMER = "trigger-router";
const NOW = "2026-07-25T10:00:00.000Z";

function message(overrides: Partial<ClaimedOutboxMessage> = {}): ClaimedOutboxMessage {
  return {
    id: "message-1",
    businessId: BUSINESS_ID,
    inboxId: "inbox-1",
    topic: "event.accepted",
    payload: { inboxId: "inbox-1", eventId: "event-1" },
    attempts: 1,
    leaseOwner: OWNER,
    leaseExpiresAt: "2026-07-25T10:01:00.000Z",
    ...overrides,
  };
}

/** Outbox with the receipt-uniqueness and attempt-exhaustion semantics the tables enforce. */
class DurableOutbox implements EventOutboxPort {
  readonly receipts: string[] = [];
  readonly failures: OutboxFailure[] = [];
  readonly quarantined: string[] = [];
  pending: ClaimedOutboxMessage[] = [];

  async claim(): Promise<readonly ClaimedOutboxMessage[]> {
    return this.pending.splice(0);
  }

  async complete(
    _businessId: string,
    messageId: string,
    _owner: string,
    consumer: string
  ): Promise<"recorded" | "duplicate"> {
    const receipt = `${messageId}:${consumer}`;
    if (this.receipts.includes(receipt)) return "duplicate";
    this.receipts.push(receipt);
    return "recorded";
  }

  async fail(
    _businessId: string,
    messageId: string,
    _owner: string,
    failure: OutboxFailure
  ): Promise<"released" | "quarantined"> {
    this.failures.push(failure);
    const attempts = this.failures.length;
    if (attempts < failure.maxAttempts) return "released";
    this.quarantined.push(messageId);
    return "quarantined";
  }
}

function dispatcher(
  outbox: DurableOutbox,
  handler: (delivered: ClaimedOutboxMessage) => Promise<void>,
  maxAttempts?: number
): EventOutboxDispatcher {
  return new EventOutboxDispatcher({
    outbox,
    businessId: BUSINESS_ID,
    owner: OWNER,
    consumer: CONSUMER,
    handler,
    now: () => NOW,
    maxAttempts,
  });
}

describe("event delivery recovery", () => {
  it("records one receipt when a message is redelivered after a lost acknowledgement", async () => {
    const outbox = new DurableOutbox();
    const delivered: string[] = [];
    const dispatch = dispatcher(outbox, async (msg) => {
      delivered.push(msg.id);
    });

    outbox.pending.push(message());
    await dispatch.dispatchBatch();
    // The lease expired before the receipt was observed, so the same message is claimed again.
    outbox.pending.push(message({ attempts: 2 }));
    await dispatch.dispatchBatch();

    expect(delivered).toEqual(["message-1", "message-1"]);
    expect(outbox.receipts).toEqual(["message-1:trigger-router"]);
  });

  it("keeps a failing message replayable until its attempts are exhausted", async () => {
    const outbox = new DurableOutbox();
    const dispatch = dispatcher(
      outbox,
      async () => {
        throw new Error("downstream unavailable");
      },
      2
    );

    outbox.pending.push(message());
    const first = await dispatch.dispatchBatch();
    outbox.pending.push(message({ attempts: 2 }));
    const second = await dispatch.dispatchBatch();

    expect(first).toEqual({ claimed: 1, dispatched: 0, failed: 1 });
    expect(second).toEqual({ claimed: 1, dispatched: 0, failed: 1 });
    expect(outbox.failures.every((failure) => failure.replayEligible)).toBe(true);
    expect(outbox.quarantined).toEqual(["message-1"]);
    expect(outbox.receipts).toEqual([]);
  });

  it("delivers a message that only succeeds on replay, without losing it", async () => {
    const outbox = new DurableOutbox();
    let attempts = 0;
    const dispatch = dispatcher(outbox, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient");
    });

    outbox.pending.push(message());
    await dispatch.dispatchBatch();
    outbox.pending.push(message({ attempts: 2 }));
    const replay = await dispatch.dispatchBatch();

    expect(replay).toEqual({ claimed: 1, dispatched: 1, failed: 0 });
    expect(outbox.receipts).toEqual(["message-1:trigger-router"]);
    expect(outbox.quarantined).toEqual([]);
  });
});
