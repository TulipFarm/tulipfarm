import type { routine as routineSchema } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import {
  type CompensationPort,
  type CompensationRequest,
  planCompensation,
  runCompensation,
} from "./compensate";
import { RoutineStepError } from "./step";
import { compileWithTargets } from "./test-support";

const post: routineSchema.RoutineState = {
  type: "tool",
  name: "Post",
  toolRef: { name: "github", version: "2.0.0" },
  action: "issues.comment",
  transition: "Undo",
};

function compensate(extra: Record<string, unknown> = {}) {
  const state: routineSchema.RoutineState = {
    type: "compensate",
    name: "Undo",
    targetRef: "github.issues.deleteComment",
    forState: "Post",
    transition: "Done",
    ...extra,
  };
  return compileWithTargets(state, [post]);
}

const request: CompensationRequest = {
  businessId: "biz",
  runId: "run-1",
  stateKey: "Undo",
  targetRef: "github.issues.deleteComment",
  forState: "Post",
  effectId: "effect-1",
  idempotencyKey: "run-1:Undo:effect-1",
};

function port(status: "compensated" | "failed" | "ambiguous"): CompensationPort {
  return { compensate: async () => ({ status }) };
}

describe("planCompensation", () => {
  it("builds a request bound to the effect it is undoing, with a derived idempotency key", () => {
    expect(
      planCompensation(compensate(), {
        businessId: "biz",
        runId: "run-1",
        effectId: "effect-1",
      })
    ).toEqual(request);
  });

  it("refuses to compensate without a declared target", () => {
    const definition: routineSchema.RoutineState = {
      type: "agent",
      name: "Undo",
      agentRef: { name: "triage", version: "1.0.0" },
      end: true,
    };
    const broken = { ...compensate(), definition };

    expect(() =>
      planCompensation(broken, { businessId: "biz", runId: "run-1", effectId: "effect-1" })
    ).toThrow(new RoutineStepError("missing_target_ref", "Undo"));
  });
});

describe("runCompensation", () => {
  it("continues once the effect is confirmed compensated", async () => {
    await expect(runCompensation(compensate(), port("compensated"), request)).resolves.toEqual({
      kind: "continue",
      outcome: { kind: "transition", target: "Done" },
    });
  });

  it("parks a failed compensation for attention, never continuing as if it succeeded", async () => {
    await expect(runCompensation(compensate(), port("failed"), request)).resolves.toEqual({
      kind: "attention",
      errorRef: "compensation_failed",
    });
  });

  it("parks an ambiguous compensation for attention rather than guessing", async () => {
    await expect(runCompensation(compensate(), port("ambiguous"), request)).resolves.toEqual({
      kind: "attention",
      errorRef: "compensation_ambiguous",
    });
  });

  it("parks for attention when the compensation port itself threw", async () => {
    const throwing: CompensationPort = {
      compensate: async () => {
        throw new Error("boom sk-live-abcdef");
      },
    };
    const decision = await runCompensation(compensate(), throwing, request);

    expect(decision).toEqual({ kind: "attention", errorRef: "compensation_failed" });
  });

  it("lets an authored handler claim a failed compensation explicitly", async () => {
    const handled = compensate({
      onError: [{ errorRef: "compensation_failed", transition: "Manual" }],
    });

    await expect(runCompensation(handled, port("failed"), request)).resolves.toEqual({
      kind: "handled",
      errorRef: "compensation_failed",
      outcome: { kind: "transition", target: "Manual" },
    });
  });
});
