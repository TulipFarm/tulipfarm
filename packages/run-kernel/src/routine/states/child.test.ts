import type { routine as routineSchema } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { ChildRunError } from "../../children";
import { planChildRun, resolveChildRun } from "./child";
import { RoutineStepError } from "./step";
import { compileWithTargets } from "./test-support";

const parentAuthority = {
  tools: ["github", "slack"],
  classifications: ["internal"],
  limits: { maxToolCalls: 20 },
};

const ctx = {
  businessId: "biz",
  runId: "run-1",
  childRunId: "run-2",
  waitId: "wait-1",
  stateKey: "Fanout#0/Gate",
  now: "2026-07-25T10:00:00.000Z",
  parentAuthority,
};

function child(extra: Record<string, unknown> = {}) {
  const state: routineSchema.RoutineState = {
    type: "child_routine",
    name: "Spawn",
    routineRef: { name: "sub-triage", version: "1.0.0" },
    mode: "wait",
    deadlineMs: 1_800_000,
    transition: "Done",
    ...extra,
  };
  return compileWithTargets(state);
}

describe("planChildRun", () => {
  it("issues a child-Run command whose authority is narrowed to the parent's", () => {
    const plan = planChildRun(child(), ctx, { tools: ["github"] });

    expect(plan.command).toEqual({
      businessId: "biz",
      parentRunId: "run-1",
      childRunId: "run-2",
      routineRef: { name: "sub-triage", version: "1.0.0" },
      authority: {
        tools: ["github"],
        classifications: ["internal"],
        limits: { maxToolCalls: 20 },
      },
      mode: "wait",
    });
  });

  it("denies a child that asks for authority the parent never held", () => {
    expect(() => planChildRun(child(), ctx, { tools: ["shell"] })).toThrow(
      new ChildRunError("child_authority_amplification", "tools")
    );
  });

  it("opens a bounded child-Run wait in `wait` mode and none in `detach` mode", () => {
    const waiting = planChildRun(child(), ctx, {});
    const detached = planChildRun(child({ mode: "detach" }), ctx, {});

    expect(waiting.wait?.kind).toBe("child_run");
    expect(waiting.wait?.allowedPrincipals).toEqual(["run:run-2"]);
    expect(waiting.wait?.deadlineAt).toBe("2026-07-25T10:30:00.000Z");
    expect(detached.wait).toBeNull();
  });

  it("refuses a waiting child Run with no bounded deadline", () => {
    expect(() => planChildRun(child({ deadlineMs: undefined }), ctx, {})).toThrow(
      new RoutineStepError("deadline_not_bounded", "Spawn")
    );
  });
});

describe("resolveChildRun", () => {
  it("continues when the child Run succeeded", () => {
    expect(resolveChildRun(child(), "succeeded")).toEqual({
      kind: "continue",
      outcome: { kind: "transition", target: "Done" },
    });
  });

  it("fails the parent State when the child failed and nothing handles it", () => {
    expect(resolveChildRun(child(), "failed")).toEqual({
      kind: "failed",
      errorRef: "child_failed",
    });
    expect(
      resolveChildRun(
        child({ onError: [{ errorRef: "child_failed", transition: "Recover" }] }),
        "failed"
      )
    ).toEqual({
      kind: "handled",
      errorRef: "child_failed",
      outcome: { kind: "transition", target: "Recover" },
    });
  });

  it("parks a cancelled or expired child Run for attention", () => {
    expect(resolveChildRun(child(), "cancelled")).toEqual({
      kind: "attention",
      errorRef: "child_cancelled",
    });
    expect(resolveChildRun(child(), "expired")).toEqual({
      kind: "attention",
      errorRef: "wait_expired",
    });
  });
});
