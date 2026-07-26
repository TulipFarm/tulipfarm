import type { AccessGrantDefinition } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import {
  ChannelRouteDeniedError,
  type ChannelRoutingSnapshot,
  resolveChannelRoute,
} from "./routing";

const BUSINESS_ID = "business-1";
const APP_ID = "00000000-0000-4000-8000-000000000001";
const INTEGRATION_ID = "00000000-0000-4000-8000-000000000002";
const AGENT_A = "00000000-0000-4000-8000-000000000003";
const AGENT_B = "00000000-0000-4000-8000-000000000004";
const PRINCIPAL_ID = "00000000-0000-4000-8000-000000000005";

function grant(actions = ["channels.message.receive"]): AccessGrantDefinition {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "AccessGrant",
    metadata: {
      id: "00000000-0000-4000-8000-000000000006",
      slug: "slack-channel-access",
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "active",
    },
    spec: {
      integrationId: INTEGRATION_ID,
      principals: [{ kind: "user", id: PRINCIPAL_ID }],
      actions,
      externalTargets: [{ type: "slack.channel", ids: ["C-OPS"] }],
      delegable: false,
    },
  };
}

function snapshot(): ChannelRoutingSnapshot {
  return {
    apps: [
      {
        id: APP_ID,
        businessId: BUSINESS_ID,
        provider: "slack",
        externalAppId: "A-PRIMARY",
        credentialRefs: ["secret://slack/app", "secret://slack/bot"],
        status: "active",
      },
    ],
    integrations: [
      {
        id: INTEGRATION_ID,
        businessId: BUSINESS_ID,
        appId: APP_ID,
        externalTenantId: "T-ACME",
        credentialRef: "secret://slack/bot",
        status: "active",
      },
    ],
    accessGrants: [grant()],
    routes: [
      {
        id: "route-default",
        businessId: BUSINESS_ID,
        integrationId: INTEGRATION_ID,
        agentId: AGENT_A,
        channelId: "C-OPS",
        eventTypes: ["message"],
        priority: 10,
        status: "active",
      },
      {
        id: "route-thread",
        businessId: BUSINESS_ID,
        integrationId: INTEGRATION_ID,
        agentId: AGENT_B,
        channelId: "C-OPS",
        threadId: "1700000000.000100",
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
  externalTenantId: "T-ACME",
  externalAppId: "A-PRIMARY",
  channelId: "C-OPS",
  eventType: "message",
  principal: { kind: "user", id: PRINCIPAL_ID },
  action: "channels.message.receive",
  targetType: "slack.channel",
} as const;

describe("resolveChannelRoute", () => {
  it("selects the highest-priority matching thread route with an exact Agent and Credential", () => {
    const resolved = resolveChannelRoute(snapshot(), {
      ...request,
      threadId: "1700000000.000100",
    });

    expect(resolved).toEqual({
      appId: APP_ID,
      integrationId: INTEGRATION_ID,
      routeId: "route-thread",
      agentId: AGENT_B,
      principal: request.principal,
      credentialRef: "secret://slack/bot",
      accessGrantId: "00000000-0000-4000-8000-000000000006",
    });
  });

  it("supports several Agents behind one App without treating the App as an Agent", () => {
    const defaultRoute = resolveChannelRoute(snapshot(), request);
    const threadRoute = resolveChannelRoute(snapshot(), {
      ...request,
      threadId: "1700000000.000100",
    });

    expect(defaultRoute.agentId).toBe(AGENT_A);
    expect(threadRoute.agentId).toBe(AGENT_B);
    expect(defaultRoute.appId).toBe(threadRoute.appId);
  });

  it("denies tied top-priority routes instead of choosing by insertion order", () => {
    const state = snapshot();
    state.routes.push({
      ...state.routes[0],
      id: "route-ambiguous",
    });

    expect(() => resolveChannelRoute(state, request)).toThrowError(
      new ChannelRouteDeniedError("ambiguous_route")
    );
  });

  it("denies an unmapped App, revoked Integration, and missing AccessGrant", () => {
    expect(() =>
      resolveChannelRoute(snapshot(), { ...request, externalAppId: "A-UNKNOWN" })
    ).toThrowError(new ChannelRouteDeniedError("app_not_found"));

    const revoked = snapshot();
    revoked.integrations[0] = { ...revoked.integrations[0], status: "revoked" };
    expect(() => resolveChannelRoute(revoked, request)).toThrowError(
      new ChannelRouteDeniedError("integration_not_found")
    );

    const ungranted = snapshot();
    ungranted.accessGrants = [];
    expect(() => resolveChannelRoute(ungranted, request)).toThrowError(
      new ChannelRouteDeniedError("access_denied")
    );
  });

  it("denies an implicit Credential when an App has several Credential references", () => {
    const state = snapshot();
    state.integrations[0] = { ...state.integrations[0], credentialRef: undefined };

    expect(() => resolveChannelRoute(state, request)).toThrowError(
      new ChannelRouteDeniedError("credential_ambiguous")
    );
  });
});
