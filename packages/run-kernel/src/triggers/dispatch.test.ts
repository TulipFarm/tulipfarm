import type { event as eventSchema } from "@tulipfarm/schema";
import { describe, expect, it, vi } from "vitest";
import { dispatchEventTrigger } from "./dispatch";
import type { RegisteredTrigger } from "./matcher";

const trigger: RegisteredTrigger = {
  triggerSlug: "on-push",
  authoredVersion: 1,
  lifecycle: "published",
  type: "integration_event",
  eventType: "push",
  eventVersion: 1,
  provider: "gitlab",
  protocol: "oim",
  integrationMajorVersion: 2,
  connectionId: "connection-1",
  routineRef: { name: "push-triage", version: "1" },
  backgroundIdentity: { principalKind: "user", principalId: "owner-1" },
};

const envelope: eventSchema.EventEnvelope<Record<string, unknown>> = {
  eventId: "event-1",
  type: "push",
  version: 1,
  occurredAt: "2026-07-25T10:00:00.000Z",
  receivedAt: "2026-07-25T10:00:00.000Z",
  businessId: "business-1",
  source: { provider: "gitlab", deliveryId: "delivery-1" },
  principal: { kind: "service", internalId: "oim-ingress" },
  record: {},
  deduplicationKey: "business-1:gitlab@2:connection-1:delivery-1",
  classification: [],
  data: {
    protocol: "oim",
    integrationMajorVersion: 2,
    connectionId: "connection-1",
    payload: {},
  },
  verification: { status: "verified", method: "internal" },
};

describe("dispatchEventTrigger authorization", () => {
  it("checks live authorization after exact matching and before Run creation", async () => {
    const authorizeTrigger = vi.fn(async () => true);
    const startRun = vi.fn(async () => ({ runId: "run-1", outcome: "started" as const }));

    await expect(
      dispatchEventTrigger(envelope, {
        listTriggers: async () => [trigger],
        authorizeTrigger,
        startRun,
      })
    ).resolves.toEqual({
      kind: "started",
      triggerSlug: "on-push",
      runId: "run-1",
      outcome: "started",
    });
    expect(authorizeTrigger).toHaveBeenCalledWith(trigger, envelope);
    expect(startRun).toHaveBeenCalledOnce();
  });

  it("fails closed when live authorization denies or cannot be read", async () => {
    const startRun = vi.fn(async () => ({ runId: "run-1", outcome: "started" as const }));

    for (const authorizeTrigger of [
      async () => false,
      async () => {
        throw new Error("authority unavailable");
      },
    ]) {
      await expect(
        dispatchEventTrigger(envelope, {
          listTriggers: async () => [trigger],
          authorizeTrigger,
          startRun,
        })
      ).resolves.toEqual({
        kind: "rejected",
        triggerSlug: "on-push",
        code: "authorization_denied",
      });
    }
    expect(startRun).not.toHaveBeenCalled();
  });

  it("requires an authorization seam for an OIM event", async () => {
    const startRun = vi.fn(async () => ({ runId: "run-1", outcome: "started" as const }));

    await expect(
      dispatchEventTrigger(envelope, {
        listTriggers: async () => [trigger],
        startRun,
      })
    ).resolves.toEqual({
      kind: "rejected",
      triggerSlug: "on-push",
      code: "authorization_denied",
    });
    expect(startRun).not.toHaveBeenCalled();
  });
});
