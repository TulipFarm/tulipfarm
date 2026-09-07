import type { IntegrationStore, PersistedRoutingSnapshot } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { slackHomeOpenedHandler } from ".";

function snapshot(status: "active" | "revoked" = "active"): PersistedRoutingSnapshot {
  return {
    apps: [
      {
        id: "app-1",
        businessId: "business-1",
        provider: "slack",
        externalAppId: "A1",
        credentialRefs: [],
        status,
      },
    ],
    integrations: [
      {
        id: "integration-1",
        businessId: "business-1",
        appId: "app-1",
        externalTenantId: "T1",
        status,
      },
    ],
    accessGrants: [],
    routes: [],
  };
}

describe("slackHomeOpenedHandler", () => {
  it("resolves the active Slack binding before publishing", async () => {
    const loadRoutingSnapshot = vi.fn().mockResolvedValue(snapshot());
    const publish = vi.fn().mockResolvedValue(undefined);
    const handler = slackHomeOpenedHandler({
      businessId: "business-1",
      integrations: { loadRoutingSnapshot } as unknown as IntegrationStore,
      publish,
    });

    await handler({
      externalTenantId: "T1",
      externalAppId: "A1",
      externalSubject: "U1",
      tab: "home",
    });

    expect(loadRoutingSnapshot).toHaveBeenCalledWith("business-1", "slack", "T1");
    expect(publish).toHaveBeenCalledWith({
      integrationId: "integration-1",
      externalTenantId: "T1",
      externalAppId: "A1",
      externalSubject: "U1",
      tab: "home",
    });
  });

  it("skips the messages tab without loading business data", async () => {
    const loadRoutingSnapshot = vi.fn();
    const publish = vi.fn();
    const handler = slackHomeOpenedHandler({
      businessId: "business-1",
      integrations: { loadRoutingSnapshot } as unknown as IntegrationStore,
      publish,
    });

    await handler({
      externalTenantId: "T1",
      externalAppId: "A1",
      externalSubject: "U1",
      tab: "messages",
    });

    expect(loadRoutingSnapshot).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("drops a revoked binding", async () => {
    const publish = vi.fn();
    const handler = slackHomeOpenedHandler({
      businessId: "business-1",
      integrations: {
        loadRoutingSnapshot: vi.fn().mockResolvedValue(snapshot("revoked")),
      } as unknown as IntegrationStore,
      publish,
    });

    await handler({
      externalTenantId: "T1",
      externalAppId: "A1",
      externalSubject: "U1",
      tab: "home",
    });

    expect(publish).not.toHaveBeenCalled();
  });
});
