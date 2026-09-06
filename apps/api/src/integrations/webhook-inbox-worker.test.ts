import type { OimManifest } from "@tulipfarm/schema";
import type { SoulLoader } from "@tulipfarm/soul";
import type { WebhookInboxStore } from "@tulipfarm/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RAW_RETENTION_DAYS,
  startWebhookInboxWorker,
  type WebhookInboxWorker,
  type WebhookInboxWorkerDeps,
  webhookInboxDrainDeps,
} from "./webhook-inbox-worker";

function manifest(id: string, version: string): OimManifest {
  return { metadata: { id, version }, events: { path: "/x" } } as unknown as OimManifest;
}

function loader(manifests: OimManifest[]): SoulLoader {
  return {
    integrations: new Map(
      manifests.map((oimManifest, index) => [`slug-${index}`, { oimManifest }])
    ),
  } as unknown as SoulLoader;
}

function deps(overrides: Partial<WebhookInboxWorkerDeps> = {}): WebhookInboxWorkerDeps {
  return {
    inbox: {
      claim: vi.fn(async () => []),
      markNormalized: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => "accepted"),
      discardRawPayloadsBefore: vi.fn(async () => 0),
    } as unknown as WebhookInboxStore,
    soulLoader: loader([manifest("weather", "1.2.0")]),
    decryptPayload: async (encrypted: string) => Buffer.from(encrypted, "utf8"),
    dispatch: vi.fn(async () => undefined),
    newEventId: () => "event-1",
    log: { info: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

let worker: WebhookInboxWorker | undefined;

afterEach(() => {
  worker?.stop();
  worker = undefined;
  vi.useRealTimers();
});

describe("webhookInboxDrainDeps", () => {
  it("finds the installed manifest by id", async () => {
    const { manifestFor } = webhookInboxDrainDeps(deps());
    expect(await manifestFor("biz-1", "weather", 1)).toMatchObject({
      metadata: { id: "weather" },
    });
  });

  it("does not normalize a v1 delivery with v2 rules", async () => {
    // The payload is the one v1 promised to understand; v2 may have changed what a field means.
    const { manifestFor } = webhookInboxDrainDeps(
      deps({ soulLoader: loader([manifest("weather", "2.0.0")]) })
    );
    expect(await manifestFor("biz-1", "weather", 1)).toBeNull();
  });

  it("finds nothing for an Integration that is not installed", async () => {
    const { manifestFor } = webhookInboxDrainDeps(deps());
    expect(await manifestFor("biz-1", "billing", 1)).toBeNull();
  });

  it("looks past an Integration that declares no OIM manifest", async () => {
    const soulLoader = {
      integrations: new Map([
        ["legacy", {}],
        ["weather", { oimManifest: manifest("weather", "1.0.0") }],
      ]),
    } as unknown as SoulLoader;
    const { manifestFor } = webhookInboxDrainDeps(deps({ soulLoader }));
    expect(await manifestFor("biz-1", "weather", 1)).not.toBeNull();
  });
});

describe("startWebhookInboxWorker", () => {
  it("drains on a timer", async () => {
    vi.useFakeTimers();
    const claim = vi.fn(async () => []);
    const dependencies = deps({
      inbox: {
        claim,
        markNormalized: vi.fn(),
        markFailed: vi.fn(),
        discardRawPayloadsBefore: vi.fn(async () => 0),
      } as unknown as WebhookInboxStore,
    });

    worker = startWebhookInboxWorker(dependencies);
    await vi.advanceTimersByTimeAsync(11_000);

    expect(claim).toHaveBeenCalled();
  });

  it("keeps running after a drain fails", async () => {
    // One unreadable delivery must not silence the loop for every other Integration.
    vi.useFakeTimers();
    const claim = vi.fn(async () => {
      throw new Error("database down");
    });
    const log = { info: vi.fn(), error: vi.fn() };
    worker = startWebhookInboxWorker(
      deps({
        inbox: {
          claim,
          markNormalized: vi.fn(),
          markFailed: vi.fn(),
          discardRawPayloadsBefore: vi.fn(async () => 0),
        } as unknown as WebhookInboxStore,
        log,
      })
    );

    await vi.advanceTimersByTimeAsync(11_000);

    expect(claim.mock.calls.length).toBeGreaterThan(1);
    expect(log.error).toHaveBeenCalled();
  });

  it("discards payloads past the retention window", async () => {
    vi.useFakeTimers();
    const discardRawPayloadsBefore = vi.fn(async (_before: Date) => 3);
    worker = startWebhookInboxWorker(
      deps({
        inbox: {
          claim: vi.fn(async () => []),
          markNormalized: vi.fn(),
          markFailed: vi.fn(),
          discardRawPayloadsBefore,
        } as unknown as WebhookInboxStore,
      })
    );

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 1000);

    const before = discardRawPayloadsBefore.mock.calls[0]?.[0] as Date;
    const days = (Date.now() - before.getTime()) / (24 * 60 * 60 * 1000);
    expect(Math.round(days)).toBe(DEFAULT_RAW_RETENTION_DAYS);
  });

  it("stops both loops", async () => {
    vi.useFakeTimers();
    const claim = vi.fn(async () => []);
    worker = startWebhookInboxWorker(
      deps({
        inbox: {
          claim,
          markNormalized: vi.fn(),
          markFailed: vi.fn(),
          discardRawPayloadsBefore: vi.fn(async () => 0),
        } as unknown as WebhookInboxStore,
      })
    );
    worker.stop();
    worker = undefined;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(claim).not.toHaveBeenCalled();
  });
});
