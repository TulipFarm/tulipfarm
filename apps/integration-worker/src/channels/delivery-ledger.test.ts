import type { ChannelDeliveryAttempt } from "@tulipfarm/integrations";
import type { ChannelDeliveryStore, PersistedChannelDeliveryRecord } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { channelDeliveryLedger } from "./delivery-ledger";

function attempt(): ChannelDeliveryAttempt {
  return {
    businessId: "business-1",
    integrationId: "integration-1",
    routeId: "route-1",
    idempotencyKey: "run-1",
    provider: "slack",
    destination: "C1",
    agentId: "agent-1",
    principalId: "user-1",
  };
}

function record(
  overrides: Partial<PersistedChannelDeliveryRecord> = {}
): PersistedChannelDeliveryRecord {
  return { ...attempt(), status: "pending", attempts: 1, ...overrides };
}

describe("channelDeliveryLedger", () => {
  it("begin drops persisted-only fields the port record does not carry", async () => {
    const begin = vi
      .fn()
      .mockResolvedValue({ outcome: "started", record: record({ errorCode: "boom" }) });
    const store = { begin } as unknown as ChannelDeliveryStore;

    const result = await channelDeliveryLedger(store).begin(attempt());

    expect(begin).toHaveBeenCalledWith(attempt());
    expect(result.record).not.toHaveProperty("errorCode");
    expect(result.outcome).toBe("started");
  });

  it("complete returns the confirmed record with providerMessageId", async () => {
    const complete = vi
      .fn()
      .mockResolvedValue(record({ status: "confirmed", providerMessageId: "1720000000.0001" }));
    const store = { complete } as unknown as ChannelDeliveryStore;

    const result = await channelDeliveryLedger(store).complete(attempt(), "1720000000.0001");

    expect(complete).toHaveBeenCalledWith(attempt(), "1720000000.0001");
    expect(result.providerMessageId).toBe("1720000000.0001");
  });

  it("fail forwards the failure outcome", async () => {
    const fail = vi.fn().mockResolvedValue(record({ status: "failed", errorCode: "bad" }));
    const store = { fail } as unknown as ChannelDeliveryStore;

    const outcome = { status: "failed" as const, code: "bad" };
    const result = await channelDeliveryLedger(store).fail(attempt(), outcome);

    expect(fail).toHaveBeenCalledWith(attempt(), outcome);
    expect(result.status).toBe("failed");
  });
});
