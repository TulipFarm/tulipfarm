import type { IntegrationStore } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { channelDeliveryAuthorization } from "./delivery-authorization";

function input() {
  return {
    businessId: "business-1",
    integrationId: "integration-1",
    routeId: "route-1",
    agentId: "agent-1",
    principalId: "user-1",
    destination: "C1",
  };
}

describe("channelDeliveryAuthorization", () => {
  it("allows when both integration and route are active", async () => {
    const loadDeliveryStatus = vi
      .fn()
      .mockResolvedValue({ integrationStatus: "active", routeStatus: "active" });
    const store = { loadDeliveryStatus } as unknown as IntegrationStore;

    const outcome = await channelDeliveryAuthorization(store).authorize(input());

    expect(loadDeliveryStatus).toHaveBeenCalledWith("business-1", "integration-1", "route-1");
    expect(outcome).toBe("allowed");
  });

  it("revokes when the integration is revoked", async () => {
    const store = {
      loadDeliveryStatus: vi
        .fn()
        .mockResolvedValue({ integrationStatus: "revoked", routeStatus: "active" }),
    } as unknown as IntegrationStore;

    expect(await channelDeliveryAuthorization(store).authorize(input())).toBe("revoked");
  });

  it("revokes when the route is revoked", async () => {
    const store = {
      loadDeliveryStatus: vi
        .fn()
        .mockResolvedValue({ integrationStatus: "active", routeStatus: "revoked" }),
    } as unknown as IntegrationStore;

    expect(await channelDeliveryAuthorization(store).authorize(input())).toBe("revoked");
  });

  it("fails closed when the integration/route pair no longer exists", async () => {
    const store = {
      loadDeliveryStatus: vi.fn().mockResolvedValue(undefined),
    } as unknown as IntegrationStore;

    expect(await channelDeliveryAuthorization(store).authorize(input())).toBe("revoked");
  });
});
