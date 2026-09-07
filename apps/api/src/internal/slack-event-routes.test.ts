import type { SlackNormalizedEvent } from "@tulipfarm/integrations";
import type { PersistedRoutingSnapshot } from "@tulipfarm/storage";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelSenderResolution } from "../ingress/identity";
import { registerSlackEventRoutes, type SlackEventRouteDeps } from "./slack-event-routes";

function snapshot(
  status: "active" | "revoked" = "active",
  externalTenantId = "T1"
): PersistedRoutingSnapshot {
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
        externalTenantId,
        status,
      },
    ],
    accessGrants: [],
    routes: [],
  };
}

const event: SlackNormalizedEvent = {
  name: "slack.reaction.added.v1",
  version: 1,
  integrationId: "integration-1",
  externalTenantId: "T1",
  providerEventId: "Ev1",
  occurredAt: "2026-07-25T17:20:00.000Z",
  conversationId: "C1",
  deduplicationKey: "Ev1",
  classification: ["untrusted.external"],
  untrustedPayload: {
    actorExternalId: "U1",
    reaction: "eyes",
    itemType: "message",
    conversationId: "C1",
    messageId: "1.1",
  },
};

describe("POST /api/v1/internal/slack/events", () => {
  let app: FastifyInstance;
  let status: "active" | "revoked";
  let bindingTenantId: string;
  let resolution: ChannelSenderResolution;
  const accept = vi.fn();
  const find = vi.fn();
  const dispatchIntegrationEvent = vi.fn();
  const resolve = vi.fn();

  beforeEach(async () => {
    status = "active";
    bindingTenantId = "T1";
    resolution = {
      outcome: "linked",
      user: { _id: "user-1" },
      principalKind: "user",
      principalId: "user-1",
      principalRef: "user:user-1",
    } as ChannelSenderResolution;
    resolve.mockReset().mockImplementation(async () => resolution);
    accept.mockReset().mockImplementation(async (canonicalEvent) => ({
      outcome: "accepted",
      event: {
        id: "event-1",
        businessId: "business-1",
        sourceKey: '["slack","integration-1","T1"]',
        deduplicationKey: "Ev1",
        status: "pending",
        canonicalEvent,
      },
    }));
    find.mockReset().mockResolvedValue(null);
    dispatchIntegrationEvent.mockReset().mockResolvedValue({
      kind: "started",
      triggerSlug: "on-reaction",
      runId: "run-1",
    });
    app = Fastify();
    const deps: SlackEventRouteDeps = {
      businessId: "business-1",
      integrations: {
        loadRoutingSnapshot: async () => snapshot(status, bindingTenantId),
      },
      identity: { resolve },
      events: { accept, find },
      eventTriggers: { dispatchIntegrationEvent },
      now: () => "2026-09-07T10:00:00.000Z",
    };
    registerSlackEventRoutes(app, deps, async (req) => {
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

  function request(input: SlackNormalizedEvent = event) {
    return app.inject({
      method: "POST",
      url: "/api/v1/internal/slack/events",
      payload: { externalAppId: "A1", event: input },
    });
  }

  it("persists the normalized event and outbox work before returning", async () => {
    const response = await request();

    expect(response.statusCode).toBe(200);
    expect(accept).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "Ev1",
        type: "slack.reaction.added.v1",
        deduplicationKey: "Ev1",
        classification: ["untrusted.external"],
        principal: { kind: "user", internalId: "user-1", externalId: "U1" },
        data: expect.objectContaining({ actorPrincipalId: "user-1" }),
      })
    );
    expect(response.json()).toEqual({ outcome: "recorded", eventId: "event-1" });
    expect(dispatchIntegrationEvent).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledWith({
      slug: "slack",
      sender: "U1",
      externalTenantId: "T1",
    });
  });

  it("keeps an unlinked actor external and never substitutes another principal", async () => {
    resolution = { outcome: "unlinked", bindOffer: null };

    const response = await request();

    expect(response.statusCode).toBe(200);
    expect(accept).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ actorPrincipalId: expect.anything() }),
        principal: { kind: "service", internalId: "integration:slack" },
      })
    );
    expect(dispatchIntegrationEvent).not.toHaveBeenCalled();
  });

  it("rejects a revoked binding before identity resolution or persistence", async () => {
    status = "revoked";

    const response = await request();

    expect(response.statusCode).toBe(404);
    expect(accept).not.toHaveBeenCalled();
    expect(dispatchIntegrationEvent).not.toHaveBeenCalled();
  });

  it("persists host signals without exposing them to user-authored Triggers", async () => {
    const homeEvent = {
      ...event,
      name: "slack.home.opened.v1",
      conversationId: "D1",
      untrustedPayload: { actorExternalId: "U1", tab: "home", conversationId: "D1" },
    } as SlackNormalizedEvent;

    const response = await request(homeEvent);

    expect(response.statusCode).toBe(200);
    expect(accept).toHaveBeenCalledOnce();
    expect(dispatchIntegrationEvent).not.toHaveBeenCalled();
  });

  it("durably records malformed supported events without resolving identity or dispatching", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/internal/slack/events",
      payload: {
        externalAppId: "A1",
        failure: {
          integrationId: "integration-1",
          externalTenantId: "T1",
          providerEventId: "Ev-bad",
          sourceEventType: "reaction_added",
          occurredAt: "2026-07-25T17:20:00.000Z",
          issues: [{ path: "/reaction", keyword: "required", message: "must be present" }],
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ outcome: "failed", eventId: "event-1" });
    expect(accept).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "Ev-bad",
        type: "slack.inbound.validation_failed.v1",
        deduplicationKey: "Ev-bad",
        verification: { status: "failed", method: "slack_socket_mode" },
        data: {
          outcome: "validation_failed",
          integrationId: "integration-1",
          externalTenantId: "T1",
          providerEventId: "Ev-bad",
          sourceEventType: "reaction_added",
          occurredAt: "2026-07-25T17:20:00.000Z",
          issues: [{ path: "/reaction", keyword: "required", message: "must be present" }],
        },
      })
    );
    expect(dispatchIntegrationEvent).not.toHaveBeenCalled();
  });

  it("dispatches a persisted Slack event through the recoverable outbox callback", async () => {
    await request();
    const canonicalEvent = accept.mock.calls[0]?.[0];
    find.mockResolvedValue({
      id: "event-1",
      businessId: "business-1",
      sourceKey: '["slack","integration-1","T1"]',
      deduplicationKey: "Ev1",
      status: "pending",
      canonicalEvent,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/internal/slack/events/event-1/dispatch",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ outcome: "dispatched" });
    expect(dispatchIntegrationEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "slack.reaction.added.v1",
        eventId: "event-1",
        actor: { kind: "user", id: "user-1", externalId: "U1" },
        classification: ["untrusted.external"],
      })
    );
  });

  it("does not dispatch an event after its Integration binding is revoked", async () => {
    await request();
    const canonicalEvent = accept.mock.calls[0]?.[0];
    find.mockResolvedValue({
      id: "event-1",
      businessId: "business-1",
      sourceKey: '["slack","integration-1","T1"]',
      deduplicationKey: "Ev1",
      status: "pending",
      canonicalEvent,
    });
    status = "revoked";

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/internal/slack/events/event-1/dispatch",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ outcome: "ignored" });
    expect(dispatchIntegrationEvent).not.toHaveBeenCalled();
  });

  it("does not dispatch when the Integration binding no longer matches the event tenant", async () => {
    await request();
    const canonicalEvent = accept.mock.calls[0]?.[0];
    find.mockResolvedValue({
      id: "event-1",
      businessId: "business-1",
      sourceKey: '["slack","integration-1","T1"]',
      deduplicationKey: "Ev1",
      status: "pending",
      canonicalEvent,
    });
    bindingTenantId = "T2";

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/internal/slack/events/event-1/dispatch",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ outcome: "ignored" });
    expect(dispatchIntegrationEvent).not.toHaveBeenCalled();
  });
});
