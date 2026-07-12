import type { RoutineDefinition } from "@tulipfarm/schema";
import { describe, expect, it, vi } from "vitest";
import { executeState } from "./interpreter";
import type { EnginePorts, ResolvedFunction } from "./ports";
import type { RunEvent, RunSnapshot } from "./types";

/**
 * Pure-port fakes: evalExpression runs real JS via Function (the production adapter is
 * isolated-vm; semantics here only need to match "JS expression over a scope object").
 */
function makePorts(overrides: Partial<EnginePorts> = {}) {
  const events: RunEvent[] = [];
  const actions: Array<{ fn: ResolvedFunction; args: Record<string, unknown> }> = [];
  const ports: EnginePorts & { events: RunEvent[]; actions: typeof actions } = {
    events,
    actions,
    evalExpression: vi.fn(async (expr: string, scope: Record<string, unknown>) => {
      const fn = new Function(...Object.keys(scope), `return (${expr});`);
      return fn(...Object.values(scope));
    }),
    runHook: vi.fn(async () => undefined),
    hasHook: vi.fn(() => false),
    runAction: vi.fn(async (fn, args) => {
      actions.push({ fn, args });
      return { ok: true, echo: args };
    }),
    emit: vi.fn(async (event: RunEvent) => {
      events.push(event);
    }),
    now: () => new Date("2026-07-06T12:00:00Z"),
    log: { warn: vi.fn() },
    ...overrides,
  };
  return ports;
}

function makeDef(partial: Partial<RoutineDefinition>): RoutineDefinition {
  return {
    id: "test-routine",
    version: "1.0",
    start: "Start",
    "x-triggers": [{ type: "manual" }],
    functions: [{ name: "doWork", operation: "tool:resource_create" }],
    states: [],
    ...partial,
  } as RoutineDefinition;
}

function makeRun(def: RoutineDefinition, overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: "run-1",
    slug: "test-routine",
    definition: def,
    currentState: def.start,
    context: {},
    trigger: { type: "manual", payload: { amount: 700 } },
    attemptCounts: {},
    ...overrides,
  };
}

describe("inject state", () => {
  it("merges data into context and transitions", async () => {
    const def = makeDef({
      states: [
        { name: "Start", type: "inject", data: { greeting: "hi" }, transition: "Next" },
        { name: "Next", type: "inject", data: {}, end: true },
      ],
    });
    const outcome = await executeState(makeRun(def, { context: { keep: 1 } }), makePorts());
    expect(outcome).toEqual({
      type: "continue",
      nextState: "Next",
      context: { keep: 1, greeting: "hi" },
    });
  });

  it("completes with output when end is true", async () => {
    const def = makeDef({
      states: [{ name: "Start", type: "inject", data: { done: true }, end: true }],
    });
    const outcome = await executeState(makeRun(def), makePorts());
    expect(outcome).toEqual({ type: "complete", output: { done: true } });
  });
});

describe("switch state", () => {
  const def = makeDef({
    states: [
      {
        name: "Start",
        type: "switch",
        dataConditions: [{ condition: "context.amount > 500", transition: "Big" }],
        defaultCondition: { transition: "Small" },
      },
      { name: "Big", type: "inject", data: {}, end: true },
      { name: "Small", type: "inject", data: {}, end: true },
    ],
  });

  it("takes the first truthy condition", async () => {
    const outcome = await executeState(makeRun(def, { context: { amount: 700 } }), makePorts());
    expect(outcome).toMatchObject({ type: "continue", nextState: "Big" });
  });

  it("falls back to defaultCondition", async () => {
    const outcome = await executeState(makeRun(def, { context: { amount: 10 } }), makePorts());
    expect(outcome).toMatchObject({ type: "continue", nextState: "Small" });
  });

  it("does not mutate the shared definition when branching", async () => {
    await executeState(makeRun(def, { context: { amount: 700 } }), makePorts());
    const switchState = def.states[0];
    expect(switchState.transition).toBeUndefined();
    expect(switchState.end).toBeUndefined();
  });

  it("fails with no_matching_condition when nothing matches and no default", async () => {
    const noDefault = makeDef({
      states: [
        {
          name: "Start",
          type: "switch",
          dataConditions: [{ condition: "false", transition: "Start" }],
        },
      ],
    });
    const outcome = await executeState(makeRun(noDefault), makePorts());
    expect(outcome).toMatchObject({ type: "fail", error: { name: "no_matching_condition" } });
  });
});

describe("operation state", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: ${...} is the routine expression DSL, not a JS template
  it("runs actions with ${...} argument expressions and applies actionDataFilter", async () => {
    const def = makeDef({
      states: [
        {
          name: "Start",
          type: "operation",
          actions: [
            {
              functionRef: {
                refName: "doWork",
                // biome-ignore lint/suspicious/noTemplateCurlyInString: routine expression DSL
                arguments: { amount: "${ context.amount * 2 }", label: "literal" },
              },
              actionDataFilter: { results: "result.echo.amount", toStateData: "context.doubled" },
            },
          ],
          end: true,
        },
      ],
    });
    const ports = makePorts();
    const outcome = await executeState(makeRun(def, { context: { amount: 21 } }), ports);
    expect(ports.actions[0]).toMatchObject({
      fn: { kind: "tool", target: "resource_create" },
      args: { amount: 42, label: "literal" },
    });
    expect(outcome).toMatchObject({ type: "complete", output: { amount: 21, doubled: 42 } });
  });

  it("routes an action failure to fail when no retry/onErrors", async () => {
    const def = makeDef({
      states: [
        {
          name: "Start",
          type: "operation",
          actions: [{ functionRef: { refName: "doWork" } }],
          end: true,
        },
      ],
    });
    const ports = makePorts({
      runAction: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const outcome = await executeState(makeRun(def), ports);
    expect(outcome).toMatchObject({
      type: "fail",
      error: { name: "action_failed", message: "boom", state: "Start" },
    });
  });
});

describe("foreach state", () => {
  it("iterates sequentially exposing iterationParam", async () => {
    const def = makeDef({
      states: [
        {
          name: "Start",
          type: "foreach",
          inputCollection: "context.items",
          iterationParam: "row",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: routine expression DSL
          actions: [{ functionRef: { refName: "doWork", arguments: { id: "${ row.id }" } } }],
          end: true,
        },
      ],
    });
    const ports = makePorts();
    await executeState(makeRun(def, { context: { items: [{ id: 1 }, { id: 2 }] } }), ports);
    expect(ports.actions.map((a) => a.args)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("fails when the collection exceeds the cap", async () => {
    const def = makeDef({
      states: [
        {
          name: "Start",
          type: "foreach",
          inputCollection: "context.items",
          actions: [{ functionRef: { refName: "doWork" } }],
          end: true,
        },
      ],
    });
    const items = Array.from({ length: 1001 }, (_, i) => i);
    const outcome = await executeState(makeRun(def, { context: { items } }), makePorts());
    expect(outcome).toMatchObject({ type: "fail", error: { name: "foreach_cap_exceeded" } });
  });

  it("fails when inputCollection is not an array", async () => {
    const def = makeDef({
      states: [
        {
          name: "Start",
          type: "foreach",
          inputCollection: "context.items",
          actions: [{ functionRef: { refName: "doWork" } }],
          end: true,
        },
      ],
    });
    const outcome = await executeState(makeRun(def, { context: { items: 42 } }), makePorts());
    expect(outcome).toMatchObject({ type: "fail", error: { name: "bad_collection" } });
  });
});

describe("sleep state", () => {
  it("suspends until now + duration and resumes at transition", async () => {
    const def = makeDef({
      states: [
        { name: "Start", type: "sleep", duration: "PT10M", transition: "Next" },
        { name: "Next", type: "inject", data: {}, end: true },
      ],
    });
    const outcome = await executeState(makeRun(def), makePorts());
    expect(outcome).toMatchObject({
      type: "sleep",
      until: new Date("2026-07-06T12:10:00Z"),
      nextState: "Next",
    });
  });

  it("signals run completion after wake when end is true", async () => {
    const def = makeDef({
      states: [{ name: "Start", type: "sleep", duration: "PT1S", end: true }],
    });
    const outcome = await executeState(makeRun(def), makePorts());
    expect(outcome).toMatchObject({ type: "sleep", nextState: null });
  });
});

describe("retries and onErrors", () => {
  const failingPorts = () =>
    makePorts({
      runAction: vi.fn(async () => {
        throw new Error("flaky");
      }),
    });

  const def = makeDef({
    retries: [{ name: "std", maxAttempts: 3, delay: "PT2S", multiplier: 2 }],
    states: [
      {
        name: "Start",
        type: "operation",
        actions: [{ functionRef: { refName: "doWork" }, retryRef: "std" }],
        onErrors: [{ errorRef: "*", transition: "Recover" }],
        end: true,
      },
      { name: "Recover", type: "inject", data: { recovered: true }, end: true },
    ],
  });

  it("returns retry with exponential backoff while attempts remain", async () => {
    const first = await executeState(makeRun(def), failingPorts());
    expect(first).toMatchObject({ type: "retry", attempt: 1, delayMs: 2000 });

    const second = await executeState(
      makeRun(def, { attemptCounts: { Start: 1 } }),
      failingPorts()
    );
    expect(second).toMatchObject({ type: "retry", attempt: 2, delayMs: 4000 });
  });

  it("routes through onErrors after retries are exhausted", async () => {
    const outcome = await executeState(
      makeRun(def, { attemptCounts: { Start: 2 } }),
      failingPorts()
    );
    expect(outcome).toMatchObject({ type: "continue", nextState: "Recover" });
  });

  it("matches onErrors by errorRef name", async () => {
    const named = makeDef({
      states: [
        {
          name: "Start",
          type: "operation",
          actions: [{ functionRef: { refName: "doWork" } }],
          onErrors: [
            { errorRef: "timeout", transition: "Recover" },
            { errorRef: "other_error", end: true },
          ],
          end: true,
        },
        { name: "Recover", type: "inject", data: {}, end: true },
      ],
    });
    const timeoutPorts = makePorts({
      runAction: vi.fn(async () => {
        const err = new Error("too slow");
        err.name = "timeout";
        throw err;
      }),
    });
    const outcome = await executeState(makeRun(named), timeoutPorts);
    expect(outcome).toMatchObject({ type: "continue", nextState: "Recover" });
  });

  it("onErrors end:true completes the run with the error attached", async () => {
    const named = makeDef({
      states: [
        {
          name: "Start",
          type: "operation",
          actions: [{ functionRef: { refName: "doWork" } }],
          onErrors: [{ errorRef: "*", end: true }],
          end: true,
        },
      ],
    });
    const outcome = await executeState(makeRun(named), failingPorts());
    expect(outcome).toMatchObject({
      type: "complete",
      output: { error: { name: "action_failed" } },
    });
  });
});

describe("per-state timeouts (ROUT-V1-007)", () => {
  const slowPorts = () =>
    makePorts({
      runAction: vi.fn(
        () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 5_000))
      ),
    });

  it("times out a slow state and routes through onErrors", async () => {
    const def = makeDef({
      states: [
        {
          name: "Start",
          type: "operation",
          timeouts: { stateExecTimeout: "PT1S" },
          actions: [{ functionRef: { refName: "doWork" } }],
          onErrors: [{ errorRef: "timeout", transition: "Recover" }],
          end: true,
        },
        { name: "Recover", type: "inject", data: { recovered: true }, end: true },
      ],
    });
    const started = Date.now();
    const outcome = await executeState(makeRun(def), slowPorts());
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(outcome).toMatchObject({ type: "continue", nextState: "Recover" });
  });

  it("fails with a timeout error when no onErrors matches", async () => {
    const def = makeDef({
      states: [
        {
          name: "Start",
          type: "operation",
          timeouts: { stateExecTimeout: "PT1S" },
          actions: [{ functionRef: { refName: "doWork" } }],
          end: true,
        },
      ],
    });
    const outcome = await executeState(makeRun(def), slowPorts());
    expect(outcome).toMatchObject({ type: "fail", error: { name: "timeout" } });
  });

  it("does not time out a fast state", async () => {
    const def = makeDef({
      states: [
        {
          name: "Start",
          type: "operation",
          timeouts: { stateExecTimeout: "PT10S" },
          actions: [{ functionRef: { refName: "doWork" } }],
          end: true,
        },
      ],
    });
    const outcome = await executeState(makeRun(def), makePorts());
    expect(outcome).toMatchObject({ type: "complete" });
  });
});

describe("human_approval gate", () => {
  const def = makeDef({
    states: [
      {
        name: "Start",
        type: "operation",
        "x-autonomy-level": "human_approval",
        "x-approval-channel": ["ui", "slack"],
        actions: [{ functionRef: { refName: "doWork" } }],
        end: true,
      },
    ],
  });

  it("pauses with wait_approval before executing", async () => {
    const ports = makePorts();
    const outcome = await executeState(makeRun(def, { context: { amount: 9 } }), ports);
    expect(outcome).toEqual({
      type: "wait_approval",
      request: { stateName: "Start", channels: ["ui", "slack"], summary: { amount: 9 } },
    });
    expect(ports.runAction).not.toHaveBeenCalled();
  });

  it("executes normally once approved", async () => {
    const ports = makePorts();
    const outcome = await executeState(makeRun(def, { approvalOutcome: "approved" }), ports);
    expect(outcome).toMatchObject({ type: "complete" });
    expect(ports.runAction).toHaveBeenCalledOnce();
  });

  it("routes denial as approval_denied error", async () => {
    const outcome = await executeState(makeRun(def, { approvalOutcome: "denied" }), makePorts());
    expect(outcome).toMatchObject({ type: "fail", error: { name: "approval_denied" } });
  });
});

describe("hooks lifecycle", () => {
  it("runs before<State>/after<State> hooks and hook: actions", async () => {
    const def = makeDef({
      functions: [{ name: "computeTotal", operation: "hook:computeTotal" }],
      states: [
        {
          name: "Report",
          type: "operation",
          actions: [
            {
              functionRef: { refName: "computeTotal", arguments: { base: 10 } },
              actionDataFilter: { toStateData: "context.total" },
            },
          ],
          end: true,
        },
      ],
      start: "Report",
    });
    const runHook = vi.fn(async (fnName: string) => (fnName === "computeTotal" ? 55 : undefined));
    const hasHook = vi.fn((name: string) => ["beforeReport", "afterReport"].includes(name));
    const ports = makePorts({ runHook, hasHook });

    const outcome = await executeState(makeRun(def, { currentState: "Report" }), ports);
    expect(outcome).toMatchObject({ type: "complete", output: { total: 55 } });
    const calls = runHook.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(["beforeReport", "computeTotal", "afterReport"]);
  });
});

describe("state data filters and events", () => {
  it("applies input/output stateDataFilter and emits lifecycle events", async () => {
    const def = makeDef({
      states: [
        {
          name: "Start",
          type: "inject",
          data: { added: 1 },
          stateDataFilter: {
            input: "({ narrowed: context.wide })",
            output: "({ final: context.added + context.narrowed })",
          },
          end: true,
        },
      ],
    });
    const ports = makePorts();
    const outcome = await executeState(makeRun(def, { context: { wide: 41 } }), ports);
    expect(outcome).toEqual({ type: "complete", output: { final: 42 } });
    expect(ports.events.map((e) => e.type)).toEqual(["state.entered", "state.completed"]);
  });
});

describe("full multi-state run", () => {
  it("walks a routine across all five state types to completion", async () => {
    const def = makeDef({
      start: "Seed",
      functions: [{ name: "doWork", operation: "tool:resource_create" }],
      states: [
        { name: "Seed", type: "inject", data: { items: [1, 2], amount: 700 }, transition: "Gate" },
        {
          name: "Gate",
          type: "switch",
          dataConditions: [{ condition: "context.amount > 500", transition: "Work" }],
          defaultCondition: { end: true },
        },
        {
          name: "Work",
          type: "foreach",
          inputCollection: "context.items",
          actions: [{ functionRef: { refName: "doWork" } }],
          transition: "Cooldown",
        },
        { name: "Cooldown", type: "sleep", duration: "PT1S", transition: "Done" },
        { name: "Done", type: "inject", data: { finished: true }, end: true },
      ],
    });
    const ports = makePorts();
    let run = makeRun(def, { currentState: "Seed" });
    const visited: string[] = [];

    for (let i = 0; i < 10; i++) {
      visited.push(run.currentState);
      const outcome = await executeState(run, ports);
      if (outcome.type === "continue") {
        run = { ...run, currentState: outcome.nextState, context: outcome.context };
      } else if (outcome.type === "sleep") {
        expect(outcome.nextState).toBe("Done");
        run = { ...run, currentState: outcome.nextState ?? "", context: outcome.context };
      } else if (outcome.type === "complete") {
        expect(outcome.output).toMatchObject({ finished: true });
        expect(visited).toEqual(["Seed", "Gate", "Work", "Cooldown", "Done"]);
        expect(ports.runAction).toHaveBeenCalledTimes(2);
        return;
      } else {
        throw new Error(`unexpected outcome ${outcome.type}`);
      }
    }
    throw new Error("routine did not complete");
  });
});
