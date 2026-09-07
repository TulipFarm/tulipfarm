import type { PersistedRoutingSnapshot } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import type { InternalApiClient } from "../internal/client";
import { SlackEventPublisher } from "./event-publisher";

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

function envelope(event: unknown) {
  return {
    type: "event_callback",
    team_id: "T1",
    api_app_id: "A1",
    event_id: "Ev1",
    event_time: 1_785_000_000,
    event,
  };
}

function harness(status: "active" | "revoked" = "active") {
  const require = vi.fn().mockResolvedValue({ outcome: "recorded", eventId: "event-1" });
  const warn = vi.fn();
  const publisher = new SlackEventPublisher({
    businessId: "business-1",
    integrations: { loadRoutingSnapshot: vi.fn().mockResolvedValue(snapshot(status)) },
    internalApi: { require } as unknown as InternalApiClient,
    log: { warn },
  });
  return { publisher, require, warn };
}

describe("SlackEventPublisher", () => {
  it("normalizes and posts a curated event through the internal API", async () => {
    const { publisher, require } = harness();

    await publisher.publish(
      envelope({
        type: "reaction_added",
        user: "U1",
        reaction: "eyes",
        item: { type: "message", channel: "C1", ts: "1.1" },
      })
    );

    expect(require).toHaveBeenCalledWith("POST", "/api/v1/internal/slack/events", {
      externalAppId: "A1",
      event: expect.objectContaining({
        name: "slack.reaction.added.v1",
        integrationId: "integration-1",
        externalTenantId: "T1",
        providerEventId: "Ev1",
      }),
    });
  });

  it("acknowledges and ignores unknown event types without calling the API", async () => {
    const { publisher, require, warn } = harness();

    await publisher.publish(envelope({ type: "pin_added", user: "U1" }));

    expect(require).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs malformed supported events and does not dispatch them", async () => {
    const { publisher, require, warn } = harness();

    await publisher.publish(envelope({ type: "reaction_added", user: "U1" }));

    expect(require).toHaveBeenCalledWith("POST", "/api/v1/internal/slack/events", {
      externalAppId: "A1",
      failure: {
        integrationId: "integration-1",
        externalTenantId: "T1",
        providerEventId: "Ev1",
        sourceEventType: "reaction_added",
        occurredAt: "2026-07-25T17:20:00.000Z",
        issues: expect.any(Array),
      },
    });
    expect(warn).toHaveBeenCalledWith(
      "slack curated event validation failed",
      expect.objectContaining({ eventType: "reaction_added" })
    );
  });

  it("does not dispatch through a revoked or mismatched Slack binding", async () => {
    const { publisher, require, warn } = harness("revoked");

    await publisher.publish(
      envelope({
        type: "reaction_added",
        user: "U1",
        reaction: "eyes",
        item: { type: "message", channel: "C1", ts: "1.1" },
      })
    );

    expect(require).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("slack curated event binding is not active");
  });

  it("refuses acknowledgement when a validation failure cannot be persisted", async () => {
    const { publisher, require, warn } = harness();

    await expect(
      publisher.publish({
        type: "event_callback",
        event: { type: "reaction_added", user: "U1" },
      })
    ).rejects.toThrow("slack_curated_event_validation_failure_not_persisted");

    expect(require).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
