import type { AccessGrantDefinition } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import {
  ChannelRouteDeniedError,
  type ChannelRoutingSnapshot,
  resolveChannelRoute,
} from "../model";

const BUSINESS_ID = "business-1";
const APP_ID = "00000000-0000-4000-8000-000000000001";
const INTEGRATION_ID = "00000000-0000-4000-8000-000000000002";
const PRINCIPAL_ID = "00000000-0000-4000-8000-000000000003";

const accessGrant: AccessGrantDefinition = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "AccessGrant",
  metadata: {
    id: "00000000-0000-4000-8000-000000000004",
    slug: "channel-security-matrix",
    schemaVersion: 1,
    authoredVersion: 1,
    lifecycle: "active",
  },
  spec: {
    integrationId: INTEGRATION_ID,
    principals: [{ kind: "user", id: PRINCIPAL_ID }],
    actions: ["channels.message.receive"],
    externalTargets: [{ type: "slack.channel", ids: ["C-1"] }],
    delegable: false,
  },
};

function snapshot(): ChannelRoutingSnapshot {
  return {
    apps: [
      {
        id: APP_ID,
        businessId: BUSINESS_ID,
        provider: "slack",
        externalAppId: "A-1",
        credentialRefs: ["secret://slack/bot"],
        status: "active",
      },
    ],
    integrations: [
      {
        id: INTEGRATION_ID,
        businessId: BUSINESS_ID,
        appId: APP_ID,
        externalTenantId: "T-1",
        credentialRef: "secret://slack/bot",
        status: "active",
      },
    ],
    accessGrants: [accessGrant],
    routes: [
      {
        id: "route-channel",
        businessId: BUSINESS_ID,
        integrationId: INTEGRATION_ID,
        agentId: "agent-channel",
        channelId: "C-1",
        eventTypes: ["message"],
        priority: 10,
        status: "active",
      },
      {
        id: "route-thread",
        businessId: BUSINESS_ID,
        integrationId: INTEGRATION_ID,
        agentId: "agent-thread",
        channelId: "C-1",
        threadId: "thread-1",
        eventTypes: ["message"],
        priority: 20,
        status: "active",
      },
    ],
  };
}

const request = {
  businessId: BUSINESS_ID,
  provider: "slack",
  externalTenantId: "T-1",
  externalAppId: "A-1",
  channelId: "C-1",
  eventType: "message",
  principal: { kind: "user", id: PRINCIPAL_ID },
  action: "channels.message.receive",
  targetType: "slack.channel",
} as const;

describe("channel routing security matrix", () => {
  it("keeps workspace, App, channel, and thread dimensions exact", () => {
    expect(resolveChannelRoute(snapshot(), request).agentId).toBe("agent-channel");
    expect(resolveChannelRoute(snapshot(), { ...request, threadId: "thread-1" }).agentId).toBe(
      "agent-thread"
    );

    expect(() =>
      resolveChannelRoute(snapshot(), { ...request, externalTenantId: "T-2" })
    ).toThrowError(new ChannelRouteDeniedError("integration_not_found"));
    expect(() =>
      resolveChannelRoute(snapshot(), { ...request, externalAppId: "A-2" })
    ).toThrowError(new ChannelRouteDeniedError("app_not_found"));
    expect(() => resolveChannelRoute(snapshot(), { ...request, channelId: "C-2" })).toThrowError(
      new ChannelRouteDeniedError("route_not_found")
    );
  });

  it("denies thread ambiguity instead of silently selecting an Agent", () => {
    const state = snapshot();
    state.routes.push({
      ...state.routes[1],
      id: "route-thread-tied",
      agentId: "agent-other",
    });

    expect(() => resolveChannelRoute(state, { ...request, threadId: "thread-1" })).toThrowError(
      new ChannelRouteDeniedError("ambiguous_route")
    );
  });

  it("never leaks protected routing identifiers in a denial message", () => {
    try {
      resolveChannelRoute(snapshot(), { ...request, externalTenantId: "T-SECRET" });
      throw new Error("expected denial");
    } catch (error) {
      expect(String(error)).toBe(
        "ChannelRouteDeniedError: channel_route_denied:integration_not_found"
      );
      expect(String(error)).not.toContain("T-SECRET");
    }
  });
});
