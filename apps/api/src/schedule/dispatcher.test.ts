import type { RuntimeBundle } from "@tulipfarm/soul";
import { describe, expect, it, vi } from "vitest";
import { ScheduleDispatcher } from "./dispatcher";
import type { RoutineScheduleStateRow, RoutineScheduleStateStore } from "./state-store";

const NOW_MS = Date.parse("2026-01-01T00:00:00.000Z");
const DUE_AT = new Date(NOW_MS - 3_600_000).toISOString();

/** One published datetime Trigger, already due, so `planSchedule` always returns exactly one fire. */
function activeBundleWithDueTrigger(): RuntimeBundle {
  return {
    bundleVersion: 1,
    businessId: "biz-1",
    changesetId: "changeset-1",
    commitSha: "commit-1",
    digest: "digest",
    definitions: [
      {
        kind: "Trigger",
        id: "22222222-2222-4222-8222-222222222222",
        slug: "daily-digest-once",
        authoredVersion: 1,
        hash: "hash",
        references: [],
        document: {
          apiVersion: "tulipfarm.ai/v1",
          kind: "Trigger",
          metadata: {
            id: "22222222-2222-4222-8222-222222222222",
            slug: "daily-digest-once",
            schemaVersion: 1,
            authoredVersion: 1,
            lifecycle: "published",
          },
          spec: {
            type: "datetime",
            at: DUE_AT,
            routineRef: { name: "daily-digest", version: "1" },
            eventType: "routine.scheduled",
            eventVersion: 1,
            backgroundIdentity: { principalKind: "service", principalId: "routine-runner" },
            deduplication: { key: "daily-digest-once" },
          },
        },
      },
    ],
    assets: [],
    get: () => undefined,
    getById: () => undefined,
  };
}

function fakeStateStore(
  rows: readonly RoutineScheduleStateRow[] = []
): RoutineScheduleStateStore & {
  upserted: unknown[];
  prunedWith: readonly RoutineScheduleStateRow[] | undefined;
} {
  const store = {
    upserted: [] as unknown[],
    prunedWith: undefined as readonly RoutineScheduleStateRow[] | undefined,
    listForBusiness: async () => rows,
    upsert: async (_businessId: string, row: unknown) => {
      store.upserted.push(row);
    },
    pruneMissing: async (
      _businessId: string,
      _stillLive: unknown,
      existing: readonly RoutineScheduleStateRow[]
    ) => {
      store.prunedWith = existing;
    },
  };
  return store as unknown as RoutineScheduleStateStore & {
    upserted: unknown[];
    prunedWith: readonly RoutineScheduleStateRow[] | undefined;
  };
}

describe("ScheduleDispatcher", () => {
  it("does not advance the watermark when startRoutine fails, so the fire is retried next tick", async () => {
    const stateStore = fakeStateStore();
    const dispatcher = new ScheduleDispatcher({
      activeBundle: async () => activeBundleWithDueTrigger(),
      stateStore,
      startRoutine: vi.fn().mockRejectedValue(new Error("transient")),
      businessId: "biz-1",
      now: () => NOW_MS,
      log: { warn: vi.fn(), error: vi.fn() },
    });

    await dispatcher.tick();

    expect(stateStore.upserted).toEqual([
      expect.objectContaining({ routineSlug: "daily-digest", lastScheduledForMs: null }),
    ]);
  });

  it("advances the watermark when startRoutine succeeds", async () => {
    const stateStore = fakeStateStore();
    const dispatcher = new ScheduleDispatcher({
      activeBundle: async () => activeBundleWithDueTrigger(),
      stateStore,
      startRoutine: vi.fn().mockResolvedValue({ runId: "run-1", outcome: "started" }),
      businessId: "biz-1",
      now: () => NOW_MS,
    });

    await dispatcher.tick();

    expect(stateStore.upserted).toEqual([
      expect.objectContaining({
        routineSlug: "daily-digest",
        lastScheduledForMs: Date.parse(DUE_AT),
      }),
    ]);
  });

  it("prunes using the same read tick() already made, rather than re-querying", async () => {
    const existingRow: RoutineScheduleStateRow = {
      routineSlug: "stale-routine",
      triggerIndex: 0,
      dedupKey: "stale-routine:0",
      lastScheduledForMs: 1,
      nextDueAtMs: null,
    };
    const stateStore = fakeStateStore([existingRow]);
    const dispatcher = new ScheduleDispatcher({
      activeBundle: async () => undefined,
      stateStore,
      startRoutine: vi.fn(),
      businessId: "biz-1",
      now: () => NOW_MS,
    });

    await dispatcher.tick();

    expect(stateStore.prunedWith).toEqual([existingRow]);
  });
});
