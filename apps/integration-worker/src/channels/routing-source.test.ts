import type { IntegrationStore, PersistedRoutingSnapshot } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { channelRoutingSource } from "./routing-source";

function snapshot(): PersistedRoutingSnapshot {
  return {
    apps: [
      {
        id: "app-1",
        businessId: "business-1",
        provider: "slack",
        externalAppId: "A1",
        credentialRefs: ["secret://slack/bot"],
        status: "active",
      },
    ],
    integrations: [
      {
        id: "integration-1",
        businessId: "business-1",
        appId: "app-1",
        externalTenantId: "T1",
        status: "active",
      },
    ],
    accessGrants: [
      {
        id: "grant-1",
        businessId: "business-1",
        integrationId: "integration-1",
        definition: { kind: "AccessGrant" },
        status: "active",
      },
    ],
    routes: [
      {
        id: "route-1",
        businessId: "business-1",
        integrationId: "integration-1",
        agentId: "agent-1",
        channelId: null,
        threadId: null,
        eventTypes: ["message"],
        priority: 0,
        status: "active",
      },
    ],
  };
}

describe("channelRoutingSource", () => {
  it("reshapes a persisted snapshot into the port shape, dropping null channel/thread scoping", async () => {
    const loadRoutingSnapshot = vi.fn().mockResolvedValue(snapshot());
    const store = { loadRoutingSnapshot } as unknown as IntegrationStore;

    const result = await channelRoutingSource(store).load({
      businessId: "business-1",
      provider: "slack",
      externalTenantId: "T1",
    });

    expect(loadRoutingSnapshot).toHaveBeenCalledWith("business-1", "slack", "T1");
    expect(result.routes[0]).not.toHaveProperty("channelId");
    expect(result.routes[0]).not.toHaveProperty("threadId");
    expect(result.accessGrants[0]).toEqual({ kind: "AccessGrant" });
    expect(result.integrations[0]).not.toHaveProperty("externalAccountId");
  });

  it("keeps a concrete channel/thread scope when present", async () => {
    const scoped = snapshot();
    scoped.routes[0].channelId = "C1";
    scoped.routes[0].threadId = "1720000000.000100";
    const store = {
      loadRoutingSnapshot: vi.fn().mockResolvedValue(scoped),
    } as unknown as IntegrationStore;

    const result = await channelRoutingSource(store).load({
      businessId: "business-1",
      provider: "slack",
      externalTenantId: "T1",
    });

    expect(result.routes[0].channelId).toBe("C1");
    expect(result.routes[0].threadId).toBe("1720000000.000100");
  });
});
