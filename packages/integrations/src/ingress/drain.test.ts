import type { OimManifest } from "@tulipfarm/schema";
import type { PersistedWebhookDelivery } from "@tulipfarm/storage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OimHookPhaseRunner } from "../oim-hooks";
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
    leaseExpiresAt: new Date("2026-09-07T07:00:00.000Z"),
    rawDeletedAt: null,
    ...overrides,
  };
}

let claim: ReturnType<typeof vi.fn>;
let markNormalized: ReturnType<typeof vi.fn>;
let markDispatched: ReturnType<typeof vi.fn>;
let markFailed: ReturnType<typeof vi.fn>;
let emit: ReturnType<typeof vi.fn>;

function deps(overrides: Partial<DrainDeps> = {}): DrainDeps {
  return {
    inbox: { claim, markNormalized, markDispatched, markFailed } as unknown as InboxProcessor,
    manifestFor: async () => MANIFEST,
    decryptPayload: async (encrypted: string) =>
      Buffer.from(encrypted.replace(/^enc:/, ""), "utf8"),
    emit: emit as unknown as DrainDeps["emit"],
    ...overrides,
  };
}

function hookRunner(run: OimHookPhaseRunner["run"]): OimHookPhaseRunner {
  return { run };
}

beforeEach(() => {
  claim = vi.fn(async () => [delivery()]);
  markNormalized = vi.fn(async () => true);
  markDispatched = vi.fn(async () => true);
  markFailed = vi.fn(async () => "accepted");
  emit = vi.fn(async () => undefined);
});

describe("drainInbox", () => {
  it("persists a normalized delivery before dispatching it", async () => {
    const summary = await drainInbox(deps());

    expect(summary).toEqual({
      claimed: 1,
      normalized: 1,
      dispatched: 0,
      retrying: 0,
      deadLettered: 0,
      undispatched: 0,
    });
    expect(markNormalized).toHaveBeenCalledWith(
      "biz-1",
      "d-1",
      "forecast.updated",
      { type: "forecast_updated" },
      expect.objectContaining({
        expectedState: "accepted",
        expectedAttempts: 1,
        expectedLeaseExpiresAt: delivery().leaseExpiresAt,
        now: expect.any(Date),
      })
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it("normalizes polling deliveries from the polling-owned event contract", async () => {
    const { events, ...baseManifest } = MANIFEST;
    const pollingManifest = {
      ...baseManifest,
      ingress: {
        kind: "polling",
        operationId: "poll",
        intervalSeconds: 60,
        eventTypes: events?.eventTypes,
        cursor: { responsePointer: "/cursor", requestParameter: "cursor" },
      },
    } as OimManifest;
    claim = vi.fn(async () => [delivery({ verification: "polling" })]);

    const summary = await drainInbox(deps({ manifestFor: async () => pollingManifest }));

    expect(markFailed).not.toHaveBeenCalled();
    expect(summary.normalized).toBe(1);
    expect(markNormalized).toHaveBeenCalledWith(
      "biz-1",
      "d-1",
      "forecast.updated",
      { type: "forecast_updated" },
      expect.any(Object)
    );
  });

  it("dispatches a durably normalized event and marks it complete", async () => {
    claim = vi.fn(async () => [
      delivery({
        state: "normalized",
        normalizedPayload: { type: "forecast_updated" },
      }),
    ]);

    const summary = await drainInbox(deps());

    expect(summary).toMatchObject({ normalized: 0, dispatched: 1, undispatched: 0 });
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
    expect(markDispatched).toHaveBeenCalledWith(
      "biz-1",
      "d-1",
      expect.objectContaining({
        expectedState: "normalized",
        expectedAttempts: 1,
        expectedLeaseExpiresAt: delivery().leaseExpiresAt,
      })
    );
  });

  it("gives a hook only the payload and the safe headers", async () => {
    const runHook = vi.fn<OimHookPhaseRunner["run"]>(async () => ({
      type: "forecast_updated",
    }));
    const manifest = {
      ...MANIFEST,
      hooks: [
        {
          kind: "response_normalize",
          file: "hooks/normalize.js",
          export: "toForecast",
        },
      ],
      events: {
        ...MANIFEST.events,
        eventTypes: [{ ...MANIFEST.events?.eventTypes[0], normalize: "toForecast" }],
      },
    } as unknown as OimManifest;

    await drainInbox(
      deps({
        manifestFor: async () => manifest,
        hookRunnerFor: async () => hookRunner(runHook),
      })
    );

    expect(runHook).toHaveBeenCalledWith(manifest.hooks?.[0], {
      payload: { type: "forecast_updated" },
      safeHeaders: { "x-delivery-id": "d-1" },
    });
  });

  it("classifies a durable raw delivery before normalization", async () => {
    claim = vi.fn(async () => [delivery({ eventType: null })]);
    const runHook = vi.fn<OimHookPhaseRunner["run"]>(async () => "forecast.updated");
    const manifest = {
      ...MANIFEST,
      hooks: [
        {
          kind: "webhook_classify",
          file: "hooks/classify.js",
          export: "classify",
        },
      ],
    } as unknown as OimManifest;

    const summary = await drainInbox(
      deps({
        manifestFor: async () => manifest,
        hookRunnerFor: async () => hookRunner(runHook),
      })
    );

    expect(summary.normalized).toBe(1);
    expect(runHook).toHaveBeenCalledWith(manifest.hooks?.[0], {
      payload: { type: "forecast_updated" },
      safeHeaders: { "x-delivery-id": "d-1" },
    });
    expect(markNormalized).toHaveBeenCalledWith(
      "biz-1",
      "d-1",
      "forecast.updated",
      { type: "forecast_updated" },
      expect.any(Object)
    );
  });

  it("retries when a declared classifier cannot run", async () => {
    claim = vi.fn(async () => [delivery({ eventType: null })]);
    const manifest = {
      ...MANIFEST,
      hooks: [
        {
          kind: "webhook_classify",
          file: "hooks/classify.js",
          export: "classify",
        },
      ],
    } as unknown as OimManifest;

    const summary = await drainInbox(deps({ manifestFor: async () => manifest }));

    expect(summary.retrying).toBe(1);
    expect(markNormalized).not.toHaveBeenCalled();
  });

  it("dead-letters an undeclared classifier result without publishing it", async () => {
    claim = vi.fn(async () => [delivery({ eventType: null })]);
    markFailed = vi.fn(async () => "dead_letter");
    const runHook = vi.fn<OimHookPhaseRunner["run"]>(async () => "admin.created");
    const manifest = {
      ...MANIFEST,
      hooks: [
        {
          kind: "webhook_classify",
          file: "hooks/classify.js",
          export: "classify",
        },
      ],
    } as unknown as OimManifest;

    const summary = await drainInbox(
      deps({
        manifestFor: async () => manifest,
        hookRunnerFor: async () => hookRunner(runHook),
      })
    );

    expect(summary.deadLettered).toBe(1);
    expect(markFailed.mock.calls[0]?.[3]).toMatchObject({ maxAttempts: 0 });
    expect(markNormalized).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("keeps one poison delivery from stopping the ones behind it", async () => {
    claim = vi.fn(async () => [
      delivery({ id: "d-bad", encryptedBody: "enc:not json" }),
      delivery(),
    ]);
    const summary = await drainInbox(deps());

    expect(summary.normalized).toBe(1);
    expect(summary.retrying).toBe(1);
    expect(emit).not.toHaveBeenCalled();
  });

  it("retries a delivery whose Integration is momentarily unreadable", async () => {
    const summary = await drainInbox(deps({ manifestFor: async () => null }));

    expect(summary.retrying).toBe(1);
    expect(markFailed).toHaveBeenCalledWith(
      "biz-1",
      "d-1",
      expect.stringContaining("no Integration weather"),
      expect.objectContaining({
        maxAttempts: expect.any(Number),
        expectedState: "accepted",
        expectedAttempts: 1,
      })
    );
  });

  it("backs off further on each attempt", async () => {
    claim = vi.fn(async () => [delivery({ attempts: 3, encryptedBody: "enc:not json" })]);
    await drainInbox(deps());
    expect(markFailed.mock.calls[0]?.[3]).toMatchObject({ backoffSeconds: 120 });
  });

  it("dead-letters output that can never satisfy the declared schema", async () => {
    // Retrying a hook that returns the wrong shape only delays telling whoever has to fix it.
    const runHook = vi.fn<OimHookPhaseRunner["run"]>(async () => ({ wrong: true }));
    const manifest = {
      ...MANIFEST,
      hooks: [
        {
          kind: "response_normalize",
          file: "hooks/normalize.js",
          export: "toForecast",
        },
      ],
      events: {
        ...MANIFEST.events,
        eventTypes: [{ ...MANIFEST.events?.eventTypes[0], normalize: "toForecast" }],
      },
    } as unknown as OimManifest;
    markFailed = vi.fn(async () => "dead_letter");

    const summary = await drainInbox(
      deps({
        manifestFor: async () => manifest,
        hookRunnerFor: async () => hookRunner(runHook),
      })
    );

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

  it("retries a normalized delivery whose event failed to dispatch", async () => {
    claim = vi.fn(async () => [
      delivery({
        state: "normalized",
        normalizedPayload: { type: "forecast_updated" },
      }),
    ]);
    emit = vi.fn(async () => {
      throw new Error("seam down");
    });
    const summary = await drainInbox(deps());

    expect(summary).toMatchObject({ normalized: 0, dispatched: 0, retrying: 1, undispatched: 1 });
    expect(markNormalized).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith(
      "biz-1",
      "d-1",
      expect.stringContaining("seam down"),
      expect.objectContaining({
        maxAttempts: expect.any(Number),
        expectedState: "normalized",
        expectedAttempts: 1,
      })
    );
  });

  it("dead-letters a normalized event after bounded dispatch retries", async () => {
    claim = vi.fn(async () => [
      delivery({
        state: "normalized",
        attempts: 5,
        normalizedPayload: { type: "forecast_updated" },
      }),
    ]);
    emit = vi.fn(async () => {
      throw new Error("Run store unavailable");
    });
    markFailed = vi.fn(async () => "dead_letter");

    const summary = await drainInbox(deps());

    expect(summary).toMatchObject({ dispatched: 0, deadLettered: 1 });
    expect(markFailed).toHaveBeenCalledWith(
      "biz-1",
      "d-1",
      expect.stringContaining("Run store unavailable"),
      expect.objectContaining({ maxAttempts: 5 })
    );
  });

  it("retries dispatch without running normalization again", async () => {
    const normalized = delivery({
      state: "normalized",
      normalizedPayload: { type: "forecast_updated" },
    });
    claim = vi.fn().mockResolvedValueOnce([normalized]).mockResolvedValueOnce([normalized]);
    emit = vi
      .fn()
      .mockRejectedValueOnce(new Error("Run store unavailable"))
      .mockResolvedValueOnce(undefined);

    await expect(drainInbox(deps())).resolves.toMatchObject({ retrying: 1, undispatched: 1 });
    await expect(drainInbox(deps())).resolves.toMatchObject({ dispatched: 1 });

    expect(markNormalized).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledOnce();
    expect(markDispatched).toHaveBeenCalledOnce();
  });

  it("keeps draining after one delivery fails to dispatch", async () => {
    claim = vi.fn(async () => [
      delivery({
        id: "d-1",
        state: "normalized",
        normalizedPayload: { type: "forecast_updated" },
      }),
      delivery({
        id: "d-2",
        state: "normalized",
        normalizedPayload: { type: "forecast_updated" },
      }),
    ]);
    emit = vi.fn(async (event: { deliveryId: string }) => {
      if (event.deliveryId === "d-1") throw new Error("seam down");
    });

    const summary = await drainInbox(deps());
    expect(summary).toMatchObject({ claimed: 2, dispatched: 1, retrying: 1, undispatched: 1 });
  });

  it("reuses the delivery id when a crash happens after Run creation", async () => {
    const normalized = delivery({
      state: "normalized",
      normalizedPayload: { type: "forecast_updated" },
    });
    claim = vi.fn().mockResolvedValueOnce([normalized]).mockResolvedValueOnce([normalized]);
    const runIds = new Map<string, string>();
    emit = vi.fn(async (event: { deliveryId: string }) => {
      if (!runIds.has(event.deliveryId)) runIds.set(event.deliveryId, `run-${runIds.size + 1}`);
    });
    markDispatched = vi
      .fn()
      .mockRejectedValueOnce(new Error("database crashed"))
      .mockResolvedValueOnce(true);

    await expect(drainInbox(deps())).rejects.toThrow("database crashed");
    await expect(drainInbox(deps())).resolves.toMatchObject({ dispatched: 1 });

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls.map(([event]) => event.deliveryId)).toEqual(["d-1", "d-1"]);
    expect([...runIds.values()]).toEqual(["run-1"]);
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
      dispatched: 0,
      retrying: 0,
      deadLettered: 0,
      undispatched: 0,
    });
  });
});
