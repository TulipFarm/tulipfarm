import { describe, expect, it } from "vitest";
import { normalizeSlackEvent, SLACK_V1_EVENT_CATALOG, type SlackEventsApiEnvelope } from "./events";
import fixtures from "./fixtures/events.v1.json";

const context = {
  integrationId: "integration-1",
  actorPrincipalId: "principal-1",
} as const;

function envelope(event: unknown): SlackEventsApiEnvelope {
  return {
    type: "event_callback",
    team_id: "T123",
    api_app_id: "A123",
    event_id: "Ev123",
    event_time: 1_785_000_000,
    event,
    authorizations: [{ user_id: "UAPP", is_bot: true }],
  };
}

describe("normalizeSlackEvent", () => {
  it("covers the exact V1 event catalog with fixture-driven normalized names", () => {
    expect(fixtures.map(({ catalogEvent }) => catalogEvent)).toEqual(SLACK_V1_EVENT_CATALOG);

    for (const fixture of fixtures) {
      const result = normalizeSlackEvent(envelope(fixture.event), context);
      expect(result, fixture.catalogEvent).toMatchObject({
        outcome: "normalized",
        event: {
          name: fixture.expectedName,
          version: 1,
          integrationId: "integration-1",
          externalTenantId: "T123",
          providerEventId: "Ev123",
          occurredAt: "2026-07-25T17:20:00.000Z",
          deduplicationKey: "Ev123",
          classification: ["untrusted.external"],
        },
      });
    }
  });

  it("returns an explicit unsupported result for an unknown event type", () => {
    expect(normalizeSlackEvent(envelope({ type: "pin_added", user: "U123" }), context)).toEqual({
      outcome: "unsupported",
      eventType: "pin_added",
    });
  });

  it("uses the enterprise ID when an organization-wide installation has no team ID", () => {
    const input = envelope(fixtures[9]?.event);
    input.team_id = null;
    input.enterprise_id = "E123";

    const result = normalizeSlackEvent(input, context);

    expect(result).toMatchObject({
      outcome: "normalized",
      event: { externalTenantId: "E123" },
    });
  });

  it("returns an explicit validation failure for a malformed supported event", () => {
    const result = normalizeSlackEvent(
      envelope({ type: "reaction_added", user: "U123", item: { type: "message" } }),
      context
    );

    expect(result).toMatchObject({
      outcome: "validation_failed",
      eventType: "reaction_added",
    });
    if (result.outcome !== "validation_failed") expect.unreachable();
    expect(result.issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.issues)).not.toContain("U123");
  });

  it("rejects malformed fixtures for every supported catalog event", () => {
    for (const fixture of fixtures) {
      const rawType = fixture.catalogEvent.startsWith("message.")
        ? "message"
        : fixture.catalogEvent;
      const result = normalizeSlackEvent(envelope({ type: rawType }), context);
      expect(result, fixture.catalogEvent).toMatchObject({
        outcome: "validation_failed",
        eventType: rawType,
      });
    }
  });

  it("does not invent an actor principal when resolution did not produce one", () => {
    const result = normalizeSlackEvent(envelope(fixtures[14]?.event), {
      integrationId: "integration-1",
    });

    expect(result.outcome).toBe("normalized");
    if (result.outcome !== "normalized") expect.unreachable();
    expect(result.event).not.toHaveProperty("actorPrincipalId");
    expect(result.event).not.toHaveProperty("actorExternalId");
  });

  it("copies only allowlisted fields and marks provider content as untrusted", () => {
    const result = normalizeSlackEvent(envelope(fixtures[0]?.event), context);

    expect(result.outcome).toBe("normalized");
    if (result.outcome !== "normalized") expect.unreachable();
    expect(result.event.untrustedPayload).toEqual({
      messageId: "1785000000.000001",
      conversationId: "C123",
      conversationKind: "channel",
      actorExternalId: "U123",
      text: "channel message",
      fileIds: ["F123"],
    });
    expect(JSON.stringify(result.event)).not.toContain("url_private");
    expect(JSON.stringify(result.event)).not.toContain("do-not-copy");
    expect(result.event.classification).toEqual(["untrusted.external"]);
    expect(result.event.actorPrincipalId).toBe("principal-1");
  });

  it("keeps actor fields optional for lifecycle events that omit them", () => {
    for (const fixtureIndex of [14, 16, 18]) {
      const result = normalizeSlackEvent(envelope(fixtures[fixtureIndex]?.event), context);
      expect(result.outcome).toBe("normalized");
      if (result.outcome !== "normalized") expect.unreachable();
      expect(result.event).not.toHaveProperty("actorExternalId");
      expect(result.event).not.toHaveProperty("actorPrincipalId");
    }
  });

  it("reads assistant event actors from assistant_thread.user_id", () => {
    for (const fixtureIndex of [6, 7]) {
      const result = normalizeSlackEvent(envelope(fixtures[fixtureIndex]?.event), context);
      expect(result.outcome).toBe("normalized");
      if (result.outcome !== "normalized") expect.unreachable();
      expect(result.event.untrustedPayload).toMatchObject({ actorExternalId: "U123" });
      expect(result.event.actorPrincipalId).toBe("principal-1");
    }
  });

  it("rejects the old assistant event shape with user_id outside assistant_thread", () => {
    for (const type of ["assistant_thread_started", "assistant_thread_context_changed"] as const) {
      const result = normalizeSlackEvent(
        envelope({
          type,
          user_id: "U123",
          assistant_thread: {
            channel_id: "D123",
            thread_ts: "1785000000.000006",
            context: { channel_id: "C123", team_id: "T123" },
          },
        }),
        context
      );
      expect(result).toMatchObject({ outcome: "validation_failed", eventType: type });
    }
  });

  it("normalizes app_context_changed entities without inventing an actor", () => {
    const result = normalizeSlackEvent(envelope(fixtures[8]?.event), context);

    expect(result.outcome).toBe("normalized");
    if (result.outcome !== "normalized") expect.unreachable();
    expect(result.event.untrustedPayload).toEqual({
      context: {
        entities: [
          {
            type: "slack#/types/channel_id",
            value: "C789",
            teamId: "T123",
          },
        ],
      },
    });
    expect(result.event).not.toHaveProperty("actorPrincipalId");
  });

  it("rejects the old app_context_changed user and flat context shape", () => {
    expect(
      normalizeSlackEvent(
        envelope({
          type: "app_context_changed",
          user_id: "U123",
          context: { channel_id: "C789", team_id: "T123" },
        }),
        context
      )
    ).toMatchObject({
      outcome: "validation_failed",
      eventType: "app_context_changed",
    });
  });

  it("rejects non-curated message subtypes without changing the existing message adapter", () => {
    expect(
      normalizeSlackEvent(
        envelope({
          type: "message",
          subtype: "message_changed",
          channel_type: "channel",
          channel: "C123",
          ts: "1785000000.000001",
        }),
        context
      )
    ).toEqual({
      outcome: "unsupported",
      eventType: "message.message_changed",
    });
  });

  it("fails instead of dropping names from a batched emoji removal", () => {
    expect(
      normalizeSlackEvent(
        envelope({
          type: "emoji_changed",
          subtype: "remove",
          names: ["first", "second"],
        }),
        context
      )
    ).toMatchObject({
      outcome: "validation_failed",
      eventType: "emoji_changed",
    });
  });
});
