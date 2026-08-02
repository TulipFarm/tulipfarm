import { type ArtifactContent, RoutineStateScheduler } from "@tulipfarm/run-kernel";
import { MANUAL_REQUEST_SCHEMA_REF, type routine } from "@tulipfarm/schema";
import type { PersistedRun, PersistedState } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import type { StateTransitionPort } from "../agent-state";
import type { LoadedRoutineDefinition } from "./definition-loader";
import { createRoutineExecutor } from "./executor";

const STARTED_AT = "2026-08-02T00:00:00.000Z";
const INPUT_REGION_EXPRESSION = `\${ input.region }`;

function definition(states: readonly routine.RoutineState[]): routine.RoutineDefinition {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "Routine",
    metadata: {
      id: "00000000-0000-4000-8000-000000000101",
      slug: "daily-digest",
      schemaVersion: 1,
      authoredVersion: 3,
      lifecycle: "published",
    },
    spec: { owner: "agent:assistant", start: states[0]?.name ?? "Start", states: [...states] },
  };
}

function run(): PersistedRun {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    businessId: "business-1",
    source: "routine",
    bundle: {
      digest: "bundle-digest",
      routineId: "00000000-0000-4000-8000-000000000101",
      routineVersion: "3",
    },
    identity: {
      initiator: { kind: "agent", id: "assistant" },
      effectiveSubject: { kind: "agent", id: "assistant" },
      guardrailContextRef: "guardrail:default",
    },
    bounds: {
      wallTimeMs: 60_000,
      activeTimeMs: 30_000,
      attempts: 3,
      sideEffects: 0,
    },
    status: "running",
    version: 2,
    createdAt: STARTED_AT,
    startedAt: STARTED_AT,
    finishedAt: null,
    resultArtifactId: null,
    errorEvidenceRef: null,
    leaseOwner: "worker-1",
    leaseExpiresAt: "2026-08-02T00:01:00.000Z",
  };
}

function state(key: string, status: PersistedState["status"] = "pending"): PersistedState {
  return {
    businessId: "business-1",
    runId: run().id,
    key,
    definitionRef: `definition:${key}`,
    resolvedInput: key === "Start" ? { payloadRef: `artifact:${run().id}:request` } : {},
    status,
    version: 0,
    createdAt: STARTED_AT,
    startedAt: null,
    finishedAt: null,
    resultArtifactId: null,
    errorEvidenceRef: null,
  };
}

const requestArtifact: ArtifactContent = {
  schemaRef: MANUAL_REQUEST_SCHEMA_REF,
  content: { slug: "daily-digest", inputs: { score: 7, region: "west" } },
  contentHash: "request-hash",
};

class StateHarness implements StateTransitionPort {
  readonly states = new Map<string, PersistedState>();
  readonly transitions: string[] = [];
  readonly events: string[] = [];
  inserted = 0;
  failAfterSchedule = false;

  constructor(initial: readonly PersistedState[]) {
    for (const persisted of initial) this.states.set(persisted.key, persisted);
  }

  readonly scheduler = new RoutineStateScheduler({
    ensureState: async (input) => {
      this.events.push(`${input.key}:scheduled`);
      const existing = this.states.get(input.key);
      if (existing !== undefined) return { outcome: "existing", state: existing };
      const inserted: PersistedState = {
        ...state(input.key),
        definitionRef: input.definitionRef,
        resolvedInput: input.resolvedInput,
        createdAt: input.createdAt,
      };
      this.states.set(input.key, inserted);
      this.inserted += 1;
      return { outcome: "inserted", state: inserted };
    },
  });

  async transition(input: Parameters<StateTransitionPort["transition"]>[0]): Promise<void> {
    const persisted = this.states.get(input.stateKey);
    if (persisted === undefined || persisted.status !== input.from) {
      throw new Error(`transition conflict:${input.stateKey}`);
    }
    if (
      this.failAfterSchedule &&
      input.stateKey === "Start" &&
      input.from === "running" &&
      input.to === "succeeded"
    ) {
      this.failAfterSchedule = false;
      throw new Error("injected crash");
    }
    this.transitions.push(`${input.stateKey}:${input.from}->${input.to}`);
    this.events.push(`${input.stateKey}:${input.from}->${input.to}`);
    this.states.set(input.stateKey, {
      ...persisted,
      status: input.to,
      version: persisted.version + 1,
      errorEvidenceRef: input.reason ?? persisted.errorEvidenceRef,
    });
  }
}

function executor(document: routine.RoutineDefinition, harness: StateHarness) {
  return createRoutineExecutor({
    definitions: {
      load: async () => ({ document }) as LoadedRoutineDefinition,
    },
    artifacts: { read: async () => requestArtifact },
    runs: { listStates: async () => [...harness.states.values()] },
    scheduler: harness.scheduler,
    transitions: harness,
    now: () => new Date(STARTED_AT),
  });
}

describe("createRoutineExecutor", () => {
  it("advances a pure ending branch through canonical State transitions", async () => {
    const harness = new StateHarness([state("Start")]);
    const execute = executor(
      definition([
        {
          type: "branch",
          name: "Start",
          conditions: [{ condition: "input.score > 0", end: true }],
          default: { end: true },
        },
      ]),
      harness
    );

    await expect(execute(run())).resolves.toBe("succeeded");
    expect(harness.transitions).toEqual([
      "Start:pending->ready",
      "Start:ready->claimed",
      "Start:claimed->running",
      "Start:running->succeeded",
    ]);
  });

  it("persists a resolved successor before settling its predecessor", async () => {
    const harness = new StateHarness([state("Start")]);
    const execute = executor(
      definition([
        {
          type: "branch",
          name: "Start",
          conditions: [{ condition: "input.score > 0", transition: "Finish" }],
          default: { end: true },
        },
        {
          type: "branch",
          name: "Finish",
          input: { copiedRegion: INPUT_REGION_EXPRESSION },
          conditions: [{ condition: "states.Start.output == null", end: true }],
          default: { end: true },
        },
      ]),
      harness
    );

    await expect(execute(run())).resolves.toBe("succeeded");
    expect(harness.states.get("Finish")?.resolvedInput).toEqual({ copiedRegion: "west" });
    expect(harness.inserted).toBe(1);
    expect(harness.events.indexOf("Finish:scheduled")).toBeLessThan(
      harness.events.indexOf("Start:running->succeeded")
    );
  });

  it("replays a crash after successor persistence without inserting duplicate work", async () => {
    const harness = new StateHarness([state("Start")]);
    const execute = executor(
      definition([
        {
          type: "branch",
          name: "Start",
          conditions: [{ condition: "true", transition: "Finish" }],
          default: { end: true },
        },
        {
          type: "branch",
          name: "Finish",
          conditions: [{ condition: "true", end: true }],
          default: { end: true },
        },
      ]),
      harness
    );
    harness.failAfterSchedule = true;

    await expect(execute(run())).rejects.toThrow("injected crash");
    expect(harness.states.get("Start")?.status).toBe("running");
    expect(harness.states.get("Finish")?.status).toBe("pending");
    await expect(execute(run())).resolves.toBe("succeeded");
    expect(harness.inserted).toBe(1);
    expect(harness.states.get("Finish")?.status).toBe("succeeded");
  });

  it("parks an unsupported effectful State without executing it", async () => {
    const harness = new StateHarness([state("Start")]);
    const execute = executor(
      definition([
        {
          type: "agent",
          name: "Start",
          agentRef: { name: "assistant", version: "1.0.0" },
          end: true,
        },
      ]),
      harness
    );

    await expect(execute(run())).resolves.toBe("needs_reconciliation");
    expect(harness.states.get("Start")).toMatchObject({
      status: "needs_reconciliation",
      errorEvidenceRef: "routine:unsupported_state",
    });
  });

  it("parks a branch that depends on Context the request Artifact cannot reconstruct", async () => {
    const harness = new StateHarness([state("Start")]);
    const execute = executor(
      definition([
        {
          type: "branch",
          name: "Start",
          conditions: [{ condition: "trigger.kind == 'manual'", end: true }],
          default: { end: true },
        },
      ]),
      harness
    );

    await expect(execute(run())).resolves.toBe("needs_reconciliation");
    expect(harness.states.get("Start")?.errorEvidenceRef).toBe("routine:unsupported_context");
  });
});
