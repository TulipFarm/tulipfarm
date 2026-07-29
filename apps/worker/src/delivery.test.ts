import type { ClaimedOutboxMessage } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { DeliveryTargetRegistry, UnregisteredDeliveryTargetError } from "./delivery";

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

describe("DeliveryTargetRegistry", () => {
  it("routes a message to the target registered for its topic", async () => {
    const registry = new DeliveryTargetRegistry();
    const delivered: string[] = [];
    registry.register("event.accepted", async (message) => {
      delivered.push(message.id);
    });

    await registry.deliver(MESSAGE);

    expect(delivered).toEqual(["message-1"]);
    expect(registry.size).toBe(1);
  });

  it("rejects a duplicate registration rather than silently replacing a target", () => {
    const registry = new DeliveryTargetRegistry();
    registry.register("event.accepted", async () => {});
    expect(() => registry.register("event.accepted", async () => {})).toThrow(
      'duplicate delivery target registered for topic "event.accepted"'
    );
  });

  it("throws with the topic named instead of marking the message dispatched to nowhere", async () => {
    const registry = new DeliveryTargetRegistry();
    await expect(registry.deliver(MESSAGE)).rejects.toThrow(UnregisteredDeliveryTargetError);
    await expect(registry.deliver(MESSAGE)).rejects.toThrow(
      'no delivery target registered for topic "event.accepted" (message message-1)'
    );
  });
});
