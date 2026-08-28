import type { routine as routineSchema } from "@tulipfarm/schema";
import type { PersistedWait } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { CHILD_COMPLETION_SCHEMA_REF } from "../../child-completion";
import { ChildRunError } from "../../children";
import { authorizeSignal, type RegisterWaitInput, type SignalWaitInput } from "../../waits";
import { planChildRoutineCall, planChildRun, resolveChildRun } from "./child";
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

/** The row the wait store would hold, so `authorizeSignal` judges the real registration. */
function persistedFrom(wait: RegisterWaitInput | null | undefined): PersistedWait {
  if (wait === null || wait === undefined) throw new Error("expected a planned wait");
  return {
    ...wait,
    status: "pending",
    resolvedAt: null,
    version: 1,
  };
}

/** Exactly what `signalChildCompletion` delivers when the child reaches a terminal status. */
function childSignal(): SignalWaitInput {
  return {
    id: ctx.waitId,
    businessId: ctx.businessId,
    runId: ctx.runId,
    token: "token",
    principal: `run:${ctx.childRunId}`,
    schemaRef: CHILD_COMPLETION_SCHEMA_REF,
    correlationKey: ctx.childRunId,
    signalDigest: "succeeded",
    receivedAt: "2026-07-25T10:05:00.000Z",
  };
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

  it("registers the wait under the ref a child's completion is actually delivered with", () => {
    // `signalChildCompletion` signals with `CHILD_COMPLETION_SCHEMA_REF`, and `authorizeSignal`
    // returns `wrong_schema` on any mismatch. A per-State ref here parks the caller on a wait no
    // child could ever redeem, which looks like a hung Run rather than a refusal.
    const plan = planChildRun(child(), ctx, {});

    expect(plan.wait?.schemaRef).toBe(CHILD_COMPLETION_SCHEMA_REF);
    expect(authorizeSignal(persistedFrom(plan.wait), childSignal(), false)).toBeNull();
  });

  it("keeps the completion ref even when the State declares its own output schema", () => {
    const plan = planChildRun(child({ outputSchemaRef: "app.spawn.output.v1" }), ctx, {});

    expect(plan.wait?.schemaRef).toBe(CHILD_COMPLETION_SCHEMA_REF);
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

describe("planChildRoutineCall", () => {
  const scope = { input: { sourceSlug: "handbook" } };

  it("resolves the callee, the mode and the authored input map", () => {
    const call = planChildRoutineCall(
      child({ input: { source: "${ input.sourceSlug }", fixed: 7 } }),
      scope
    );

    expect(call).toEqual({
      routineRef: { name: "sub-triage", version: "1.0.0" },
      mode: "wait",
      input: { source: "handbook", fixed: 7 },
      deadlineMs: 1_800_000,
    });
  });

  it("refuses a `wait` call with no deadline, so no caller can park forever", () => {
    expect(() => planChildRoutineCall(child({ deadlineMs: undefined }), scope)).toThrow(
      new RoutineStepError("deadline_not_bounded", "Spawn")
    );
  });

  it("carries no deadline when detaching, because a detached caller never parks", () => {
    const call = planChildRoutineCall(child({ mode: "detach", deadlineMs: undefined }), scope);

    expect(call).toMatchObject({ mode: "detach", deadlineMs: null });
  });

  it("refuses a State that names no callee", () => {
    expect(() => planChildRoutineCall(child({ routineRef: undefined }), scope)).toThrow(
      new RoutineStepError("missing_routine_ref", "Spawn")
    );
  });
});
