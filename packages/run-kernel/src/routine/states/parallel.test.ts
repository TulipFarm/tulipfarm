import type { routine as routineSchema } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { type CompiledState, compileRoutine, type IdentityCeiling } from "../compiler";
import {
  initParallelProgress,
  joinParallel,
  type ParallelProgress,
  planParallel,
  settleParallelBranch,
} from "./parallel";
import { RoutineStepError } from "./step";

const identityCeiling: IdentityCeiling = {
  principalKind: "service",
  principalId: "triage-bot",
  grants: ["github:issues:write"],
  maxRiskClass: "low",
};

function agent(name: string): routineSchema.RoutineState {
  return { type: "agent", name, agentRef: { name: "triage", version: "1.0.0" }, end: true };
}

function fanOut(
  branches: string[],
  maxConcurrency: number,
  join?: "all" | "any" | "quorum"
): CompiledState {
  const parallel: routineSchema.RoutineState = {
    type: "parallel",
    name: "Fan",
    branches,
    maxConcurrency,
    ...(join === undefined ? {} : { join }),
    transition: "Done",
  };
  const compiled = compileRoutine(
    {
      apiVersion: "tulipfarm.ai/v1",
      kind: "Routine",
      metadata: {
        id: "01J0000000000000000000ROUT",
        slug: "fan-out",
        schemaVersion: 1,
        authoredVersion: 1,
        lifecycle: "published",
      },
      spec: {
        owner: "platform",
        start: "Fan",
        states: [parallel, ...branches.map(agent), agent("Done")],
      },
    } as routineSchema.RoutineDefinition,
    { identityCeiling }
  );
  const state = compiled.states.get("Fan");
  if (state === undefined) throw new Error("missing Fan");
  return state;
}

const three = ["A", "B", "C"];

describe("planParallel", () => {
  it("starts branches in authored order, never more than the concurrency cap", () => {
    const state = fanOut(three, 2);
    const progress = initParallelProgress(state);

    expect(progress.entries.map((e) => e.branch)).toEqual(three);
    expect(planParallel(state, progress).dispatch).toEqual(["A", "B"]);
  });

  it("resumes after a crash without re-dispatching confirmed or in-flight work", () => {
    const state = fanOut(three, 2);
    const crashed: ParallelProgress = {
      entries: [
        { branch: "A", status: "succeeded" },
        { branch: "B", status: "running" },
        { branch: "C", status: "pending" },
      ],
    };

    // One slot is free because A settled; B stays in flight and is never started twice.
    expect(planParallel(state, crashed).dispatch).toEqual(["C"]);
    expect(planParallel(state, crashed)).toEqual(planParallel(state, crashed));
  });

  it("dispatches nothing once every branch has settled", () => {
    const state = fanOut(three, 3);
    const done: ParallelProgress = {
      entries: three.map((branch) => ({ branch, status: "succeeded" as const })),
    };

    expect(planParallel(state, done)).toEqual({ dispatch: [], settled: true });
  });

  it("fails closed when the compiled State carries no concurrency bound", () => {
    const state = fanOut(three, 2);
    const unbounded: CompiledState = {
      ...state,
      bounds: { ...state.bounds, maxConcurrency: null },
    };

    expect(() => planParallel(unbounded, initParallelProgress(state))).toThrow(
      new RoutineStepError("concurrency_not_bounded", "Fan")
    );
  });
});

describe("settleParallelBranch", () => {
  it("records a settled branch immutably and is idempotent on replay", () => {
    const state = fanOut(three, 2);
    const started = settleParallelBranch(initParallelProgress(state), "A", "running");
    const settled = settleParallelBranch(started, "A", "succeeded");

    expect(started.entries[0]?.status).toBe("running");
    expect(settled.entries[0]?.status).toBe("succeeded");
    expect(settleParallelBranch(settled, "A", "succeeded")).toEqual(settled);
  });

  it("refuses to move a settled branch back to an unsettled status", () => {
    const state = fanOut(three, 2);
    const settled = settleParallelBranch(initParallelProgress(state), "A", "succeeded");

    expect(() => settleParallelBranch(settled, "A", "running")).toThrow(
      new RoutineStepError("branch_already_settled", "A")
    );
  });

  it("rejects a branch the compiled graph never declared", () => {
    const state = fanOut(three, 2);

    expect(() => settleParallelBranch(initParallelProgress(state), "Z", "succeeded")).toThrow(
      new RoutineStepError("unknown_branch", "Z")
    );
  });
});

describe("joinParallel", () => {
  function progressOf(...statuses: Array<"pending" | "running" | "succeeded" | "failed">) {
    return { entries: three.map((branch, i) => ({ branch, status: statuses[i] ?? "pending" })) };
  }

  it("holds an `all` join until every branch succeeded", () => {
    const state = fanOut(three, 3, "all");

    expect(joinParallel(state, progressOf("succeeded", "running", "pending"))).toEqual({
      kind: "pending",
    });
    expect(joinParallel(state, progressOf("succeeded", "succeeded", "succeeded"))).toEqual({
      kind: "satisfied",
      outcome: { kind: "transition", target: "Done" },
      cancel: [],
    });
  });

  it("defaults an unspecified join to `all`", () => {
    const state = fanOut(three, 3);

    expect(joinParallel(state, progressOf("succeeded", "succeeded", "succeeded")).kind).toBe(
      "satisfied"
    );
  });

  it("fails an `all` join as soon as one branch failed", () => {
    const state = fanOut(three, 3, "all");

    expect(joinParallel(state, progressOf("succeeded", "failed", "running"))).toEqual({
      kind: "failed",
      failures: ["B"],
    });
  });

  it("satisfies an `any` join on the first success and cancels the rest", () => {
    const state = fanOut(three, 3, "any");

    expect(joinParallel(state, progressOf("running", "succeeded", "pending"))).toEqual({
      kind: "satisfied",
      outcome: { kind: "transition", target: "Done" },
      cancel: ["A", "C"],
    });
  });

  it("fails an `any` join only when no branch can still succeed", () => {
    const state = fanOut(three, 3, "any");

    expect(joinParallel(state, progressOf("failed", "failed", "running")).kind).toBe("pending");
    expect(joinParallel(state, progressOf("failed", "failed", "failed"))).toEqual({
      kind: "failed",
      failures: three,
    });
  });

  it("satisfies a `quorum` join at a strict majority of branches", () => {
    const state = fanOut(three, 3, "quorum");

    expect(joinParallel(state, progressOf("succeeded", "running", "pending")).kind).toBe("pending");
    expect(joinParallel(state, progressOf("succeeded", "succeeded", "running"))).toEqual({
      kind: "satisfied",
      outcome: { kind: "transition", target: "Done" },
      cancel: ["C"],
    });
    expect(joinParallel(state, progressOf("failed", "failed", "running")).kind).toBe("failed");
  });
});
