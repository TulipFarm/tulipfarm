import type { PersistedRoutingSnapshot } from "@tulipfarm/storage";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelSenderResolution } from "../ingress/identity";
import { registerSlackHomeRoutes, type SlackHomeRouteDeps } from "./slack-home-routes";

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

function linked(principalKind: "user" | "guest" = "user"): ChannelSenderResolution {
  const principalId = principalKind === "user" ? "user-1" : "slack:U1";
  return {
    outcome: "linked",
    user: {
      _id: "user-1",
      email: "muskan@example.com",
      passwordHash: "hash",
      name: "Muskan Vijayvargiya",
      role: "admin",
      status: "active",
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
    },
    principalKind,
    principalId,
    principalRef: `${principalKind}:${principalId}`,
  } as ChannelSenderResolution;
}

describe("POST /api/v1/internal/channels/slack/home", () => {
  let app: FastifyInstance;
  let resolution: ChannelSenderResolution;
  let status: "active" | "revoked";
  const projection = vi.fn();
  const resolve = vi.fn();

  beforeEach(async () => {
    resolution = linked();
    status = "active";
    resolve.mockReset().mockImplementation(async () => resolution);
    projection.mockReset().mockResolvedValue({
      askUrl: "http://localhost:4000/chats",
      needsYou: ["Approval: send_email"],
      runningNow: ["<http://localhost:4000/runs/run-1|Quarterly review>"],
      agents: ["<http://localhost:4000/agents/operator|Operations Agent>"],
      recentWork: ["<http://localhost:4000/chat/chat-1|Incident review>"],
    });
    app = Fastify();
    const deps: SlackHomeRouteDeps = {
      businessId: "business-1",
      integrations: {
        loadRoutingSnapshot: async () => snapshot(status),
      },
      identity: { resolve },
      projection: { load: projection },
      bindLinkUrl: (token) => `http://localhost:4000/link-channel?token=${token}`,
      unlinkedUrl: "http://localhost:4000",
    };
    registerSlackHomeRoutes(app, deps, async (req) => {
      req.principal = {
        kind: "service",
        id: "integration-worker",
        businessId: "business-1",
        credential: "client_secret",
        authMethods: [],
        authenticatedAt: new Date(),
      };
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const request = () =>
    app.inject({
      method: "POST",
      url: "/api/v1/internal/channels/slack/home",
      payload: {
        integrationId: "integration-1",
        externalTenantId: "T1",
        externalAppId: "A1",
        externalSubject: "U1",
      },
    });

  it("renders a linked user's truthful V1 Home through the Slack Home renderer", async () => {
    const response = await request();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      integrationId: "integration-1",
      linked: true,
      view: {
        type: "home",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: expect.stringContaining("*Needs you*\n• Approval: send_email"),
            },
          },
        ],
      },
    });
    const homeText = response.json().view.blocks[0].text.text;
    expect(homeText).toContain("*Running now*\n• <http://localhost:4000/runs/run-1");
    expect(homeText).toContain("*Your Agents*\n• <http://localhost:4000/agents/operator");
    expect(homeText).toContain("*Recent work*\n• <http://localhost:4000/chat/chat-1");
    expect(projection).toHaveBeenCalledWith({
      businessId: "business-1",
      principalId: "user-1",
      principalRef: "user:user-1",
      roles: ["admin"],
    });
    expect(resolve).toHaveBeenCalledWith({
      slug: "slack",
      sender: "U1",
      externalTenantId: "T1",
    });
  });

  it("returns only an account-link view for an unlinked user", async () => {
    resolution = {
      outcome: "unlinked",
      bindOffer: { token: "bind-token", expiresAt: new Date("2026-09-07T10:00:00Z") },
    };

    const response = await request();
    const body = response.json();

    expect(body.linked).toBe(false);
    expect(body.view.blocks[0].text.text).toContain(
      "<http://localhost:4000/link-channel?token=bind-token|Link account>"
    );
    expect(body.view.blocks[0].text.text).not.toContain("Needs you");
    expect(projection).not.toHaveBeenCalled();
  });

  it("does not expose business data to a guest-grade identity", async () => {
    resolution = linked("guest");

    const response = await request();

    expect(response.json().linked).toBe(false);
    expect(projection).not.toHaveBeenCalled();
  });

  it("rejects a revoked Slack binding before identity resolution", async () => {
    status = "revoked";

    const response = await request();

    expect(response.statusCode).toBe(404);
    expect(projection).not.toHaveBeenCalled();
  });
});
