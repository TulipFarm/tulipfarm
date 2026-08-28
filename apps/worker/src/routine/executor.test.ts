import {
  type ArtifactContent,
  InMemoryStateConcurrencyStore,
  InMemoryStateContentionStore,
  InMemoryStateRetryStore,
  type RegisterWaitInput,
  RoutineStateScheduler,
  routineConcurrencyWaitId,
  routineEffectId,
  routineWaitId,
  STATE_CONCURRENCY_MAX_WAITS,
} from "@tulipfarm/run-kernel";
import { MANUAL_REQUEST_SCHEMA_REF, type routine } from "@tulipfarm/schema";
import type { PersistedRun, PersistedState, PersistedWait } from "@tulipfarm/storage";
import type { StateTransitionPort } from "@tulipfarm/turn-executor";
import { describe, expect, it } from "vitest";
import type { RoutineAgentOutcome, RoutineAgentPort, RoutineAgentRequest } from "./agent-port";
import type {
  RoutineApprovalDecision,
  RoutineApprovalPort,
  RoutineApprovalRecord,
} from "./approval-port";
import type {
  ChildRoutinePort,
  ChildRoutineRecord,
  ChildRoutineStatus,
  StartChildRoutineInput,
} from "./child-routine-port";
import type { LoadedRoutineDefinition } from "./definition-loader";
import type { EmitEventInput, EmitPort, EmitRecord } from "./emit-port";
import { createRoutineExecutor } from "./executor";
import { SandboxRoutineScriptPort } from "./script-port";
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
    output: null,
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

  /** Stands in for the deadline sweep firing a State's concurrency backoff timer. */
  resolveConcurrencyWait(stateKey: string, attempt: number): void {
    const id = routineConcurrencyWaitId(run().id, stateKey, attempt);
    const wait = this.waits.get(id);
    if (wait === undefined) throw new Error(`no backoff wait ${attempt} for ${stateKey}`);
    this.waits.set(id, { ...wait, status: "satisfied", resolvedAt: STARTED_AT });
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
      output: input.output === undefined ? persisted.output : input.output.value,
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

  it("derives a value in a compute State and hands it to the next State", async () => {
    const harness = new StateHarness([state("Start")]);
    const execute = executor(
      definition([
        {
          type: "compute",
          name: "Start",
          input: { label: "need-triage", region: INPUT_REGION_EXPRESSION },
          transition: "Route",
        },
        {
          type: "branch",
          name: "Route",
          input: { carried: "${ states.Start.output.label }" },
          conditions: [
            { condition: "states.Start.output.label == 'need-triage'", transition: "Matched" },
          ],
          default: { transition: "Missed" },
        },
        { type: "compute", name: "Matched", input: { ok: true }, end: true },
        { type: "compute", name: "Missed", input: { ok: false }, end: true },
      ] as unknown as routine.RoutineState[]),
      harness
    );

    await expect(execute(run())).resolves.toBe("succeeded");
    expect(harness.states.get("Route")?.resolvedInput).toEqual({ carried: "need-triage" });
    expect(harness.transitions).toContain("Matched:running->succeeded");
    expect(harness.states.has("Missed")).toBe(false);
  });

  it("republishes a settled compute State's value on replay", async () => {
    const harness = new StateHarness([state("Start", "succeeded"), state("Route")]);
    const execute = executor(
      definition([
        {
          type: "compute",
          name: "Start",
          input: { label: "need-triage" },
          transition: "Route",
        },
        {
          type: "branch",
          name: "Route",
          conditions: [
            { condition: "states.Start.output.label == 'need-triage'", transition: "Matched" },
          ],
          default: { transition: "Missed" },
        },
        { type: "compute", name: "Matched", input: { ok: true }, end: true },
        { type: "compute", name: "Missed", input: { ok: false }, end: true },
      ] as unknown as routine.RoutineState[]),
      harness
    );

    await expect(execute(run())).resolves.toBe("succeeded");
    expect(harness.transitions).toContain("Matched:running->succeeded");
    expect(harness.states.has("Missed")).toBe(false);
  });

  it("parks a compute State whose mapping cannot resolve, without settling it", async () => {
    const harness = new StateHarness([state("Start")]);
    const execute = executor(
      definition([
        {
          type: "compute",
          name: "Start",
          input: { derived: "${ input.absent }" },
          end: true,
        },
      ] as unknown as routine.RoutineState[]),
      harness
    );

    await expect(execute(run())).resolves.toBe("needs_reconciliation");
    expect(harness.states.get("Start")).toMatchObject({
      status: "needs_reconciliation",
      errorEvidenceRef: "routine:input_not_evaluable",
    });
    expect(harness.transitions).not.toContain("Start:running->succeeded");
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
    const execute = toolExecutor(
      definition([commentState]),
      harness,
      { kind: "succeeded", output: null },
      calls
    );

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

describe("createRoutineExecutor — agent States", () => {
  const bundle = { digest: "bundle-digest" } as unknown as LoadedRoutineDefinition["bundle"];

  function agentExecutor(
    document: routine.RoutineDefinition,
    harness: StateHarness,
    outcome: RoutineAgentOutcome,
    calls: RoutineAgentRequest[] = []
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
      agents: {
        execute: async (request) => {
          calls.push(request);
          return outcome;
        },
      },
      now: () => new Date(STARTED_AT),
    });
  }

  const classifyState: routine.RoutineState = {
    type: "agent",
    name: "Start",
    agentRef: { name: "triage", version: "1" },
    input: { region: INPUT_REGION_EXPRESSION },
    output: {
      type: "object",
      required: ["category"],
      properties: { category: { type: "string" } },
    },
    end: true,
  } as routine.RoutineState;

  it("asks the Agent the question the Context resolved and settles the State", async () => {
    const harness = new StateHarness([state("Start")]);
    const calls: RoutineAgentRequest[] = [];
    const execute = agentExecutor(
      definition([classifyState]),
      harness,
      { kind: "succeeded", output: { category: "billing" } },
      calls
    );

    await expect(execute(run())).resolves.toBe("succeeded");
    expect(harness.transitions).toEqual([
      "Start:pending->ready",
      "Start:ready->claimed",
      "Start:claimed->running",
      "Start:running->succeeded",
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.plan.agentRef).toEqual({ name: "triage", version: "1" });
    expect(calls[0]?.plan.input).toEqual({ region: "west" });
    // The declared output schema travels with the question, so the answer is validated in the loop.
    expect(calls[0]?.outputSchema).toEqual({
      type: "object",
      required: ["category"],
      properties: { category: { type: "string" } },
    });
    expect(calls[0]?.bundle.digest).toBe("bundle-digest");
  });

  it("publishes the Agent's answer so a later State can read it", async () => {
    const harness = new StateHarness([state("Start")]);
    const execute = agentExecutor(
      definition([
        {
          type: "agent",
          name: "Start",
          agentRef: { name: "triage", version: "1" },
          transition: "Record",
        } as routine.RoutineState,
        {
          type: "compute",
          name: "Record",
          input: { chosen: "${states.Start.output.category}" },
          end: true,
        } as routine.RoutineState,
      ]),
      harness,
      { kind: "succeeded", output: { category: "billing" } },
      []
    );

    await expect(execute(run())).resolves.toBe("succeeded");
    // Before State outputs were durable this resolved to null and the successor never saw a value.
    expect(harness.states.get("Record")?.resolvedInput).toEqual({ chosen: "billing" });
    expect(harness.states.get("Start")?.output).toEqual({ category: "billing" });
  });

  it("republishes a settled Agent's stored answer on replay rather than re-asking", async () => {
    // The Agent settled on an earlier pass; the States after it had not run yet. Their Context can
    // only come from the answer that pass stored, because the model is never asked twice.
    const harness = new StateHarness([
      { ...state("Start", "succeeded"), output: { category: "billing" } },
      state("Record"),
    ]);
    const execute = createRoutineExecutor({
      definitions: {
        load: async () =>
          ({
            document: definition([
              {
                type: "agent",
                name: "Start",
                agentRef: { name: "triage", version: "1" },
                transition: "Record",
              } as routine.RoutineState,
              {
                type: "compute",
                name: "Record",
                input: { chosen: "${states.Start.output.category}" },
                transition: "Final",
              } as routine.RoutineState,
              {
                type: "compute",
                name: "Final",
                input: { echo: "${states.Record.output.chosen}" },
                end: true,
              } as routine.RoutineState,
            ]),
            bundle,
          }) as LoadedRoutineDefinition,
      },
      artifacts: { read: async () => requestArtifact },
      runs: { listStates: async () => [...harness.states.values()] },
      scheduler: harness.scheduler,
      transitions: harness,
      waits: harness.waitPort,
      agents: {
        execute: async () => {
          throw new Error("a settled Agent State must never be re-asked on replay");
        },
      },
      now: () => new Date(STARTED_AT),
    });

    await expect(execute(run())).resolves.toBe("succeeded");
    // Before State outputs were durable the replayed Agent republished null and this resolved to
    // nothing, so the whole tail of the Routine ran on empty Context.
    expect(harness.states.get("Final")?.resolvedInput).toEqual({ echo: "billing" });
  });

  it("parks an Agent State when no Agent authority is composed", async () => {
    const harness = new StateHarness([state("Start")]);
    const execute = createRoutineExecutor({
      definitions: {
        load: async () =>
          ({ document: definition([classifyState]), bundle }) as LoadedRoutineDefinition,
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

  it("parks an answer nothing here could obtain, naming what stopped it", async () => {
    const harness = new StateHarness([state("Start")]);
    const execute = agentExecutor(definition([classifyState]), harness, {
      kind: "unavailable",
      reason: "agent_not_in_bundle",
    });

    await expect(execute(run())).resolves.toBe("needs_reconciliation");
    expect(harness.states.get("Start")?.errorEvidenceRef).toBe("routine:agent_not_in_bundle");
  });

  it("parks a Tool call the loop sent to a human, since no Approval exists here", async () => {
    const harness = new StateHarness([state("Start")]);
    const execute = agentExecutor(definition([classifyState]), harness, {
      kind: "awaiting_approval",
      reason: "approval_required",
    });

    await expect(execute(run())).resolves.toBe("needs_reconciliation");
    expect(harness.states.get("Start")?.errorEvidenceRef).toBe("routine:approval_required");
  });

  it("leaves a cancelled Run's status to the cancellation manager", async () => {
    const harness = new StateHarness([state("Start")]);
    const execute = agentExecutor(definition([classifyState]), harness, { kind: "cancelled" });

    await expect(execute(run())).resolves.toBe("cancelled");
    expect(harness.transitions).not.toContain("Start:running->failed");
  });

  it("lets an authored handler claim a guardrail refusal", async () => {
    const harness = new StateHarness([state("Start")]);
    const execute = agentExecutor(
      definition([
        {
          ...classifyState,
          end: undefined,
          onError: [{ errorRef: "agent_guardrail_output_blocked", transition: "Fallback" }],
        } as routine.RoutineState,
        {
          type: "branch",
          name: "Fallback",
          conditions: [{ condition: "input.score > 0", end: true }],
          default: { end: true },
        },
      ]),
      harness,
      { kind: "failed", reason: "guardrail_output_blocked", retryable: false }
    );

    await expect(execute(run())).resolves.toBe("succeeded");
    expect(harness.events).toContain("Fallback:scheduled");
  });

  it("fails an Agent State whose failure no handler claims", async () => {
    const harness = new StateHarness([state("Start")]);
    const execute = agentExecutor(definition([classifyState]), harness, {
      kind: "failed",
      reason: "model_error",
      retryable: true,
    });

    await expect(execute(run())).resolves.toBe("failed");
    expect(harness.transitions).toContain("Start:running->failed");
  });
});

describe("createRoutineExecutor — approval States", () => {
  /** The decision surface, as this process sees it: one approval per State occurrence. */
  class ApprovalHarness {
    readonly opened: { stateKey: string; stateName: string; wait: RegisterWaitInput }[] = [];
    private readonly records = new Map<string, RoutineApprovalRecord>();

    readonly port: RoutineApprovalPort = {
      open: async (input) => {
        const existing = this.records.get(input.stateKey);
        if (existing !== undefined) return existing;
        this.opened.push({
          stateKey: input.stateKey,
          stateName: input.stateName,
          wait: input.wait,
        });
        const record: RoutineApprovalRecord = {
          approvalId: input.wait.id,
          waitId: input.wait.id,
          decision: "pending",
        };
        this.records.set(input.stateKey, record);
        return record;
      },
      find: async (input) => this.records.get(input.stateKey),
    };

    /** Stands in for a human deciding, or for the deadline passing with nobody deciding. */
    decide(stateKey: string, decision: RoutineApprovalDecision): void {
      const record = this.records.get(stateKey);
      if (record === undefined) throw new Error(`no approval for ${stateKey}`);
      this.records.set(stateKey, { ...record, decision });
    }
  }

  function approvalExecutor(
    document: routine.RoutineDefinition,
    harness: StateHarness,
    approvals?: RoutineApprovalPort
  ) {
    return createRoutineExecutor({
      definitions: { load: async () => ({ document }) as LoadedRoutineDefinition },
      artifacts: { read: async () => requestArtifact },
      runs: { listStates: async () => [...harness.states.values()] },
      scheduler: harness.scheduler,
      transitions: harness,
      waits: harness.waitPort,
      approvals,
      now: () => new Date(STARTED_AT),
    });
  }

  function approvalDefinition(
    overrides: Record<string, unknown> = {},
    rest: readonly routine.RoutineState[] = []
  ): routine.RoutineDefinition {
    return definition([
      {
        type: "approval",
        name: "Start",
        approverRoles: ["finance"],
        deadlineMs: 60_000,
        end: true,
        ...overrides,
      } as routine.RoutineState,
      ...rest,
    ]);
  }

  const deniedState: routine.RoutineState = {
    type: "branch",
    name: "Denied",
    conditions: [{ condition: "true", end: true }],
    default: { end: true },
  };

  it("opens the approval on the authored roles and parks the Run on it", async () => {
    const harness = new StateHarness([state("Start")]);
    const approvals = new ApprovalHarness();

    await expect(
      approvalExecutor(approvalDefinition(), harness, approvals.port)(run())
    ).resolves.toBe("waiting");
    expect(harness.transitions).toEqual([
      "Start:pending->ready",
      "Start:ready->claimed",
      "Start:claimed->running",
      "Start:running->waiting",
    ]);
    expect(approvals.opened).toHaveLength(1);
    expect(approvals.opened[0]).toMatchObject({ stateKey: "Start", stateName: "Start" });
    expect(approvals.opened[0]?.wait).toMatchObject({
      id: routineWaitId(run().id, "Start"),
      kind: "approval",
      stateKey: "Start",
      allowedPrincipals: ["role:finance"],
      deadlineAt: "2026-08-02T00:01:00.000Z",
    });
  });

  it("replays into the approval it already opened rather than asking a second human", async () => {
    const harness = new StateHarness([state("Start")]);
    const approvals = new ApprovalHarness();
    const execute = approvalExecutor(approvalDefinition(), harness, approvals.port);

    await expect(execute(run())).resolves.toBe("waiting");
    await expect(execute(run())).resolves.toBe("waiting");
    expect(approvals.opened).toHaveLength(1);
  });

  it("continues through the authored transition once approved", async () => {
    const harness = new StateHarness([state("Start")]);
    const approvals = new ApprovalHarness();
    const execute = approvalExecutor(approvalDefinition(), harness, approvals.port);

    await expect(execute(run())).resolves.toBe("waiting");
    approvals.decide("Start", "approved");
    await expect(execute(run())).resolves.toBe("succeeded");
    expect(harness.transitions.slice(4)).toEqual([
      "Start:waiting->ready",
      "Start:ready->claimed",
      "Start:claimed->running",
      "Start:running->succeeded",
    ]);
  });

  it("fails a denied approval no handler claims", async () => {
    const harness = new StateHarness([state("Start")]);
    const approvals = new ApprovalHarness();
    const execute = approvalExecutor(approvalDefinition(), harness, approvals.port);

    await expect(execute(run())).resolves.toBe("waiting");
    approvals.decide("Start", "denied");
    await expect(execute(run())).resolves.toBe("failed");
    expect(harness.states.get("Start")?.errorEvidenceRef).toBe("routine:approval_rejected");
  });

  it("lets an authored handler claim a rejection", async () => {
    const harness = new StateHarness([state("Start")]);
    const approvals = new ApprovalHarness();
    const execute = approvalExecutor(
      approvalDefinition(
        {
          end: undefined,
          onError: [{ errorRef: "approval_rejected", transition: "Denied" }],
        },
        [deniedState]
      ),
      harness,
      approvals.port
    );

    await expect(execute(run())).resolves.toBe("waiting");
    approvals.decide("Start", "denied");
    await expect(execute(run())).resolves.toBe("succeeded");
    expect(harness.events).toContain("Denied:scheduled");
  });

  it("parks an expired approval rather than reading it as either decision", async () => {
    const harness = new StateHarness([state("Start")]);
    const approvals = new ApprovalHarness();
    const execute = approvalExecutor(approvalDefinition(), harness, approvals.port);

    await expect(execute(run())).resolves.toBe("waiting");
    approvals.decide("Start", "expired");
    await expect(execute(run())).resolves.toBe("needs_reconciliation");
    expect(harness.states.get("Start")?.errorEvidenceRef).toBe("routine:wait_expired");
  });

  it("parks an approval State when no decision surface is composed", async () => {
    const harness = new StateHarness([state("Start")]);

    await expect(approvalExecutor(approvalDefinition(), harness)(run())).resolves.toBe(
      "needs_reconciliation"
    );
    expect(harness.states.get("Start")?.errorEvidenceRef).toBe("routine:unsupported_state");
  });
});

describe("createRoutineExecutor — retry policy", () => {
  const bundle = { digest: "bundle-digest" } as unknown as LoadedRoutineDefinition["bundle"];

  function retryingAgentState(maxAttempts: number, backoffMs?: number): routine.RoutineState {
    return {
      type: "agent",
      name: "Start",
      agentRef: { name: "triage", version: "1" },
      retry: { maxAttempts, ...(backoffMs === undefined ? {} : { backoffMs }) },
      end: true,
    } as routine.RoutineState;
  }

  function retryExecutor(input: {
    document: routine.RoutineDefinition;
    harness: StateHarness;
    agent: RoutineAgentPort;
    retries: InMemoryStateRetryStore;
    delay?: (ms: number) => Promise<void>;
  }) {
    return createRoutineExecutor({
      definitions: {
        load: async () => ({ document: input.document, bundle }) as LoadedRoutineDefinition,
      },
      artifacts: { read: async () => requestArtifact },
      runs: { listStates: async () => [...input.harness.states.values()] },
      scheduler: input.harness.scheduler,
      transitions: input.harness,
      waits: input.harness.waitPort,
      agents: input.agent,
      retries: input.retries,
      delay: input.delay ?? (async () => {}),
      now: () => new Date(STARTED_AT),
    });
  }

  it("re-attempts a transient Agent failure and succeeds on a later attempt", async () => {
    const harness = new StateHarness([state("Start")]);
    const retries = new InMemoryStateRetryStore();
    let calls = 0;
    const agent: RoutineAgentPort = {
      execute: async () => {
        calls += 1;
        return calls < 2
          ? { kind: "failed", reason: "model_provider_unavailable", retryable: true }
          : { kind: "succeeded", output: null };
      },
    };

    const execute = retryExecutor({
      document: definition([retryingAgentState(3)]),
      harness,
      agent,
      retries,
    });

    await expect(execute(run())).resolves.toBe("succeeded");
    expect(calls).toBe(2);
    expect((await retries.load("business-1", run().id, "Start"))?.attempts).toBe(2);
    expect(harness.transitions).toContain("Start:running->succeeded");
  });

  it("exhausts maxAttempts on a persistent transient failure and terminates", async () => {
    const harness = new StateHarness([state("Start")]);
    const retries = new InMemoryStateRetryStore();
    let calls = 0;
    const agent: RoutineAgentPort = {
      execute: async () => {
        calls += 1;
        return { kind: "failed", reason: "model_rate_limited", retryable: true };
      },
    };

    const execute = retryExecutor({
      document: definition([retryingAgentState(2)]),
      harness,
      agent,
      retries,
    });

    await expect(execute(run())).resolves.toBe("failed");
    expect(calls).toBe(2);
    expect((await retries.load("business-1", run().id, "Start"))?.attempts).toBe(2);
    expect(harness.transitions).toContain("Start:running->failed");
  });

  it("does not retry a terminal failure even under a retry policy", async () => {
    const harness = new StateHarness([state("Start")]);
    const retries = new InMemoryStateRetryStore();
    let calls = 0;
    const agent: RoutineAgentPort = {
      execute: async () => {
        calls += 1;
        return { kind: "failed", reason: "guardrail_output_blocked", retryable: false };
      },
    };

    const execute = retryExecutor({
      document: definition([retryingAgentState(5)]),
      harness,
      agent,
      retries,
    });

    await expect(execute(run())).resolves.toBe("failed");
    expect(calls).toBe(1);
    expect(harness.transitions).toContain("Start:running->failed");
  });

  it("waits the authored backoff between attempts", async () => {
    const harness = new StateHarness([state("Start")]);
    const retries = new InMemoryStateRetryStore();
    const delays: number[] = [];
    let calls = 0;
    const agent: RoutineAgentPort = {
      execute: async () => {
        calls += 1;
        return calls < 3
          ? { kind: "failed", reason: "model_error", retryable: true }
          : { kind: "succeeded", output: null };
      },
    };

    const execute = retryExecutor({
      document: definition([retryingAgentState(3, 100)]),
      harness,
      agent,
      retries,
      delay: async (ms) => {
        delays.push(ms);
      },
    });

    await expect(execute(run())).resolves.toBe("succeeded");
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 100]);
  });

  it("does not refund the attempt budget across a crash and resume", async () => {
    const harness = new StateHarness([state("Start")]);
    const retries = new InMemoryStateRetryStore();
    let calls = 0;
    let resumed = false;
    const agent: RoutineAgentPort = {
      execute: async () => {
        calls += 1;
        // Crash on the second physical attempt of the first invocation, after its count is durable.
        if (calls === 2 && !resumed) throw new Error("injected crash");
        return { kind: "failed", reason: "model_error", retryable: true };
      },
    };

    const execute = retryExecutor({
      document: definition([retryingAgentState(5)]),
      harness,
      agent,
      retries,
    });

    await expect(execute(run())).rejects.toThrow("injected crash");
    expect((await retries.load("business-1", run().id, "Start"))?.attempts).toBe(2);

    resumed = true;
    // The resumed State must continue from the 2 attempts already spent, not restart at zero:
    // 3 more physical attempts (3rd, 4th, 5th) reach the ceiling — a refund would take 5 more.
    await expect(execute(run())).resolves.toBe("failed");
    expect(calls).toBe(5);
    expect((await retries.load("business-1", run().id, "Start"))?.attempts).toBe(5);
    expect(harness.transitions).toContain("Start:running->failed");
  });
});

describe("createRoutineExecutor — concurrencyKey", () => {
  const bundle = { digest: "bundle-digest" } as unknown as LoadedRoutineDefinition["bundle"];
  const OTHER_RUN = "00000000-0000-4000-8000-0000000000ff";

  function keyedAgentState(concurrencyKey?: string): routine.RoutineState {
    return {
      type: "agent",
      name: "Start",
      agentRef: { name: "triage", version: "1" },
      ...(concurrencyKey === undefined ? {} : { concurrencyKey }),
      end: true,
    } as routine.RoutineState;
  }

  function keyedExecutor(input: {
    harness: StateHarness;
    agent: RoutineAgentPort;
    concurrency: InMemoryStateConcurrencyStore;
    contention?: InMemoryStateContentionStore;
    concurrencyKey?: string;
    delay?: (ms: number) => Promise<void>;
  }) {
    return createRoutineExecutor({
      definitions: {
        load: async () =>
          ({
            document: definition([keyedAgentState(input.concurrencyKey)]),
            bundle,
          }) as LoadedRoutineDefinition,
      },
      artifacts: { read: async () => requestArtifact },
      runs: { listStates: async () => [...input.harness.states.values()] },
      scheduler: input.harness.scheduler,
      transitions: input.harness,
      waits: input.harness.waitPort,
      agents: input.agent,
      concurrency: input.concurrency,
      ...(input.contention === undefined ? {} : { contention: input.contention }),
      delay: input.delay ?? (async () => {}),
      now: () => new Date(STARTED_AT),
    });
  }

  const succeedingAgent: RoutineAgentPort = {
    execute: async () => ({ kind: "succeeded", output: null }),
  };

  it("holds the key while the State runs and frees it when the State settles", async () => {
    const harness = new StateHarness([state("Start")]);
    const concurrency = new InMemoryStateConcurrencyStore();
    let heldDuringExecution: string | undefined;
    const agent: RoutineAgentPort = {
      execute: async () => {
        const contender = await concurrency.acquire({
          businessId: "business-1",
          concurrencyKey: "digest",
          runId: OTHER_RUN,
          stateKey: "Start",
          now: STARTED_AT,
          expiresAt: "2026-08-02T01:00:00.000Z",
        });
        heldDuringExecution = contender.kind;
        return { kind: "succeeded", output: null };
      },
    };

    const execute = keyedExecutor({ harness, agent, concurrency, concurrencyKey: "digest" });
    await expect(execute(run())).resolves.toBe("succeeded");

    expect(heldDuringExecution).toBe("busy");
    // Released on settle, so the next Run to want the key gets it immediately.
    await expect(
      concurrency.acquire({
        businessId: "business-1",
        concurrencyKey: "digest",
        runId: OTHER_RUN,
        stateKey: "Start",
        now: STARTED_AT,
        expiresAt: "2026-08-02T01:00:00.000Z",
      })
    ).resolves.toEqual({ kind: "acquired" });
  });

  it("frees the key when the State fails, not only when it succeeds", async () => {
    const harness = new StateHarness([state("Start")]);
    const concurrency = new InMemoryStateConcurrencyStore();
    const agent: RoutineAgentPort = {
      execute: async () => ({ kind: "failed", reason: "model_error", retryable: false }),
    };

    const execute = keyedExecutor({ harness, agent, concurrency, concurrencyKey: "digest" });
    await expect(execute(run())).resolves.toBe("failed");
    await expect(
      concurrency.acquire({
        businessId: "business-1",
        concurrencyKey: "digest",
        runId: OTHER_RUN,
        stateKey: "Start",
        now: STARTED_AT,
        expiresAt: "2026-08-02T01:00:00.000Z",
      })
    ).resolves.toEqual({ kind: "acquired" });
  });

  it("queues on a durable backoff rather than running unserialized when the key is held", async () => {
    const harness = new StateHarness([state("Start")]);
    const concurrency = new InMemoryStateConcurrencyStore();
    await concurrency.acquire({
      businessId: "business-1",
      concurrencyKey: "digest",
      runId: OTHER_RUN,
      stateKey: "Start",
      now: STARTED_AT,
      expiresAt: "2026-08-02T01:00:00.000Z",
    });
    let calls = 0;
    const agent: RoutineAgentPort = {
      execute: async () => {
        calls += 1;
        return { kind: "succeeded", output: null };
      },
    };

    const execute = keyedExecutor({
      harness,
      agent,
      concurrency,
      concurrencyKey: "digest",
      delay: async () => {},
    });
    await expect(execute(run())).resolves.toBe("waiting");
    expect(calls).toBe(0);
    expect(harness.transitions).toContain("Start:running->waiting");
    expect(harness.transitions).not.toContain("Start:running->needs_reconciliation");
    // The wait is a backoff timer, addressed apart from the State's own wait id.
    expect(harness.waits.has(routineConcurrencyWaitId(run().id, "Start", 1))).toBe(true);
    expect(harness.waits.has(routineWaitId(run().id, "Start"))).toBe(false);
  });

  it("parks once the durable backoff budget is exhausted, never running unserialized", async () => {
    const harness = new StateHarness([state("Start")]);
    const concurrency = new InMemoryStateConcurrencyStore();
    const contention = new InMemoryStateContentionStore();
    await concurrency.acquire({
      businessId: "business-1",
      concurrencyKey: "digest",
      runId: OTHER_RUN,
      stateKey: "Start",
      now: STARTED_AT,
      expiresAt: "2026-08-02T01:00:00.000Z",
    });
    let calls = 0;
    const agent: RoutineAgentPort = {
      execute: async () => {
        calls += 1;
        return { kind: "succeeded", output: null };
      },
    };
    const execute = keyedExecutor({
      harness,
      agent,
      concurrency,
      contention,
      concurrencyKey: "digest",
      delay: async () => {},
    });

    // Each pass opens one backoff, fires it, and comes back into execution to try the key again.
    for (let pass = 1; pass <= STATE_CONCURRENCY_MAX_WAITS; pass += 1) {
      await expect(execute(run())).resolves.toBe("waiting");
      harness.resolveConcurrencyWait("Start", pass);
    }
    await expect(execute(run())).resolves.toBe("needs_reconciliation");

    expect(calls).toBe(0);
    expect(harness.transitions).toContain("Start:running->needs_reconciliation");
    expect(harness.states.get("Start")?.errorEvidenceRef).toBe("routine:concurrency_key_busy");
    // The budget is durable, so a further pass does not refund itself another queue.
    await expect(contention.load("business-1", run().id, "Start")).resolves.toMatchObject({
      waits: STATE_CONCURRENCY_MAX_WAITS,
    });
  });

  it("resumes a fired backoff into execution, not past it", async () => {
    const harness = new StateHarness([state("Start")]);
    const concurrency = new InMemoryStateConcurrencyStore();
    const contention = new InMemoryStateContentionStore();
    await concurrency.acquire({
      businessId: "business-1",
      concurrencyKey: "digest",
      runId: OTHER_RUN,
      stateKey: "Start",
      now: STARTED_AT,
      expiresAt: "2026-08-02T01:00:00.000Z",
    });
    let calls = 0;
    const agent: RoutineAgentPort = {
      execute: async () => {
        calls += 1;
        return { kind: "succeeded", output: null };
      },
    };
    const execute = keyedExecutor({
      harness,
      agent,
      concurrency,
      contention,
      concurrencyKey: "digest",
      delay: async () => {},
    });

    await expect(execute(run())).resolves.toBe("waiting");
    expect(calls).toBe(0);

    // Holder releases, sweep fires the timer, contender is requeued.
    await concurrency.release("business-1", "digest", OTHER_RUN, "Start");
    harness.resolveConcurrencyWait("Start", 1);

    await expect(execute(run())).resolves.toBe("succeeded");
    // Resuming *into* the State: its effect ran exactly once, it was not skipped as satisfied.
    expect(calls).toBe(1);
    expect(harness.transitions).toContain("Start:waiting->ready");
  });

  it("re-parks on an unfired backoff without spending a second one", async () => {
    const harness = new StateHarness([state("Start")]);
    const concurrency = new InMemoryStateConcurrencyStore();
    const contention = new InMemoryStateContentionStore();
    await concurrency.acquire({
      businessId: "business-1",
      concurrencyKey: "digest",
      runId: OTHER_RUN,
      stateKey: "Start",
      now: STARTED_AT,
      expiresAt: "2026-08-02T01:00:00.000Z",
    });
    const execute = keyedExecutor({
      harness,
      agent: succeedingAgent,
      concurrency,
      contention,
      concurrencyKey: "digest",
      delay: async () => {},
    });

    await expect(execute(run())).resolves.toBe("waiting");
    // Crash-and-reclaim before the sweep fires: the State is back at `running`, its wait pending.
    harness.states.set("Start", { ...state("Start", "running"), version: 9 });
    await expect(execute(run())).resolves.toBe("waiting");

    await expect(contention.load("business-1", run().id, "Start")).resolves.toMatchObject({
      waits: 1,
    });
    expect(harness.waits.has(routineConcurrencyWaitId(run().id, "Start", 2))).toBe(false);
  });

  it("takes a key whose holder crashed and left an expired lease", async () => {
    const harness = new StateHarness([state("Start")]);
    const concurrency = new InMemoryStateConcurrencyStore();
    await concurrency.acquire({
      businessId: "business-1",
      concurrencyKey: "digest",
      runId: OTHER_RUN,
      stateKey: "Start",
      now: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-08-01T00:01:00.000Z",
    });

    const execute = keyedExecutor({
      harness,
      agent: succeedingAgent,
      concurrency,
      concurrencyKey: "digest",
    });
    await expect(execute(run())).resolves.toBe("succeeded");
  });

  it("never touches the store for a State that authored no key", async () => {
    const harness = new StateHarness([state("Start")]);
    const concurrency = new InMemoryStateConcurrencyStore();
    const execute = keyedExecutor({ harness, agent: succeedingAgent, concurrency });

    await expect(execute(run())).resolves.toBe("succeeded");
    await expect(
      concurrency.acquire({
        businessId: "business-1",
        concurrencyKey: "digest",
        runId: OTHER_RUN,
        stateKey: "Start",
        now: STARTED_AT,
        expiresAt: "2026-08-02T01:00:00.000Z",
      })
    ).resolves.toEqual({ kind: "acquired" });
  });
});

describe("createRoutineExecutor — child_routine States", () => {
  /** The child surface, as this process sees it: one child Run per State occurrence. */
  class ChildRoutineHarness {
    readonly started: StartChildRoutineInput[] = [];
    private readonly records = new Map<string, ChildRoutineRecord>();

    constructor(private readonly settleImmediately: ChildRoutineStatus = "pending") {}

    readonly port: ChildRoutinePort = {
      start: async (input) => {
        const existing = this.records.get(input.stateKey);
        if (existing !== undefined) return existing;
        this.started.push(input);
        const record: ChildRoutineRecord = {
          childRunId: `child-${this.started.length}`,
          status: this.settleImmediately,
          waitId: input.mode === "detach" ? null : routineWaitId(run().id, input.stateKey),
        };
        this.records.set(input.stateKey, record);
        return record;
      },
      find: async (input) => this.records.get(input.stateKey),
    };

    /** Stands in for the child reaching a terminal status, or for the caller's wait expiring. */
    settle(stateKey: string, status: ChildRoutineStatus): void {
      const record = this.records.get(stateKey);
      if (record === undefined) throw new Error(`no child for ${stateKey}`);
      this.records.set(stateKey, { ...record, status, waitId: null });
    }
  }

  function childExecutor(
    document: routine.RoutineDefinition,
    harness: StateHarness,
    childRoutines?: ChildRoutinePort
  ) {
    return createRoutineExecutor({
      definitions: { load: async () => ({ document }) as LoadedRoutineDefinition },
      artifacts: { read: async () => requestArtifact },
      runs: { listStates: async () => [...harness.states.values()] },
      scheduler: harness.scheduler,
      transitions: harness,
      waits: harness.waitPort,
      childRoutines,
      now: () => new Date(STARTED_AT),
    });
  }

  function childDefinition(
    overrides: Record<string, unknown> = {},
    rest: readonly routine.RoutineState[] = []
  ): routine.RoutineDefinition {
    return definition([
      {
        type: "child_routine",
        name: "Start",
        routineRef: { name: "reindex-knowledge", version: "3" },
        mode: "wait",
        deadlineMs: 60_000,
        end: true,
        ...overrides,
      } as routine.RoutineState,
      ...rest,
    ]);
  }

  const recoveredState: routine.RoutineState = {
    type: "branch",
    name: "Recovered",
    conditions: [{ condition: "true", end: true }],
    default: { end: true },
  };

  it("calls the authored Routine and parks the caller on the child it started", async () => {
    const harness = new StateHarness([state("Start")]);
    const children = new ChildRoutineHarness();

    await expect(childExecutor(childDefinition(), harness, children.port)(run())).resolves.toBe(
      "waiting"
    );
    expect(harness.transitions).toEqual([
      "Start:pending->ready",
      "Start:ready->claimed",
      "Start:claimed->running",
      "Start:running->waiting",
    ]);
    expect(children.started).toHaveLength(1);
    expect(children.started[0]).toMatchObject({
      stateKey: "Start",
      stateName: "Start",
      routineRef: { name: "reindex-knowledge", version: "3" },
      mode: "wait",
      deadlineMs: 60_000,
    });
  });

  it("resolves the authored input mapping into the child's request", async () => {
    const harness = new StateHarness([state("Start")]);
    const children = new ChildRoutineHarness();

    await expect(
      childExecutor(
        childDefinition({ input: { region: INPUT_REGION_EXPRESSION } }),
        harness,
        children.port
      )(run())
    ).resolves.toBe("waiting");
    expect(children.started[0]?.input).toEqual({ region: "west" });
  });

  it("replays into the child it already started rather than running the callee twice", async () => {
    const harness = new StateHarness([state("Start")]);
    const children = new ChildRoutineHarness();
    const execute = childExecutor(childDefinition(), harness, children.port);

    await expect(execute(run())).resolves.toBe("waiting");
    await expect(execute(run())).resolves.toBe("waiting");
    expect(children.started).toHaveLength(1);
  });

  it("continues through the authored transition once the child succeeds", async () => {
    const harness = new StateHarness([state("Start")]);
    const children = new ChildRoutineHarness();
    const execute = childExecutor(childDefinition(), harness, children.port);

    await expect(execute(run())).resolves.toBe("waiting");
    children.settle("Start", "succeeded");
    await expect(execute(run())).resolves.toBe("succeeded");
    expect(harness.transitions.slice(4)).toEqual([
      "Start:waiting->ready",
      "Start:ready->claimed",
      "Start:claimed->running",
      "Start:running->succeeded",
    ]);
  });

  it("fails a failed child no handler claims", async () => {
    const harness = new StateHarness([state("Start")]);
    const children = new ChildRoutineHarness();
    const execute = childExecutor(childDefinition(), harness, children.port);

    await expect(execute(run())).resolves.toBe("waiting");
    children.settle("Start", "failed");
    await expect(execute(run())).resolves.toBe("failed");
    expect(harness.states.get("Start")?.errorEvidenceRef).toBe("routine:child_failed");
  });

  it("lets an authored handler claim a failed child", async () => {
    const harness = new StateHarness([state("Start")]);
    const children = new ChildRoutineHarness();
    const execute = childExecutor(
      childDefinition(
        { end: undefined, onError: [{ errorRef: "child_failed", transition: "Recovered" }] },
        [recoveredState]
      ),
      harness,
      children.port
    );

    await expect(execute(run())).resolves.toBe("waiting");
    children.settle("Start", "failed");
    await expect(execute(run())).resolves.toBe("succeeded");
    expect(harness.events).toContain("Recovered:scheduled");
  });

  it("parks a cancelled child rather than reading it as a failure", async () => {
    const harness = new StateHarness([state("Start")]);
    const children = new ChildRoutineHarness();
    const execute = childExecutor(childDefinition(), harness, children.port);

    await expect(execute(run())).resolves.toBe("waiting");
    children.settle("Start", "cancelled");
    await expect(execute(run())).resolves.toBe("needs_reconciliation");
    expect(harness.states.get("Start")?.errorEvidenceRef).toBe("routine:child_cancelled");
  });

  it("parks a caller whose child outlived the authored deadline", async () => {
    const harness = new StateHarness([state("Start")]);
    const children = new ChildRoutineHarness();
    const execute = childExecutor(childDefinition(), harness, children.port);

    await expect(execute(run())).resolves.toBe("waiting");
    children.settle("Start", "expired");
    await expect(execute(run())).resolves.toBe("needs_reconciliation");
    expect(harness.states.get("Start")?.errorEvidenceRef).toBe("routine:wait_expired");
  });

  it("continues immediately in detach mode, carrying no deadline of the caller's", async () => {
    const harness = new StateHarness([state("Start")]);
    const children = new ChildRoutineHarness();

    await expect(
      childExecutor(
        childDefinition({ mode: "detach", deadlineMs: undefined }),
        harness,
        children.port
      )(run())
    ).resolves.toBe("succeeded");
    expect(children.started[0]).toMatchObject({ mode: "detach" });
    expect(children.started[0]?.deadlineMs).toBeUndefined();
    expect(harness.transitions).toEqual([
      "Start:pending->ready",
      "Start:ready->claimed",
      "Start:claimed->running",
      "Start:running->succeeded",
    ]);
  });

  it("answers a child that settled before the caller could be parked on it", async () => {
    const harness = new StateHarness([state("Start")]);
    const children = new ChildRoutineHarness("succeeded");

    await expect(childExecutor(childDefinition(), harness, children.port)(run())).resolves.toBe(
      "succeeded"
    );
    expect(harness.transitions).toEqual([
      "Start:pending->ready",
      "Start:ready->claimed",
      "Start:claimed->running",
      "Start:running->succeeded",
    ]);
  });

  it("refuses a `wait` child that names no deadline, rather than parking forever", async () => {
    const harness = new StateHarness([state("Start")]);
    const children = new ChildRoutineHarness();

    await expect(
      childExecutor(childDefinition({ deadlineMs: undefined }), harness, children.port)(run())
    ).resolves.toBe("needs_reconciliation");
    expect(children.started).toHaveLength(0);
  });

  it("parks a child_routine State when no child surface is composed", async () => {
    const harness = new StateHarness([state("Start")]);

    await expect(childExecutor(childDefinition(), harness)(run())).resolves.toBe(
      "needs_reconciliation"
    );
    expect(harness.states.get("Start")?.errorEvidenceRef).toBe("routine:unsupported_state");
  });
});

describe("createRoutineExecutor — emit States", () => {
  class EmitHarness {
    readonly announced: EmitEventInput[] = [];

    constructor(private readonly outcome: EmitRecord["outcome"] = "started") {}

    readonly port: EmitPort = {
      emit: async (input) => {
        this.announced.push(input);
        return {
          eventId: `emit:${input.runId}:${input.stateKey}`,
          outcome: this.outcome,
          ...(this.outcome === "started" ? { runId: "run-started" } : {}),
        };
      },
    };
  }

  function emitExecutor(
    document: routine.RoutineDefinition,
    harness: StateHarness,
    emissions?: EmitPort
  ) {
    return createRoutineExecutor({
      definitions: { load: async () => ({ document }) as LoadedRoutineDefinition },
      artifacts: { read: async () => requestArtifact },
      runs: { listStates: async () => [...harness.states.values()] },
      scheduler: harness.scheduler,
      transitions: harness,
      waits: harness.waitPort,
      emissions,
      now: () => new Date(STARTED_AT),
    });
  }

  function emitDefinition(overrides: Record<string, unknown> = {}): routine.RoutineDefinition {
    return definition([
      {
        type: "emit",
        name: "Start",
        event: { type: "ticket.triaged", version: 2 },
        input: { ticketId: "t-1" },
        end: true,
        ...overrides,
      } as routine.RoutineState,
    ]);
  }

  it("announces the authored event and succeeds without waiting", async () => {
    const harness = new StateHarness([state("Start")]);
    const emissions = new EmitHarness();

    await expect(emitExecutor(emitDefinition(), harness, emissions.port)(run())).resolves.toBe(
      "succeeded"
    );
    expect(harness.transitions).toEqual([
      "Start:pending->ready",
      "Start:ready->claimed",
      "Start:claimed->running",
      "Start:running->succeeded",
    ]);
    expect(emissions.announced).toEqual([
      {
        businessId: run().businessId,
        runId: run().id,
        stateKey: "Start",
        eventType: "ticket.triaged",
        eventVersion: 2,
        data: { ticketId: "t-1" },
      },
    ]);
  });

  it("resolves the payload against the Run's own input", async () => {
    const harness = new StateHarness([state("Start")]);
    const emissions = new EmitHarness();

    await expect(
      emitExecutor(
        emitDefinition({ input: { region: INPUT_REGION_EXPRESSION } }),
        harness,
        emissions.port
      )(run())
    ).resolves.toBe("succeeded");
    expect(emissions.announced[0]?.data).toEqual({ region: "west" });
  });

  it("succeeds even when no Trigger listened, because emit promises no listener", async () => {
    const harness = new StateHarness([state("Start")]);
    const emissions = new EmitHarness("no_match");

    await expect(emitExecutor(emitDefinition(), harness, emissions.port)(run())).resolves.toBe(
      "succeeded"
    );
  });

  it("parks an emit State when no emission surface is composed", async () => {
    const harness = new StateHarness([state("Start")]);

    await expect(emitExecutor(emitDefinition(), harness)(run())).resolves.toBe(
      "needs_reconciliation"
    );
    expect(harness.states.get("Start")?.errorEvidenceRef).toBe("routine:unsupported_state");
  });

  it("parks rather than announcing when the payload cannot be resolved", async () => {
    const harness = new StateHarness([state("Start")]);
    const emissions = new EmitHarness();

    await expect(
      emitExecutor(
        emitDefinition({ input: { label: "${input.absent}" } }),
        harness,
        emissions.port
      )(run())
    ).resolves.toBe("needs_reconciliation");
    expect(emissions.announced).toHaveLength(0);
  });
});

describe("createRoutineExecutor — deterministic States", () => {
  const bundle = { digest: "bundle-digest" } as unknown as LoadedRoutineDefinition["bundle"];

  /**
   * The Routine the product promise turns on: fetch, transform, write — with no model anywhere in
   * the chain. Before `script` and `action` existed, an `agent` State was the only way a Routine
   * could reach an API or create a Record, which is why a schedule that should have been a fixed
   * cost billed a model turn every tick and let the model improvise whether to append or overwrite.
   */
  const starsChain: readonly routine.RoutineState[] = [
    {
      type: "action",
      name: "Start",
      action: "api_request",
      input: { method: "GET", url: "https://api.github.com/repos/tulipfarm/tulipfarm" },
      transition: "Extract",
    } as routine.RoutineState,
    {
      type: "script",
      name: "Extract",
      script:
        "({ run(ctx, input) { return { stars: JSON.parse(input.body).stargazers_count }; } })",
      input: { body: "${states.Start.output.body}" },
      transition: "Save",
    } as routine.RoutineState,
    {
      type: "action",
      name: "Save",
      action: "record_create",
      input: { type: "repo_stats", data: { stars: "${states.Extract.output.stars}" } },
      end: true,
    } as routine.RoutineState,
  ];

  it("fetches, transforms and writes with no Agent in the chain", async () => {
    const harness = new StateHarness([state("Start")]);
    const dispatched: unknown[] = [];
    const execute = createRoutineExecutor({
      definitions: {
        load: async () =>
          ({ document: definition([...starsChain]), bundle }) as LoadedRoutineDefinition,
      },
      artifacts: { read: async () => requestArtifact },
      runs: { listStates: async () => [...harness.states.values()] },
      scheduler: harness.scheduler,
      transitions: harness,
      waits: harness.waitPort,
      actions: {
        execute: async (request) => {
          dispatched.push({ action: request.plan.action, args: request.plan.arguments });
          // `api_request` renders the body to text before returning it, so the script has to
          // parse it. Handing back a parsed object here would prove a capability the Tool
          // does not have, which is exactly how the broken example shipped once already.
          return request.plan.action === "api_request"
            ? {
                kind: "succeeded",
                output: { status: 200, format: "json", body: '{"stargazers_count":4321}' },
              }
            : { kind: "succeeded", output: { id: "rec_1" } };
        },
      },
      // The real isolate, not a fake: the point of a `script` State is that authored JavaScript
      // genuinely runs, so a test that stubs it would prove nothing about the capability.
      scripts: new SandboxRoutineScriptPort(),
      now: () => new Date(STARTED_AT),
    });

    await expect(execute(run())).resolves.toBe("succeeded");
    expect(harness.states.get("Extract")?.output).toEqual({ stars: 4321 });
    // A fresh Record each tick carrying the value the script derived — never an Agent's guess.
    expect(dispatched).toEqual([
      {
        action: "api_request",
        args: { method: "GET", url: "https://api.github.com/repos/tulipfarm/tulipfarm" },
      },
      { action: "record_create", args: { type: "repo_stats", data: { stars: 4321 } } },
    ]);
  });

  /**
   * `permissionCeiling` is an opt-in narrowing, so a Routine that declares none must reach every
   * Tool its owner may reach. Defaulting the ceiling to `low` made that impossible: it denied
   * every mutating Tool, and no author could lift it, because the compiler measures an authored
   * ceiling against the same default.
   */
  it("lets an action reach a mutating Tool when the author narrowed nothing", async () => {
    const harness = new StateHarness([state("Start")]);
    const ceilings: string[] = [];
    const execute = createRoutineExecutor({
      definitions: {
        load: async () =>
          ({ document: definition([...starsChain]), bundle }) as LoadedRoutineDefinition,
      },
      artifacts: { read: async () => requestArtifact },
      runs: { listStates: async () => [...harness.states.values()] },
      scheduler: harness.scheduler,
      transitions: harness,
      waits: harness.waitPort,
      actions: {
        execute: async (request) => {
          ceilings.push(request.plan.permissionCeiling.maxRiskClass);
          return request.plan.action === "api_request"
            ? {
                kind: "succeeded",
                output: { status: 200, format: "json", body: '{"stargazers_count":4321}' },
              }
            : { kind: "succeeded", output: { id: "rec_1" } };
        },
      },
      scripts: new SandboxRoutineScriptPort(),
      now: () => new Date(STARTED_AT),
    });

    await expect(execute(run())).resolves.toBe("succeeded");
    // `record_create` is `mutating`, so it compiles to `medium`; a `low` ceiling refuses it.
    expect(ceilings).toEqual(["high", "high"]);
  });

  /**
   * A refusing Tool answers with a reason code. Recording only the State's name would say which
   * step broke and nothing about what broke it, leaving a failed Run undiagnosable from its own
   * record — which is exactly what a live scheduled Routine did, failing every tick at
   * `record_create` with no stored trace of why.
   */
  it("records why an action failed, not just which State did", async () => {
    const harness = new StateHarness([state("Start")]);
    const execute = createRoutineExecutor({
      definitions: {
        load: async () =>
          ({ document: definition([...starsChain]), bundle }) as LoadedRoutineDefinition,
      },
      artifacts: { read: async () => requestArtifact },
      runs: { listStates: async () => [...harness.states.values()] },
      scheduler: harness.scheduler,
      transitions: harness,
      waits: harness.waitPort,
      actions: {
        execute: async (request) =>
          request.plan.action === "api_request"
            ? {
                kind: "succeeded",
                output: { status: 200, format: "json", body: '{"stargazers_count":4321}' },
              }
            : { kind: "failed", reason: "unknown_resource_type" },
      },
      scripts: new SandboxRoutineScriptPort(),
      now: () => new Date(STARTED_AT),
    });

    await expect(execute(run())).resolves.toBe("failed");
    expect(harness.states.get("Save")?.errorEvidenceRef).toBe(
      "routine:action_unknown_resource_type"
    );
  });

  it("refuses a script that reaches for the host instead of running it", async () => {
    const harness = new StateHarness([state("Start")]);
    const execute = createRoutineExecutor({
      definitions: {
        load: async () =>
          ({
            document: definition([
              {
                type: "script",
                name: "Start",
                script: "({ run() { return require('fs').readFileSync('/etc/passwd'); } })",
                end: true,
              } as routine.RoutineState,
            ]),
            bundle,
          }) as LoadedRoutineDefinition,
      },
      artifacts: { read: async () => requestArtifact },
      runs: { listStates: async () => [...harness.states.values()] },
      scheduler: harness.scheduler,
      transitions: harness,
      waits: harness.waitPort,
      scripts: new SandboxRoutineScriptPort(),
      now: () => new Date(STARTED_AT),
    });

    await expect(execute(run())).resolves.toBe("failed");
  });
});
