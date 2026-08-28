import type { RegisteredTrigger, RunInvocation } from "@tulipfarm/run-kernel";
import type { IntegrationEventPayload, ResourceSideEffect } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { EventTriggerGateway } from "./event-dispatch";

const baseTrigger = {
  authoredVersion: 2,
  lifecycle: "published",
  routineRef: { name: "triage", version: "1.0.0" },
  backgroundIdentity: { principalKind: "service", principalId: "routine-runner" },
} satisfies Partial<RegisteredTrigger>;

function ticketCreated(overrides: Partial<RegisteredTrigger> = {}): RegisteredTrigger {
  return {
    ...baseTrigger,
    triggerSlug: "on-ticket-created",
    type: "internal_event",
    eventType: "resource.created",
    eventVersion: 1,
    ...overrides,
  };
}

const effect: ResourceSideEffect = {
  kind: "create",
  resourceType: "ticket",
  resourceId: "ticket-1",
  record: { title: "Printer on fire", priority: "high" },
};

function gatewayWith(triggers: readonly RegisteredTrigger[]) {
  const startRun = vi.fn(async (_invocation: RunInvocation) => ({
    runId: "run-1",
    outcome: "started" as const,
  }));
  const gateway = new EventTriggerGateway({
    listTriggers: async () => triggers,
    startRun,
    nextEventId: () => "event-1",
    now: () => "2026-01-01T00:00:00.000Z",
  });
  return { gateway, startRun };
}

describe("EventTriggerGateway", () => {
  describe("Routine emissions", () => {
    const emission = {
      eventId: "emit:run-emitter:Announce",
      eventType: "ticket.triaged",
      eventVersion: 1,
      data: { ticketId: "ticket-1" },
      emitterRunId: "run-emitter",
      principal: { kind: "user", id: "operator-1" },
    };

    it("starts the Run an emitted event matches", async () => {
      const { gateway, startRun } = gatewayWith([
        ticketCreated({ triggerSlug: "on-ticket-triaged", eventType: "ticket.triaged" }),
      ]);

      const result = await gateway.dispatchInternalEvent(emission);

      expect(result).toMatchObject({ kind: "started", triggerSlug: "on-ticket-triaged" });
      const invocation = startRun.mock.calls[0]?.[0];
      // The emitter names the event; the Trigger still names the identity the Run assumes.
      expect(invocation?.backgroundIdentity).toEqual({
        principalKind: "service",
        principalId: "routine-runner",
      });
    });

    it("names the emitting Run as the cause, so lineage is readable from the event", async () => {
      const { gateway, startRun } = gatewayWith([ticketCreated({ eventType: "ticket.triaged" })]);

      await gateway.dispatchInternalEvent(emission);

      expect(startRun.mock.calls[0]?.[0].causationId).toBe("emit:run-emitter:Announce");
    });

    it("keys idempotency on the event id, so a re-announced emission adopts the same Run", async () => {
      const { gateway, startRun } = gatewayWith([ticketCreated({ eventType: "ticket.triaged" })]);

      await gateway.dispatchInternalEvent(emission);
      await gateway.dispatchInternalEvent(emission);

      const [first, second] = startRun.mock.calls.map((call) => call[0].idempotencyKey);
      expect(first).toBe(second);
    });

    it("does not bind an emission no Trigger listens for", async () => {
      const { gateway, startRun } = gatewayWith([ticketCreated()]);

      await expect(gateway.dispatchInternalEvent(emission)).resolves.toEqual({ kind: "no_match" });
      expect(startRun).not.toHaveBeenCalled();
    });

    it("carries the emitted payload through as the Trigger's payload", async () => {
      const { gateway, startRun } = gatewayWith([
        ticketCreated({
          eventType: "ticket.triaged",
          match: [{ path: "ticketId", equals: "ticket-1" }],
        }),
      ]);

      await expect(gateway.dispatchInternalEvent(emission)).resolves.toMatchObject({
        kind: "started",
      });
      expect(startRun).toHaveBeenCalled();
    });
  });

  describe("Record mutations", () => {
    it("starts the Run a Record creation matches", async () => {
      const { gateway, startRun } = gatewayWith([ticketCreated()]);

      const result = await gateway.dispatchResourceMutation(effect, "outbox-1");

      expect(result).toMatchObject({ kind: "started", triggerSlug: "on-ticket-created" });
      const invocation = startRun.mock.calls[0]?.[0];
      expect(invocation?.routineRef).toEqual({ name: "triage", version: "1.0.0" });
      // The Trigger's declared identity, never the user who wrote the Record.
      expect(invocation?.backgroundIdentity).toEqual({
        principalKind: "service",
        principalId: "routine-runner",
      });
    });

    it.each([
      ["update", "resource.updated"],
      ["delete", "resource.deleted"],
    ] as const)("binds a Record %s to its own event type", async (kind, eventType) => {
      const { gateway } = gatewayWith([ticketCreated({ eventType })]);

      const result = await gateway.dispatchResourceMutation({ ...effect, kind }, "outbox-1");

      expect(result).toMatchObject({ kind: "started" });
    });

    it("keys idempotency on the outbox row, so a redelivery adopts the same Run", async () => {
      const { gateway, startRun } = gatewayWith([ticketCreated()]);

      await gateway.dispatchResourceMutation(effect, "outbox-1");
      await gateway.dispatchResourceMutation(effect, "outbox-1");

      const [first, second] = startRun.mock.calls.map((call) => call[0].idempotencyKey);
      expect(first).toBe("on-ticket-created:2:outbox-1");
      expect(second).toBe(first);
    });

    it("gives two genuinely repeated updates two Runs", async () => {
      const { gateway, startRun } = gatewayWith([ticketCreated({ eventType: "resource.updated" })]);
      const update = { ...effect, kind: "update" as const };

      await gateway.dispatchResourceMutation(update, "outbox-1");
      await gateway.dispatchResourceMutation(update, "outbox-2");

      const keys = startRun.mock.calls.map((call) => call[0].idempotencyKey);
      expect(new Set(keys).size).toBe(2);
    });

    it("narrows to one Resource type through the authored filter", async () => {
      const { gateway, startRun } = gatewayWith([
        ticketCreated({ filter: 'trigger.payload.resourceType == "invoice"' }),
      ]);

      const result = await gateway.dispatchResourceMutation(effect, "outbox-1");

      expect(result).toEqual({ kind: "no_match" });
      expect(startRun).not.toHaveBeenCalled();
    });

    it("starts the Run when the authored filter selects this Resource type", async () => {
      const { gateway } = gatewayWith([
        ticketCreated({ filter: 'trigger.payload.resourceType == "ticket"' }),
      ]);

      expect(await gateway.dispatchResourceMutation(effect, "outbox-1")).toMatchObject({
        kind: "started",
      });
    });

    it("prefers the filtered Trigger over the unfiltered one rather than calling it ambiguous", async () => {
      const { gateway } = gatewayWith([
        ticketCreated({ triggerSlug: "any-record" }),
        ticketCreated({
          triggerSlug: "tickets-only",
          filter: 'trigger.payload.resourceType == "ticket"',
        }),
      ]);

      expect(await gateway.dispatchResourceMutation(effect, "outbox-1")).toMatchObject({
        kind: "started",
        triggerSlug: "tickets-only",
      });
    });

    it("starts nothing when two equally specific Triggers both match", async () => {
      const { gateway, startRun } = gatewayWith([
        ticketCreated({ triggerSlug: "first" }),
        ticketCreated({ triggerSlug: "second" }),
      ]);

      const result = await gateway.dispatchResourceMutation(effect, "outbox-1");

      expect(result).toEqual({ kind: "ambiguous", candidates: ["first", "second"] });
      expect(startRun).not.toHaveBeenCalled();
    });

    it("starts nothing when no Trigger listens", async () => {
      const { gateway, startRun } = gatewayWith([]);

      expect(await gateway.dispatchResourceMutation(effect, "outbox-1")).toEqual({
        kind: "no_match",
      });
      expect(startRun).not.toHaveBeenCalled();
    });

    it("maps Record fields into the Routine's input", async () => {
      const { gateway, startRun } = gatewayWith([
        ticketCreated({ inputMappings: { priority: "record.priority" } }),
      ]);

      await gateway.dispatchResourceMutation(effect, "outbox-1");

      expect(startRun.mock.calls[0]?.[0].input).toEqual({ priority: "high" });
    });

    it("reports an unresolvable mapping instead of starting a Run", async () => {
      const { gateway, startRun } = gatewayWith([
        ticketCreated({ inputMappings: { owner: "record.assignee" } }),
      ]);

      expect(await gateway.dispatchResourceMutation(effect, "outbox-1")).toEqual({
        kind: "rejected",
        triggerSlug: "on-ticket-created",
        code: "mapping_unresolved",
      });
      expect(startRun).not.toHaveBeenCalled();
    });

    it("satisfies a Trigger that refuses unattested events", async () => {
      const { gateway } = gatewayWith([ticketCreated({ requireVerified: true })]);

      // An internally raised event is inside the trust boundary; `requireVerified` exists to
      // refuse unattested third-party input, which this is not.
      expect(await gateway.dispatchResourceMutation(effect, "outbox-1")).toMatchObject({
        kind: "started",
      });
    });
  });

  describe("Integration events", () => {
    const event: IntegrationEventPayload = {
      integration: "slack",
      protocol: "webhook",
      event: "member_joined_channel",
      eventId: "integration-event-1",
      payload: { channel: "C123" },
    };

    function slackTrigger(overrides: Partial<RegisteredTrigger> = {}): RegisteredTrigger {
      return {
        ...baseTrigger,
        triggerSlug: "greet-new-member",
        type: "integration_event",
        eventType: "member_joined_channel",
        eventVersion: 1,
        provider: "slack",
        ...overrides,
      };
    }

    it("starts the Run a classified Integration event matches", async () => {
      const { gateway, startRun } = gatewayWith([slackTrigger()]);

      const result = await gateway.dispatchIntegrationEvent(event);

      expect(result).toMatchObject({ kind: "started", triggerSlug: "greet-new-member" });
      expect(startRun.mock.calls[0]?.[0].idempotencyKey).toBe(
        "greet-new-member:2:integration-event-1"
      );
    });

    it("does not let one provider's event start another provider's Routine", async () => {
      const { gateway, startRun } = gatewayWith([slackTrigger({ provider: "github" })]);

      expect(await gateway.dispatchIntegrationEvent(event)).toEqual({ kind: "no_match" });
      expect(startRun).not.toHaveBeenCalled();
    });

    it("narrows on the payload through the authored filter", async () => {
      const { gateway } = gatewayWith([
        slackTrigger({ filter: 'trigger.payload.payload.channel == "C123"' }),
      ]);

      expect(await gateway.dispatchIntegrationEvent(event)).toMatchObject({ kind: "started" });
    });
  });
});
