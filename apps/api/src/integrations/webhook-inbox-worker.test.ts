import { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { drainInbox, type IntegrationEvent } from "@tulipfarm/integrations";
import {
  ArtifactService,
  DurableInvocationGateway,
  INVOCATION_STORAGE_STATEMENTS,
  PgDurableInvocationStore,
  type RegisteredTrigger,
  TypedOutputValidator,
} from "@tulipfarm/run-kernel";
import type { OimManifest } from "@tulipfarm/schema";
import { INVOCATION_REQUEST_SCHEMAS } from "@tulipfarm/schema";
import type { SoulLoader } from "@tulipfarm/soul";
import {
  ARTIFACT_STORAGE_STATEMENTS,
  ArtifactStore,
  type PersistedWebhookDelivery,
  RUN_STORAGE_STATEMENTS,
  type WebhookInboxStore,
} from "@tulipfarm/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ambientTransactionPort, type Queryable, transactionPort } from "../db";
import { triggerRunStarter } from "../runtime/invocation-callers";
import { EventTriggerGateway } from "../triggers/event-dispatch";
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

describe("webhook event-to-Run crash recovery", () => {
  it("adopts the same durable Run when dispatch is retried after its completion write crashes", async () => {
    const database = new PGlite();
    try {
      for (const statement of [
        ...RUN_STORAGE_STATEMENTS,
        ...ARTIFACT_STORAGE_STATEMENTS,
        ...INVOCATION_STORAGE_STATEMENTS,
      ]) {
        await database.query(statement);
      }
      const validator = new TypedOutputValidator(INVOCATION_REQUEST_SCHEMAS);
      let runSequence = 0;
      const invocations = new DurableInvocationGateway({
        store: new PgDurableInvocationStore(
          transactionPort(database as unknown as Queryable),
          (transaction) =>
            new ArtifactService(new ArtifactStore(ambientTransactionPort(transaction)), validator)
        ),
        validator,
        routineDefinitions: {
          async resolve() {
            return {
              bundle: {
                digest: "bundle-digest",
                routineId: "forecast-routine",
                routineVersion: "1",
              },
              startState: { key: "start", definitionRef: "published:routine:forecast-routine" },
            };
          },
        },
        nextId: () => `00000000-0000-4000-8000-${String(++runSequence).padStart(12, "0")}`,
      });
      const trigger: RegisteredTrigger = {
        authoredVersion: 1,
        lifecycle: "published",
        triggerSlug: "on-forecast",
        type: "integration_event",
        protocol: "oim",
        eventType: "forecast.updated",
        eventVersion: 1,
        provider: "weather",
        integrationMajorVersion: 1,
        connectionId: "connection-1",
        routineRef: { name: "forecast-routine", version: "1" },
        backgroundIdentity: { principalKind: "service", principalId: "routine-runner" },
      };
      const eventNow = vi
        .fn()
        .mockReturnValueOnce("2026-09-07T06:00:00.000Z")
        .mockReturnValueOnce("2026-09-07T06:01:00.000Z");
      const eventGateway = new EventTriggerGateway({
        listTriggers: async () => [trigger],
        startRun: triggerRunStarter(invocations),
        nextEventId: () => "unused",
        now: eventNow,
        authorizeOimTrigger: async () => true,
      });
      const dispatchResults: unknown[] = [];
      const dispatch = async (event: IntegrationEvent) => {
        dispatchResults.push(await eventGateway.dispatchIntegrationEvent(event));
      };
      const normalizedDelivery: PersistedWebhookDelivery = {
        businessId: DEPLOYMENT_BUSINESS_ID,
        id: "delivery-1",
        integrationId: "weather",
        integrationMajorVersion: 1,
        connectionId: "connection-1",
        deduplicationKey: "provider-delivery-1",
        bodySha256: "a".repeat(64),
        safeHeaders: {},
        encryptedBody: "ciphertext",
        eventType: "forecast.updated",
        verification: "hmac_sha256",
        state: "normalized",
        attempts: 1,
        lastError: null,
        normalizedPayload: { city: "Indore" },
        replayOfId: null,
        receivedAt: new Date(),
        nextAttemptAt: new Date(),
        leaseExpiresAt: new Date("2026-09-07T07:00:00.000Z"),
        rawDeletedAt: null,
      };
      const inbox = {
        claim: vi
          .fn()
          .mockResolvedValueOnce([normalizedDelivery])
          .mockResolvedValueOnce([normalizedDelivery]),
        markNormalized: vi.fn(async () => true),
        markFailed: vi.fn(async () => "normalized" as const),
        markDispatched: vi
          .fn()
          .mockRejectedValueOnce(new Error("completion write crashed"))
          .mockResolvedValueOnce(true),
        discardRawPayloadsBefore: vi.fn(async () => 0),
      } as unknown as WebhookInboxStore;
      const drainDeps = webhookInboxDrainDeps(deps({ inbox, dispatch }));

      await expect(drainInbox(drainDeps)).rejects.toThrow("completion write crashed");
      await expect(drainInbox(drainDeps)).resolves.toMatchObject({ dispatched: 1 });

      expect(dispatchResults).toEqual([
        expect.objectContaining({ kind: "started", outcome: "started" }),
        expect.objectContaining({ kind: "started", outcome: "duplicate" }),
      ]);
      expect(eventNow).toHaveBeenCalledTimes(2);
      const { rows } = await database.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM runs"
      );
      expect(rows[0]?.count).toBe(1);
    } finally {
      await database.close();
    }
  });
});
