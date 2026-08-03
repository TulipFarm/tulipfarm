import {
  type ArtifactContent,
  type RegisterWaitInput,
  RoutineStateScheduler,
  routineEffectId,
  routineWaitId,
} from "@tulipfarm/run-kernel";
import { MANUAL_REQUEST_SCHEMA_REF, type routine } from "@tulipfarm/schema";
import type { PersistedRun, PersistedState, PersistedWait } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import type { StateTransitionPort } from "../agent-state";
import type { LoadedRoutineDefinition } from "./definition-loader";
import { createRoutineExecutor } from "./executor";
import type { RoutineToolOutcome, RoutineToolRequest } from "./tool-port";

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
  content: { slug: "daily-digest", inputs: { score: 7, region: "west", tags: ["a", "b"] } },
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

  readonly waits = new Map<string, PersistedWait>();

  readonly waitPort = {
    register: async (input: RegisterWaitInput) => {
      this.events.push(`${input.stateKey}:wait-opened`);
      const wait = {
        ...input,
        status: "pending" as const,
        resolvedAt: null,
        version: 0,
      } satisfies PersistedWait;
      this.waits.set(input.id, wait);
      return { wait };
    },
    find: async (_businessId: string, waitId: string) => this.waits.get(waitId) ?? null,
  };

  /** Stands in for the deadline sweep: resolves a registered timer the way `resolveDueWait` does. */
  resolveWait(stateKey: string, status: "satisfied" | "timed_out"): void {
    const id = routineWaitId(run().id, stateKey);
    const wait = this.waits.get(id);
    if (wait === undefined) throw new Error(`no wait for ${stateKey}`);
    this.waits.set(id, { ...wait, status, resolvedAt: STARTED_AT });
  }

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
    waits: harness.waitPort,
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

describe("createRoutineExecutor — durable waits", () => {
  function waitDefinition(overrides: Record<string, unknown> = {}): routine.RoutineDefinition {
    return definition([
      {
        type: "wait",
        name: "Start",
        waitFor: { kind: "timer", durationMs: 60_000 },
        end: true,
        ...overrides,
      },
    ]);
  }

  it("opens a timer and parks the Run on it", async () => {
    const harness = new StateHarness([state("Start")]);

    await expect(executor(waitDefinition(), harness)(run())).resolves.toBe("waiting");
    expect(harness.transitions).toEqual([
      "Start:pending->ready",
      "Start:ready->claimed",
      "Start:claimed->running",
      "Start:running->waiting",
    ]);
    const wait = harness.waits.get(routineWaitId(run().id, "Start"));
    expect(wait).toMatchObject({ kind: "timer", stateKey: "Start", status: "pending" });
    expect(wait?.deadlineAt).toBe("2026-08-02T00:01:00.000Z");
  });

  it("re-parks a replay whose timer has not resolved without opening a second wait", async () => {
    const harness = new StateHarness([state("Start")]);
    const execute = executor(waitDefinition(), harness);

    await expect(execute(run())).resolves.toBe("waiting");
    await expect(execute(run())).resolves.toBe("waiting");
    expect(harness.waits.size).toBe(1);
    expect(harness.events.filter((event) => event === "Start:wait-opened")).toHaveLength(1);
  });

  it("resumes the chain once the deadline sweep satisfies the timer", async () => {
    const harness = new StateHarness([state("Start")]);
    const withSuccessor = executor(
      definition([
        {
          type: "wait",
          name: "Start",
          waitFor: { kind: "timer", durationMs: 60_000 },
          transition: "Finish",
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

    await expect(withSuccessor(run())).resolves.toBe("waiting");
    harness.resolveWait("Start", "satisfied");
    await expect(withSuccessor(run())).resolves.toBe("succeeded");
    expect(harness.transitions.slice(4)).toEqual([
      "Start:waiting->ready",
      "Start:ready->claimed",
      "Start:claimed->running",
      "Start:running->succeeded",
      "Finish:pending->ready",
      "Finish:ready->claimed",
      "Finish:claimed->running",
      "Finish:running->succeeded",
    ]);
  });

  it("takes the authored error path when the timer expires unsatisfied", async () => {
    const harness = new StateHarness([state("Start")]);
    const execute = executor(
      waitDefinition({ end: undefined, onError: [{ errorRef: "wait_timed_out", end: true }] }),
      harness
    );

    await expect(execute(run())).resolves.toBe("waiting");
    harness.resolveWait("Start", "timed_out");
    await expect(execute(run())).resolves.toBe("succeeded");
  });

  it("parks an expired timer the Routine declared no handler for", async () => {
    const harness = new StateHarness([state("Start")]);
    const execute = executor(waitDefinition(), harness);

    await expect(execute(run())).resolves.toBe("waiting");
    harness.resolveWait("Start", "timed_out");
    await expect(execute(run())).resolves.toBe("needs_reconciliation");
    expect(harness.states.get("Start")?.errorEvidenceRef).toBe("routine:wait_timed_out");
  });

  it("parks an event wait nothing in this process can signal", async () => {
    const harness = new StateHarness([state("Start")]);
    const execute = executor(
      waitDefinition({ waitFor: { kind: "event", eventType: "invoice.paid" } }),
      harness
    );

    await expect(execute(run())).resolves.toBe("needs_reconciliation");
    expect(harness.states.get("Start")?.errorEvidenceRef).toBe("routine:unsupported_wait");
    expect(harness.waits.size).toBe(0);
  });
});

describe("createRoutineExecutor — bounded fan-out", () => {
  function leaf(name: string): routine.RoutineState {
    return {
      type: "branch",
      name,
      conditions: [{ condition: "true", end: true }],
      default: { end: true },
    };
  }

  function parallelDefinition(overrides: Record<string, unknown> = {}) {
    return definition([
      {
        type: "parallel",
        name: "Start",
        branches: ["Left", "Right"],
        maxConcurrency: 2,
        join: "all",
        end: true,
        ...overrides,
      },
      leaf("Left"),
      leaf("Right"),
    ]);
  }

  it("executes every branch under its own occurrence key", async () => {
    const harness = new StateHarness([state("Start")]);

    await expect(executor(parallelDefinition(), harness)(run())).resolves.toBe("succeeded");
    expect(harness.states.get("Start#Left/Left")?.status).toBe("succeeded");
    expect(harness.states.get("Start#Right/Right")?.status).toBe("succeeded");
    expect(harness.inserted).toBe(2);
    expect(harness.events.indexOf("Start#Right/Right:running->succeeded")).toBeLessThan(
      harness.events.indexOf("Start:running->succeeded")
    );
  });

  it("dispatches in batches no larger than the authored concurrency bound", async () => {
    const harness = new StateHarness([state("Start")]);
    const execute = executor(parallelDefinition({ maxConcurrency: 1 }), harness);

    await expect(execute(run())).resolves.toBe("succeeded");
    expect(harness.events.indexOf("Start#Left/Left:running->succeeded")).toBeLessThan(
      harness.events.indexOf("Start#Right/Right:scheduled")
    );
  });

  it("replays a crashed fan-out against its durable rows without repeating settled work", async () => {
    const harness = new StateHarness([state("Start")]);
    const execute = executor(parallelDefinition(), harness);
    harness.failAfterSchedule = true;

    await expect(execute(run())).rejects.toThrow("injected crash");
    expect(harness.states.get("Start#Left/Left")?.status).toBe("succeeded");
    await expect(execute(run())).resolves.toBe("succeeded");
    expect(harness.inserted).toBe(2);
  });

  it("fans a foreach out over the pinned collection with per-item Context", async () => {
    const harness = new StateHarness([state("Start")]);
    const execute = executor(
      definition([
        {
          type: "foreach",
          name: "Start",
          items: "input.tags",
          body: "Body",
          maxItems: 10,
          maxConcurrency: 2,
          end: true,
        },
        {
          type: "branch",
          name: "Body",
          input: { tag: "${ item }" },
          conditions: [{ condition: "true", end: true }],
          default: { end: true },
        },
      ]),
      harness
    );

    await expect(execute(run())).resolves.toBe("succeeded");
    expect(harness.states.get("Start#0/Body")?.resolvedInput).toEqual({ tag: "a" });
    expect(harness.states.get("Start#1/Body")?.resolvedInput).toEqual({ tag: "b" });
    expect(harness.inserted).toBe(2);
  });

  it("repeats a bounded loop until its authored condition holds", async () => {
    const harness = new StateHarness([state("Start")]);
    const execute = executor(
      definition([
        {
          type: "repeat_until",
          name: "Start",
          condition: "loop.iteration >= 2",
          body: "Body",
          maxIterations: 5,
          maxDurationMs: 60_000,
          end: true,
        },
        leaf("Body"),
      ]),
      harness
    );

    await expect(execute(run())).resolves.toBe("succeeded");
    expect([...harness.states.keys()]).toEqual(["Start", "Start#0/Body", "Start#1/Body"]);
  });

  it("parks a loop that exhausts its iteration bound rather than exiting silently", async () => {
    const harness = new StateHarness([state("Start")]);
    const execute = executor(
      definition([
        {
          type: "repeat_until",
          name: "Start",
          condition: "loop.iteration >= 5",
          body: "Body",
          maxIterations: 1,
          maxDurationMs: 60_000,
          end: true,
        },
        leaf("Body"),
      ]),
      harness
    );

    await expect(execute(run())).resolves.toBe("needs_reconciliation");
    expect(harness.states.get("Start")?.errorEvidenceRef).toBe("routine:iteration_cap_exceeded");
  });
});

describe("createRoutineExecutor — tool States", () => {
  const bundle = { digest: "bundle-digest" } as unknown as LoadedRoutineDefinition["bundle"];

  function toolExecutor(
    document: routine.RoutineDefinition,
    harness: StateHarness,
    outcome: RoutineToolOutcome,
    calls: RoutineToolRequest[] = []
  ) {
    return createRoutineExecutor({
      definitions: {
        load: async () => ({ document, bundle }) as LoadedRoutineDefinition,
      },
      artifacts: { read: async () => requestArtifact },
      runs: { listStates: async () => [...harness.states.values()] },
      scheduler: harness.scheduler,
      transitions: harness,
      waits: harness.waitPort,
      tools: {
        execute: async (request) => {
          calls.push(request);
          return outcome;
        },
      },
      authority: () => [{ name: "routine", grants: [] }],
      now: () => new Date(STARTED_AT),
    });
  }

  const commentState: routine.RoutineState = {
    type: "tool",
    name: "Start",
    toolRef: { name: "github.issue.comment", version: "1.0.0" },
    action: "issue.comment",
    destination: "github",
    input: { body: INPUT_REGION_EXPRESSION },
    end: true,
  } as routine.RoutineState;

  it("dispatches a Tool State through the broker port and settles it", async () => {
    const harness = new StateHarness([state("Start")]);
    const calls: RoutineToolRequest[] = [];
    const execute = toolExecutor(definition([commentState]), harness, { kind: "succeeded" }, calls);

    await expect(execute(run())).resolves.toBe("succeeded");
    expect(harness.transitions).toEqual([
      "Start:pending->ready",
      "Start:ready->claimed",
      "Start:claimed->running",
      "Start:running->succeeded",
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.plan.arguments).toEqual({ body: "west" });
    expect(calls[0]?.plan.effectId).toBe(routineEffectId(run().id, "Start"));
    expect(calls[0]?.authorityLayers).toEqual([{ name: "routine", grants: [] }]);
  });

  it("parks a Tool State when no Tool authority is composed", async () => {
    const harness = new StateHarness([state("Start")]);
    const execute = createRoutineExecutor({
      definitions: {
        load: async () =>
          ({ document: definition([commentState]), bundle }) as LoadedRoutineDefinition,
      },
      artifacts: { read: async () => requestArtifact },
      runs: { listStates: async () => [...harness.states.values()] },
      scheduler: harness.scheduler,
      transitions: harness,
      waits: harness.waitPort,
      now: () => new Date(STARTED_AT),
    });

    await expect(execute(run())).resolves.toBe("needs_reconciliation");
    expect(harness.states.get("Start")?.errorEvidenceRef).toBe("routine:unsupported_state");
  });

  it("parks an intent awaiting a human rather than dispatching or failing it", async () => {
    const harness = new StateHarness([state("Start")]);
    const execute = toolExecutor(definition([commentState]), harness, {
      kind: "awaiting_approval",
      reason: "approval_required",
    });

    await expect(execute(run())).resolves.toBe("needs_reconciliation");
    expect(harness.states.get("Start")?.errorEvidenceRef).toBe("routine:approval_required");
  });

  it("parks an effect only reconciliation can resolve, naming what stopped it", async () => {
    const harness = new StateHarness([state("Start")]);
    const execute = toolExecutor(definition([commentState]), harness, {
      kind: "unavailable",
      reason: "effect_ambiguous",
    });

    await expect(execute(run())).resolves.toBe("needs_reconciliation");
    expect(harness.states.get("Start")?.errorEvidenceRef).toBe("routine:effect_ambiguous");
  });

  it("lets an authored handler claim a denied dispatch", async () => {
    const harness = new StateHarness([state("Start")]);
    const execute = toolExecutor(
      definition([
        {
          ...commentState,
          end: undefined,
          onError: [{ errorRef: "tool_guardrail_denied", transition: "Fallback" }],
        } as routine.RoutineState,
        {
          type: "branch",
          name: "Fallback",
          conditions: [{ condition: "input.score > 0", end: true }],
          default: { end: true },
        },
      ]),
      harness,
      { kind: "failed", reason: "guardrail_denied" }
    );

    await expect(execute(run())).resolves.toBe("succeeded");
    expect(harness.events).toContain("Fallback:scheduled");
  });

  it("fails a Tool State whose refusal no handler claims", async () => {
    const harness = new StateHarness([state("Start")]);
    const execute = toolExecutor(definition([commentState]), harness, {
      kind: "failed",
      reason: "dispatch_failed",
    });

    await expect(execute(run())).resolves.toBe("failed");
    expect(harness.transitions).toContain("Start:running->failed");
  });
});
