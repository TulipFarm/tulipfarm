import type { RuntimeBundle } from "@tulipfarm/soul";
import { describe, expect, it, vi } from "vitest";
import { ScheduleDispatcher } from "./dispatcher";
import type { RoutineScheduleStateRow, RoutineScheduleStateStore } from "./state-store";

const NOW_MS = Date.parse("2026-01-01T00:00:00.000Z");
const DUE_AT = new Date(NOW_MS - 3_600_000).toISOString();

const ROUTINE_DEFINITION = {
  kind: "Routine",
  id: "11111111-1111-4111-8111-111111111111",
  slug: "daily-digest",
  authoredVersion: 1,
  hash: "hash",
  references: [],
  document: {},
};

/** Resolves the Routine a Trigger names, which the dispatcher needs to count its active Runs. */
function bundleGet(kind: string, slug: string) {
  return kind === "Routine" && slug === "daily-digest" ? ROUTINE_DEFINITION : undefined;
}

function bundleWith(triggerSpec: Record<string, unknown>): RuntimeBundle {
  const document = {
    apiVersion: "tulipfarm.ai/v1",
    kind: "Routine",
    metadata: {
      id: ROUTINE_DEFINITION.id,
      slug: "daily-digest",
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "published",
    },
    spec: {
      owner: "operations",
      start: "Done",
      states: [],
      triggers: [
        {
          name: "daily-digest-once",
          eventType: "routine.scheduled",
          eventVersion: 1,
          backgroundIdentity: { principalKind: "service", principalId: "routine-runner" },
          deduplication: { key: "daily-digest-once" },
          ...triggerSpec,
        },
      ],
    },
  };
  return {
    businessId: "biz-1",
    changesetId: "changeset-1",
    commitSha: "commit-1",
    digest: "digest",
    definitions: [{ ...ROUTINE_DEFINITION, document }],
    assets: [],
    get: bundleGet,
    getById: () => undefined,
    asset: () => undefined,
  } as unknown as RuntimeBundle;
}

/** One published datetime Trigger, already due, so `planSchedule` always returns exactly one fire. */
function activeBundleWithDueTrigger(): RuntimeBundle {
  return bundleWith({ type: "datetime", at: DUE_AT });
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
      countActiveRuns: async () => 0,
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
      countActiveRuns: async () => 0,
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

  it("starts the Run under the Trigger's authored background identity", async () => {
    const startRoutine = vi.fn().mockResolvedValue({ runId: "run-1", outcome: "started" });
    const dispatcher = new ScheduleDispatcher({
      activeBundle: async () => activeBundleWithDueTrigger(),
      stateStore: fakeStateStore(),
      startRoutine,
      countActiveRuns: async () => 0,
      businessId: "biz-1",
      now: () => NOW_MS,
    });

    await dispatcher.tick();

    // The identity becomes the Run's effective subject, and a Routine's Agent States authorize
    // their Tool calls against it — a fixed scheduler name holds no grants.
    expect(startRoutine).toHaveBeenCalledWith(
      expect.objectContaining({ identity: { kind: "service", id: "routine-runner" } })
    );
  });

  it("prunes using the same read tick() already made, rather than re-querying", async () => {
    const existingRow: RoutineScheduleStateRow = {
      routineSlug: "stale-routine",
      triggerIndex: 0,
      dedupKey: "stale-routine:0",
      lastScheduledForMs: 1,
      nextDueAtMs: null,
      anchorMs: null,
    };
    const stateStore = fakeStateStore([existingRow]);
    const dispatcher = new ScheduleDispatcher({
      activeBundle: async () => undefined,
      stateStore,
      startRoutine: vi.fn(),
      countActiveRuns: async () => 0,
      businessId: "biz-1",
      now: () => NOW_MS,
    });

    await dispatcher.tick();

    expect(stateStore.prunedWith).toEqual([existingRow]);
  });

  it("suppresses a due fire when a Run is still active and overlapPolicy is skip", async () => {
    const startRoutine = vi.fn().mockResolvedValue({ runId: "run-1", outcome: "started" });
    const dispatcher = new ScheduleDispatcher({
      activeBundle: async () =>
        bundleWith({
          type: "datetime",
          at: DUE_AT,
          schedule: { missedRunPolicy: "skip", overlapPolicy: "skip" },
        }),
      stateStore: fakeStateStore(),
      startRoutine,
      countActiveRuns: async () => 1,
      businessId: "biz-1",
      now: () => NOW_MS,
    });

    await dispatcher.tick();

    expect(startRoutine).not.toHaveBeenCalled();
  });

  it("still fires when overlapPolicy is skip but nothing is active", async () => {
    const startRoutine = vi.fn().mockResolvedValue({ runId: "run-1", outcome: "started" });
    const dispatcher = new ScheduleDispatcher({
      activeBundle: async () =>
        bundleWith({
          type: "datetime",
          at: DUE_AT,
          schedule: { missedRunPolicy: "skip", overlapPolicy: "skip" },
        }),
      stateStore: fakeStateStore(),
      startRoutine,
      countActiveRuns: async () => 0,
      businessId: "biz-1",
      now: () => NOW_MS,
    });

    await dispatcher.tick();

    expect(startRoutine).toHaveBeenCalledTimes(1);
  });

  it("fires an interval Trigger that authored no startAt, and persists the anchor it chose", async () => {
    const stateStore = fakeStateStore();
    const startRoutine = vi.fn().mockResolvedValue({ runId: "run-1", outcome: "started" });
    const dispatcher = new ScheduleDispatcher({
      activeBundle: async () => bundleWith({ type: "interval", everyMs: 300_000 }),
      stateStore,
      startRoutine,
      countActiveRuns: async () => 0,
      businessId: "biz-1",
      now: () => NOW_MS,
    });

    await dispatcher.tick();

    expect(startRoutine).toHaveBeenCalledTimes(1);
    expect(stateStore.upserted).toEqual([expect.objectContaining({ anchorMs: NOW_MS })]);
  });

  it("re-uses the persisted interval anchor, so the next occurrence cannot recede each tick", async () => {
    const stateStore = fakeStateStore([
      {
        routineSlug: "daily-digest",
        triggerIndex: 0,
        dedupKey: "daily-digest-once",
        lastScheduledForMs: NOW_MS,
        nextDueAtMs: NOW_MS + 300_000,
        anchorMs: NOW_MS,
      },
    ]);
    const startRoutine = vi.fn().mockResolvedValue({ runId: "run-2", outcome: "started" });
    const dispatcher = new ScheduleDispatcher({
      activeBundle: async () => bundleWith({ type: "interval", everyMs: 300_000 }),
      stateStore,
      startRoutine,
      countActiveRuns: async () => 0,
      businessId: "biz-1",
      // One minute later: not yet a multiple of `everyMs` from the anchor.
      now: () => NOW_MS + 60_000,
    });

    await dispatcher.tick();

    expect(startRoutine).not.toHaveBeenCalled();
    expect(stateStore.upserted).toEqual([expect.objectContaining({ anchorMs: NOW_MS })]);
  });

  it("fires the interval again once a full period has passed since the anchor", async () => {
    const startRoutine = vi.fn().mockResolvedValue({ runId: "run-2", outcome: "started" });
    const dispatcher = new ScheduleDispatcher({
      activeBundle: async () => bundleWith({ type: "interval", everyMs: 300_000 }),
      stateStore: fakeStateStore([
        {
          routineSlug: "daily-digest",
          triggerIndex: 0,
          dedupKey: "daily-digest-once",
          lastScheduledForMs: NOW_MS,
          nextDueAtMs: NOW_MS + 300_000,
          anchorMs: NOW_MS,
        },
      ]),
      startRoutine,
      countActiveRuns: async () => 0,
      businessId: "biz-1",
      now: () => NOW_MS + 300_000,
    });

    await dispatcher.tick();

    expect(startRoutine).toHaveBeenCalledTimes(1);
  });
  it("cancels the running Run before starting its replacement under overlapPolicy supersede", async () => {
    const order: string[] = [];
    const dispatcher = new ScheduleDispatcher({
      activeBundle: async () =>
        bundleWith({
          type: "datetime",
          at: DUE_AT,
          schedule: { missedRunPolicy: "skip", overlapPolicy: "supersede" },
        }),
      stateStore: fakeStateStore(),
      startRoutine: vi.fn().mockImplementation(async () => {
        order.push("start");
        return { runId: "run-2", outcome: "started" };
      }),
      countActiveRuns: async () => 1,
      supersedeActiveRuns: async () => {
        order.push("supersede");
      },
      businessId: "biz-1",
      now: () => NOW_MS,
    });

    await dispatcher.tick();

    expect(order).toEqual(["supersede", "start"]);
  });

  it("does not cancel anything when no Run is active", async () => {
    const supersedeActiveRuns = vi.fn().mockResolvedValue(undefined);
    const dispatcher = new ScheduleDispatcher({
      activeBundle: async () =>
        bundleWith({
          type: "datetime",
          at: DUE_AT,
          schedule: { missedRunPolicy: "skip", overlapPolicy: "supersede" },
        }),
      stateStore: fakeStateStore(),
      startRoutine: vi.fn().mockResolvedValue({ runId: "run-1", outcome: "started" }),
      countActiveRuns: async () => 0,
      supersedeActiveRuns,
      businessId: "biz-1",
      now: () => NOW_MS,
    });

    await dispatcher.tick();

    expect(supersedeActiveRuns).not.toHaveBeenCalled();
  });

  it("leaves the watermark alone when the supersede cancel fails, so no overlap is created", async () => {
    const startRoutine = vi.fn().mockResolvedValue({ runId: "run-2", outcome: "started" });
    const stateStore = fakeStateStore();
    const dispatcher = new ScheduleDispatcher({
      activeBundle: async () =>
        bundleWith({
          type: "datetime",
          at: DUE_AT,
          schedule: { missedRunPolicy: "skip", overlapPolicy: "supersede" },
        }),
      stateStore,
      startRoutine,
      countActiveRuns: async () => 1,
      supersedeActiveRuns: async () => {
        throw new Error("cancel refused");
      },
      businessId: "biz-1",
      now: () => NOW_MS,
      log: { warn: vi.fn(), error: vi.fn() },
    });

    await dispatcher.tick();

    expect(startRoutine).not.toHaveBeenCalled();
    expect(stateStore.upserted).toEqual([expect.objectContaining({ lastScheduledForMs: null })]);
  });

  it("skips the occurrence entirely under overlapPolicy skip", async () => {
    const startRoutine = vi.fn();
    const dispatcher = new ScheduleDispatcher({
      activeBundle: async () =>
        bundleWith({
          type: "datetime",
          at: DUE_AT,
          schedule: { missedRunPolicy: "skip", overlapPolicy: "skip" },
        }),
      stateStore: fakeStateStore(),
      startRoutine,
      countActiveRuns: async () => 1,
      businessId: "biz-1",
      now: () => NOW_MS,
      log: { warn: vi.fn(), error: vi.fn() },
    });

    await dispatcher.tick();

    expect(startRoutine).not.toHaveBeenCalled();
  });
});
