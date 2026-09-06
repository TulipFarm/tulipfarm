import type { OimManifest } from "@tulipfarm/schema";
import type { PersistedWebhookDelivery } from "@tulipfarm/storage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type DrainDeps, drainInbox, type InboxProcessor } from "./drain";

const MANIFEST = {
  metadata: { id: "weather", version: "1.0.0" },
  events: {
    path: "/weather",
    verification: {
      scheme: "hmac_sha256",
      secretSlot: "webhook_secret",
      signatureHeader: "x-signature",
      signatureEncoding: "hex",
    },
    deduplication: { kind: "none" },
    eventTypes: [
      {
        type: "forecast.updated",
        selector: { pointer: "/type", equals: "forecast_updated" },
        schema: {
          type: "object",
          required: ["type"],
          properties: { type: { type: "string" } },
        },
        safeHeaders: ["x-delivery-id"],
      },
    ],
  },
} as unknown as OimManifest;

const BODY = '{"type":"forecast_updated"}';

function delivery(overrides: Partial<PersistedWebhookDelivery> = {}): PersistedWebhookDelivery {
  return {
    businessId: "biz-1",
    id: "d-1",
    integrationId: "weather",
    integrationMajorVersion: 1,
    connectionId: "connection-1",
    deduplicationKey: null,
    bodySha256: "a".repeat(64),
    safeHeaders: { "x-delivery-id": "d-1" },
    encryptedBody: `enc:${BODY}`,
    eventType: "forecast.updated",
    verification: "hmac_sha256",
    state: "accepted",
    attempts: 1,
    lastError: null,
    normalizedPayload: null,
    replayOfId: null,
    receivedAt: new Date(),
    nextAttemptAt: new Date(),
    leaseExpiresAt: null,
    rawDeletedAt: null,
    ...overrides,
  };
}

let claim: ReturnType<typeof vi.fn>;
let markNormalized: ReturnType<typeof vi.fn>;
let markFailed: ReturnType<typeof vi.fn>;
let emit: ReturnType<typeof vi.fn>;

function deps(overrides: Partial<DrainDeps> = {}): DrainDeps {
  return {
    inbox: { claim, markNormalized, markFailed } as unknown as InboxProcessor,
    manifestFor: async () => MANIFEST,
    decryptPayload: async (encrypted: string) =>
      Buffer.from(encrypted.replace(/^enc:/, ""), "utf8"),
    emit: emit as unknown as DrainDeps["emit"],
    ...overrides,
  };
}

beforeEach(() => {
  claim = vi.fn(async () => [delivery()]);
  markNormalized = vi.fn(async () => undefined);
  markFailed = vi.fn(async () => "accepted");
  emit = vi.fn(async () => undefined);
});

describe("drainInbox", () => {
  it("normalizes a delivery and dispatches one typed event", async () => {
    const summary = await drainInbox(deps());

    expect(summary).toEqual({
      claimed: 1,
      normalized: 1,
      retrying: 0,
      deadLettered: 0,
      undispatched: 0,
    });
    expect(markNormalized).toHaveBeenCalledWith("biz-1", "d-1", { type: "forecast_updated" });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz-1",
        integrationId: "weather",
        deliveryId: "d-1",
        type: "forecast.updated",
        connectionId: "connection-1",
        safeHeaders: { "x-delivery-id": "d-1" },
      })
    );
  });

  it("gives a hook only the payload and the safe headers", async () => {
    const runHook = vi.fn(async () => ({ type: "forecast_updated" }));
    const manifest = {
      ...MANIFEST,
      events: {
        ...MANIFEST.events,
        eventTypes: [{ ...MANIFEST.events?.eventTypes[0], normalize: "toForecast" }],
      },
    } as unknown as OimManifest;

    await drainInbox(deps({ manifestFor: async () => manifest, runHook }));

    expect(runHook).toHaveBeenCalledWith("toForecast", {
      payload: { type: "forecast_updated" },
      safeHeaders: { "x-delivery-id": "d-1" },
    });
  });

  it("keeps one poison delivery from stopping the ones behind it", async () => {
    claim = vi.fn(async () => [
      delivery({ id: "d-bad", encryptedBody: "enc:not json" }),
      delivery(),
    ]);
    const summary = await drainInbox(deps());

    expect(summary.normalized).toBe(1);
    expect(summary.retrying).toBe(1);
    expect(emit).toHaveBeenCalledOnce();
  });

  it("retries a delivery whose Integration is momentarily unreadable", async () => {
    const summary = await drainInbox(deps({ manifestFor: async () => null }));

    expect(summary.retrying).toBe(1);
    expect(markFailed).toHaveBeenCalledWith(
      "biz-1",
      "d-1",
      expect.stringContaining("no Integration weather"),
      expect.objectContaining({ maxAttempts: expect.any(Number) })
    );
  });

  it("backs off further on each attempt", async () => {
    claim = vi.fn(async () => [delivery({ attempts: 3, encryptedBody: "enc:not json" })]);
    await drainInbox(deps());
    expect(markFailed.mock.calls[0]?.[3]).toMatchObject({ backoffSeconds: 120 });
  });

  it("dead-letters output that can never satisfy the declared schema", async () => {
    // Retrying a hook that returns the wrong shape only delays telling whoever has to fix it.
    const runHook = vi.fn(async () => ({ wrong: true }));
    const manifest = {
      ...MANIFEST,
      events: {
        ...MANIFEST.events,
        eventTypes: [{ ...MANIFEST.events?.eventTypes[0], normalize: "toForecast" }],
      },
    } as unknown as OimManifest;
    markFailed = vi.fn(async () => "dead_letter");

    const summary = await drainInbox(deps({ manifestFor: async () => manifest, runHook }));

    expect(summary.deadLettered).toBe(1);
    expect(markFailed.mock.calls[0]?.[3]).toMatchObject({ maxAttempts: 0 });
    expect(emit).not.toHaveBeenCalled();
  });

  it("dead-letters a delivery whose payload retention already expired", async () => {
    claim = vi.fn(async () => [delivery({ encryptedBody: null, rawDeletedAt: new Date() })]);
    markFailed = vi.fn(async () => "dead_letter");

    const summary = await drainInbox(deps());

    expect(summary.deadLettered).toBe(1);
    expect(markFailed.mock.calls[0]?.[3]).toMatchObject({ maxAttempts: 0 });
  });

  it("does not reopen a delivery whose event failed to dispatch", async () => {
    // The hook already ran. Reopening would run it again and emit the event twice.
    emit = vi.fn(async () => {
      throw new Error("seam down");
    });
    const summary = await drainInbox(deps());

    expect(summary).toMatchObject({ normalized: 0, undispatched: 1 });
    expect(markNormalized).toHaveBeenCalledOnce();
    expect(markFailed).not.toHaveBeenCalled();
  });

  it("keeps draining after one delivery fails to dispatch", async () => {
    claim = vi.fn(async () => [delivery({ id: "d-1" }), delivery({ id: "d-2" })]);
    emit = vi.fn(async (event: { deliveryId: string }) => {
      if (event.deliveryId === "d-1") throw new Error("seam down");
    });

    const summary = await drainInbox(deps());
    expect(summary).toMatchObject({ claimed: 2, normalized: 1, undispatched: 1 });
  });

  it("retries a delivery whose accepted event type the Integration no longer declares", async () => {
    claim = vi.fn(async () => [delivery({ eventType: "forecast.retired" })]);
    const summary = await drainInbox(deps());

    expect(summary.retrying).toBe(1);
    expect(emit).not.toHaveBeenCalled();
  });

  it("claims nothing and reports nothing when the inbox is empty", async () => {
    claim = vi.fn(async () => []);
    expect(await drainInbox(deps())).toEqual({
      claimed: 0,
      normalized: 0,
      retrying: 0,
      deadLettered: 0,
      undispatched: 0,
    });
  });
});
