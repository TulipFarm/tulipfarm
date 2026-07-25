import type { routine as routineSchema } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { type CompiledState, compileRoutine, type IdentityCeiling } from "../compiler";
import { initRepeatProgress, type RepeatProgress, stepRepeat } from "./repeat";
import { RoutineStepError } from "./step";

const identityCeiling: IdentityCeiling = {
  principalKind: "service",
  principalId: "triage-bot",
  grants: ["github:issues:write"],
  maxRiskClass: "low",
};

function repeatState(maxIterations: number, maxDurationMs: number): CompiledState {
  const loop: routineSchema.RoutineState = {
    type: "repeat_until",
    name: "Loop",
    condition: "states.Work.output.done",
    body: "Work",
    maxIterations,
    maxDurationMs,
    transition: "Done",
  };
  const work: routineSchema.RoutineState = {
    type: "agent",
    name: "Work",
    agentRef: { name: "triage", version: "1.0.0" },
    output: { type: "object", properties: { done: { type: "boolean" } } },
    transition: "Loop",
  };
  const done: routineSchema.RoutineState = {
    type: "agent",
    name: "Done",
    agentRef: { name: "triage", version: "1.0.0" },
    end: true,
  };
  const compiled = compileRoutine(
    {
      apiVersion: "tulipfarm.ai/v1",
      kind: "Routine",
      metadata: {
        id: "01J0000000000000000000ROUT",
        slug: "looping",
        schemaVersion: 1,
        authoredVersion: 1,
        lifecycle: "published",
      },
      spec: { owner: "platform", start: "Loop", states: [loop, work, done] },
    } as routineSchema.RoutineDefinition,
    { identityCeiling }
  );
  const state = compiled.states.get("Loop");
  if (state === undefined) throw new Error("missing Loop");
  return state;
}

const unfinished = { states: { Work: { output: { done: false } } } };
const finished = { states: { Work: { output: { done: true } } } };

describe("stepRepeat", () => {
  it("runs the body once before the termination condition is ever consulted", () => {
    const state = repeatState(5, 60_000);
    const progress = initRepeatProgress(1_000);

    expect(progress).toEqual({ iterations: 0, startedAtMs: 1_000 });
    expect(stepRepeat(state, progress, finished, 1_000)).toEqual({
      kind: "body",
      iteration: 0,
      target: "Work",
    });
  });

  it("keeps looping while the condition is false, deterministically", () => {
    const state = repeatState(5, 60_000);
    const progress: RepeatProgress = { iterations: 2, startedAtMs: 1_000 };

    expect(stepRepeat(state, progress, unfinished, 2_000)).toEqual({
      kind: "body",
      iteration: 2,
      target: "Work",
    });
    expect(stepRepeat(state, progress, unfinished, 2_000)).toEqual(
      stepRepeat(state, progress, unfinished, 2_000)
    );
  });

  it("exits through the authored transition once the condition holds", () => {
    const state = repeatState(5, 60_000);

    expect(stepRepeat(state, { iterations: 1, startedAtMs: 1_000 }, finished, 2_000)).toEqual({
      kind: "exit",
      outcome: { kind: "transition", target: "Done" },
    });
  });

  it("fails closed at the iteration bound instead of exiting silently", () => {
    const state = repeatState(3, 60_000);

    expect(() =>
      stepRepeat(state, { iterations: 3, startedAtMs: 1_000 }, unfinished, 2_000)
    ).toThrow(new RoutineStepError("iteration_cap_exceeded", "Loop"));
  });

  it("fails closed at the duration bound before starting another iteration", () => {
    const state = repeatState(100, 10_000);

    expect(() =>
      stepRepeat(state, { iterations: 1, startedAtMs: 1_000 }, unfinished, 11_000)
    ).toThrow(new RoutineStepError("duration_cap_exceeded", "Loop"));
  });

  it("lets a satisfied condition win over an exhausted bound", () => {
    const state = repeatState(3, 10_000);

    expect(stepRepeat(state, { iterations: 3, startedAtMs: 1_000 }, finished, 99_000)).toEqual({
      kind: "exit",
      outcome: { kind: "transition", target: "Done" },
    });
  });

  it("fails closed when the compiled State carries no loop bound", () => {
    const state = repeatState(3, 10_000);
    const unbounded: CompiledState = {
      ...state,
      bounds: { ...state.bounds, maxIterations: null },
    };

    expect(() =>
      stepRepeat(unbounded, { iterations: 0, startedAtMs: 1_000 }, unfinished, 1_000)
    ).toThrow(new RoutineStepError("iterations_not_bounded", "Loop"));
  });

  it("never leaks scope values in a bound error message", () => {
    const state = repeatState(1, 10_000);

    try {
      stepRepeat(state, { iterations: 1, startedAtMs: 0 }, { states: { Work: { output: {} } } }, 1);
      throw new Error("expected denial");
    } catch (error) {
      expect((error as RoutineStepError).message).toBe("iteration_cap_exceeded:Loop");
    }
  });
});
