import type { ChannelInboundEvent } from "@tulipfarm/integrations";
import type { ChannelInboundStore as PgChannelInboundStore } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { channelInboundStore } from "./inbound-store";

function event(overrides: Partial<ChannelInboundEvent> = {}): ChannelInboundEvent {
  return {
    eventId: "E1",
    type: "slack.message.received",
    version: 1,
    occurredAt: "2026-07-26T10:00:00.000Z",
    receivedAt: "2026-07-26T10:00:01.000Z",
    businessId: "business-1",
    source: { provider: "slack", externalTenantId: "T1" },
    principal: { kind: "external", externalId: "U1" },
    record: { type: "message", id: "1720000000.000100" },
    deduplicationKey: "E1",
    classification: ["untrusted.external"],
    data: { externalAppId: "A1", channelId: "C1", text: "hi", media: [] },
    verification: { status: "verified", method: "slack_signature" },
    ...overrides,
  };
}

describe("channelInboundStore", () => {
  it("narrows the port event down to the persisted dedup shape", async () => {
    const accept = vi.fn().mockResolvedValue({ outcome: "accepted" });
    const store = { accept } as unknown as PgChannelInboundStore;

    const result = await channelInboundStore(store).accept(event());

    expect(result).toEqual({ outcome: "accepted" });
    expect(accept).toHaveBeenCalledWith({
      businessId: "business-1",
      provider: "slack",
      eventId: "E1",
      deduplicationKey: "E1",
      receivedAt: "2026-07-26T10:00:01.000Z",
    });
  });

  it("passes through a duplicate outcome", async () => {
    const accept = vi.fn().mockResolvedValue({ outcome: "duplicate" });
    const store = { accept } as unknown as PgChannelInboundStore;

    expect(await channelInboundStore(store).accept(event())).toEqual({ outcome: "duplicate" });
  });
});
