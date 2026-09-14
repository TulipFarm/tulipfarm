import type { OimManifest } from "@tulipfarm/schema";
import type { PersistedWebhookDelivery } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { drainInbox, type InboxProcessor } from "./drain";

const manifest = {
  metadata: { id: "acme", version: "2.0.0" },
  events: {
    path: "/events",
    verification: { scheme: "hmac_sha256", secretSlot: "webhook_secret" },
    deduplication: { kind: "none" },
    eventTypes: [
      {
        type: "ticket.created",
        selector: { pointer: "/type", equals: "ticket_created" },
        schema: {
          type: "object",
          required: ["type"],
          properties: { type: { type: "string" } },
        },
      },
    ],
  },
} as unknown as OimManifest;

function delivery(
  state: PersistedWebhookDelivery["state"],
  overrides: Partial<PersistedWebhookDelivery> = {}
): PersistedWebhookDelivery {
  return {
    businessId: "business-1",
    id: "delivery-1",
    integrationId: "acme",
    integrationMajorVersion: 2,
    connectionId: "connection-1",
    externalTenantId: "tenant-1",
    externalAccountId: "account-1",
    deduplicationKey: "provider-1",
    bodySha256: "a".repeat(64),
    safeHeaders: {},
    encryptedBody: 'enc:{"type":"ticket_created"}',
    eventType: "ticket.created",
    verification: "verified",
    authenticatedEvidenceDigest: "b".repeat(64),
    state,
    attempts: 1,
    lastError: null,
    normalizedPayload: state === "normalized" ? { type: "ticket_created" } : null,
    replayOfId: null,
    receivedAt: new Date(),
    nextAttemptAt: new Date(),
    leaseExpiresAt: new Date("2026-03-01T12:02:00.000Z"),
    rawDeletedAt: null,
    ...overrides,
  };
}

describe("drainInbox", () => {
  it("persists normalized payload before dispatching on a later claim", async () => {
    const markNormalized = vi.fn(async () => true);
    const emitIfAuthorized = vi.fn();
    const inbox = {
      claim: async () => [delivery("accepted")],
      markNormalized,
      markDispatched: vi.fn(),
      markFailed: vi.fn(),
    } as unknown as InboxProcessor;

    const result = await drainInbox({
      inbox,
      manifestFor: async () => manifest,
      decryptPayload: async (encrypted) => Buffer.from(encrypted.replace(/^enc:/, "")),
      emitIfAuthorized,
    });

    expect(result).toMatchObject({ normalized: 1, dispatched: 0 });
    expect(markNormalized).toHaveBeenCalledWith(
      "business-1",
      "delivery-1",
      "ticket.created",
      { type: "ticket_created" },
      expect.any(Object)
    );
    expect(emitIfAuthorized).not.toHaveBeenCalled();
  });

  it("rechecks the exact Connection before dispatch and retries after revocation", async () => {
    const emitIfAuthorized = vi.fn(async () => "unauthorized" as const);
    const markFailed = vi.fn(async () => "normalized" as const);
    const inbox = {
      claim: async () => [delivery("normalized")],
      markNormalized: vi.fn(),
      markDispatched: vi.fn(),
      markFailed,
    } as unknown as InboxProcessor;

    const result = await drainInbox({
      inbox,
      manifestFor: async () => manifest,
      decryptPayload: async () => Buffer.from("{}"),
      emitIfAuthorized,
    });

    expect(result).toMatchObject({ dispatched: 0, retrying: 1, undispatched: 1 });
    expect(emitIfAuthorized).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "connection-1",
        externalTenantId: "tenant-1",
        externalAccountId: "account-1",
      }),
      expect.objectContaining({ expectedState: "normalized" })
    );
    expect(markFailed).toHaveBeenCalledWith(
      "business-1",
      "delivery-1",
      expect.stringContaining("no longer authorized"),
      expect.objectContaining({ expectedState: "normalized" })
    );
  });

  it.each(["inserted", "duplicate"] as const)(
    "treats an atomically %s event as dispatched",
    async (emission) => {
      const markFailed = vi.fn();
      const result = await drainInbox({
        inbox: {
          claim: async () => [delivery("normalized")],
          markNormalized: vi.fn(),
          markFailed,
        } as unknown as InboxProcessor,
        manifestFor: async () => manifest,
        decryptPayload: async () => Buffer.from("{}"),
        emitIfAuthorized: async () => emission,
      });

      expect(result).toMatchObject({ dispatched: 1, retrying: 0, undispatched: 0 });
      expect(markFailed).not.toHaveBeenCalled();
    }
  );

  it("does not mutate a delivery after losing its durable claim fence", async () => {
    const markFailed = vi.fn();
    const result = await drainInbox({
      inbox: {
        claim: async () => [delivery("normalized")],
        markNormalized: vi.fn(),
        markFailed,
      } as unknown as InboxProcessor,
      manifestFor: async () => manifest,
      decryptPayload: async () => Buffer.from("{}"),
      emitIfAuthorized: async () => "stale",
    });

    expect(result).toMatchObject({ dispatched: 0, retrying: 0, undispatched: 0 });
    expect(markFailed).not.toHaveBeenCalled();
  });

  it("normalizes a websocket-sourced delivery through its ingress event types", async () => {
    const websocketManifest = {
      metadata: { id: "acme", version: "2.0.0" },
      profiles: { core: "1.0", events: "1.0" },
      ingress: {
        kind: "websocket",
        operationId: "open-socket",
        urlPointer: "/url",
        deduplication: { kind: "body_pointer", bodyPointer: "/envelope_id" },
        reconnect: { maxAttempts: 5, initialDelaySeconds: 1, maxDelaySeconds: 30 },
        eventTypes: [
          {
            type: "message.created",
            selector: { pointer: "/type", equals: "message_created" },
            schema: {
              type: "object",
              required: ["type"],
              properties: { type: { type: "string" } },
            },
          },
        ],
      },
    } as unknown as OimManifest;
    const markNormalized = vi.fn(async () => true);

    const result = await drainInbox({
      inbox: {
        claim: async () => [
          delivery("accepted", {
            verification: "verified_websocket",
            eventType: "message.created",
            encryptedBody: 'enc:{"type":"message_created"}',
          }),
        ],
        markNormalized,
        markFailed: vi.fn(),
      } as unknown as InboxProcessor,
      manifestFor: async () => websocketManifest,
      decryptPayload: async (encrypted) => Buffer.from(encrypted.replace(/^enc:/, "")),
      emitIfAuthorized: vi.fn(),
    });

    expect(result).toMatchObject({ normalized: 1, dispatched: 0 });
    expect(markNormalized).toHaveBeenCalledWith(
      "business-1",
      "delivery-1",
      "message.created",
      { type: "message_created" },
      expect.any(Object)
    );
  });
});
