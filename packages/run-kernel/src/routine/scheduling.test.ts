import type {
  EnsureStateInput,
  EnsureStateResult,
  PersistedRun,
  PersistedState,
} from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import {
  RoutineStateScheduleError,
  RoutineStateScheduler,
  type RoutineStateScheduleStore,
  routineOccurrenceKey,
  routineWaitId,
} from "./scheduling";

const RUN: PersistedRun = {
  id: "00000000-0000-4000-8000-000000000001",
  businessId: "business-1",
  source: "routine",
  bundle: {
    digest: "digest/one",
    routineId: "routine one",
    routineVersion: "7/beta",
  },
  identity: {
    initiator: { kind: "user", id: "user-1" },
    effectiveSubject: { kind: "agent", id: "agent-1" },
    guardrailContextRef: "guardrail-context-1",
  },
  status: "running",
  version: 2,
  createdAt: "2026-08-02T10:00:00.000Z",
  startedAt: "2026-08-02T10:00:01.000Z",
  finishedAt: null,
  resultArtifactId: null,
  errorEvidenceRef: null,
  leaseOwner: "worker-1",
  leaseExpiresAt: "2026-08-02T10:01:01.000Z",
};

function state(input: EnsureStateInput): PersistedState {
  return {
    businessId: input.businessId,
    runId: input.runId,
    key: input.key,
    definitionRef: input.definitionRef,
    resolvedInput: input.resolvedInput,
    status: "pending",
    version: 0,
    createdAt: input.createdAt,
    startedAt: null,
    finishedAt: null,
    resultArtifactId: null,
    errorEvidenceRef: null,
  };
}

class RecordingScheduleStore implements RoutineStateScheduleStore {
  readonly inputs: EnsureStateInput[] = [];

  async ensureState(input: EnsureStateInput): Promise<EnsureStateResult> {
    this.inputs.push(input);
    return { outcome: "inserted", state: state(input) };
  }
}

describe("RoutineStateScheduler", () => {
  it("pins an authored State to the Run bundle under a distinct durable occurrence key", async () => {
    const store = new RecordingScheduleStore();
    const scheduler = new RoutineStateScheduler(store);

    await expect(
      scheduler.schedule({
        run: RUN,
        stateKey: "Notify:item:0",
        definitionStateKey: "Notify owner",
        resolvedInput: { artifactId: "artifact-output-1" },
        createdAt: "2026-08-02T10:00:02.000Z",
      })
    ).resolves.toMatchObject({ outcome: "inserted", state: { key: "Notify:item:0" } });
    expect(store.inputs).toEqual([
      {
        businessId: "business-1",
        runId: RUN.id,
        key: "Notify:item:0",
        definitionRef: "bundle:digest%2Fone/routines/routine%20one@7%2Fbeta/states/Notify%20owner",
        resolvedInput: { artifactId: "artifact-output-1" },
        createdAt: "2026-08-02T10:00:02.000Z",
      },
    ]);
  });

  it("rejects non-Routine Runs before persistence", async () => {
    const store = new RecordingScheduleStore();
    const scheduler = new RoutineStateScheduler(store);

    await expect(
      scheduler.schedule({
        run: { ...RUN, source: "chat" },
        stateKey: "Notify",
        definitionStateKey: "Notify",
        resolvedInput: {},
        createdAt: "2026-08-02T10:00:02.000Z",
      })
    ).rejects.toEqual(new RoutineStateScheduleError("non_routine_run", RUN.id));
    expect(store.inputs).toEqual([]);
  });

  it("rejects incomplete State or bundle identity before persistence", async () => {
    const store = new RecordingScheduleStore();
    const scheduler = new RoutineStateScheduler(store);

    await expect(
      scheduler.schedule({
        run: RUN,
        stateKey: "",
        definitionStateKey: "Notify",
        resolvedInput: {},
        createdAt: "2026-08-02T10:00:02.000Z",
      })
    ).rejects.toEqual(new RoutineStateScheduleError("invalid_state_identity", RUN.id));
    await expect(
      scheduler.schedule({
        run: { ...RUN, bundle: { ...RUN.bundle, digest: "" } },
        stateKey: "Notify",
        definitionStateKey: "Notify",
        resolvedInput: {},
        createdAt: "2026-08-02T10:00:02.000Z",
      })
    ).rejects.toEqual(new RoutineStateScheduleError("invalid_state_identity", RUN.id));
    expect(store.inputs).toEqual([]);
  });
});

describe("routineOccurrenceKey", () => {
  it("addresses one occurrence of an authored State inside a fan-out", () => {
    expect(routineOccurrenceKey("Fan", "0", "Notify")).toBe("Fan#0/Notify");
  });

  it("nests, so a fan-out inside a fan-out keeps distinct rows", () => {
    const outer = routineOccurrenceKey("Fan", "0", "Inner");
    expect(routineOccurrenceKey(outer, "1", "Notify")).toBe("Fan#0/Inner#1/Notify");
  });
});

describe("routineWaitId", () => {
  it("derives a stable uuid, so a replay finds the wait it already opened", () => {
    const first = routineWaitId(RUN.id, "Fan#0/Notify");
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(routineWaitId(RUN.id, "Fan#0/Notify")).toBe(first);
  });

  it("separates occurrences and Runs", () => {
    expect(routineWaitId(RUN.id, "Fan#0/Notify")).not.toBe(routineWaitId(RUN.id, "Fan#1/Notify"));
    expect(routineWaitId(RUN.id, "Notify")).not.toBe(
      routineWaitId("00000000-0000-4000-8000-000000000002", "Notify")
    );
  });
});
