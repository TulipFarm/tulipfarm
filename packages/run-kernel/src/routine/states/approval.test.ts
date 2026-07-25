import type { routine as routineSchema } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import type { PersistedWait } from "../../waits";
import { authorizeSignal } from "../../waits";
import { planApprovalWait, resolveApproval } from "./approval";
import { RoutineStepError } from "./step";
import { compileWithTargets } from "./test-support";

const ctx = {
  businessId: "biz",
  runId: "run-1",
  waitId: "wait-1",
  now: "2026-07-25T10:00:00.000Z",
};

function approval(extra: Record<string, unknown> = {}) {
  const state: routineSchema.RoutineState = {
    type: "approval",
    name: "Approve",
    approverRoles: ["finance", "ops"],
    deadlineMs: 3_600_000,
    transition: "Done",
    ...extra,
  };
  return compileWithTargets(state);
}

describe("planApprovalWait", () => {
  it("registers a bounded approval wait scoped to the authored approver roles", () => {
    const input = planApprovalWait(approval(), ctx);

    expect(input).toEqual({
      id: "wait-1",
      businessId: "biz",
      runId: "run-1",
      stateKey: "Approve",
      kind: "approval",
      aggregation: "first",
      schemaRef: "wait:approval:Approve",
      allowedPrincipals: ["role:finance", "role:ops"],
      expectedSignals: 1,
      quorum: null,
      deadlineAt: "2026-07-25T11:00:00.000Z",
      createdAt: ctx.now,
    });
  });

  it("refuses to open an unbounded approval wait", () => {
    expect(() => planApprovalWait(approval({ deadlineMs: undefined }), ctx)).toThrow(
      new RoutineStepError("deadline_not_bounded", "Approve")
    );
  });

  it("produces a wait that denies a principal outside the approver roles", () => {
    const input = planApprovalWait(approval(), ctx);
    const wait: PersistedWait = {
      id: input.id,
      businessId: input.businessId,
      runId: input.runId,
      stateKey: input.stateKey,
      kind: input.kind,
      aggregation: input.aggregation,
      schemaRef: input.schemaRef,
      allowedPrincipals: input.allowedPrincipals,
      expectedSignals: input.expectedSignals,
      quorum: input.quorum,
      status: "pending",
      deadlineAt: input.deadlineAt,
      createdAt: input.createdAt,
      resolvedAt: null,
      version: 1,
    };
    const signal = {
      id: input.id,
      businessId: input.businessId,
      runId: input.runId,
      token: "token",
      schemaRef: input.schemaRef,
      correlationKey: "c1",
      signalDigest: "d1",
      receivedAt: "2026-07-25T10:05:00.000Z",
    };

    expect(authorizeSignal(wait, { ...signal, principal: "role:intern" }, false)).toBe(
      "wrong_principal"
    );
    expect(authorizeSignal(wait, { ...signal, principal: "role:finance" }, false)).toBeNull();
    expect(
      authorizeSignal(wait, { ...signal, principal: "role:finance", schemaRef: "other" }, false)
    ).toBe("wrong_schema");
  });
});

describe("resolveApproval", () => {
  it("continues through the authored transition once approved", () => {
    expect(resolveApproval(approval(), "approved")).toEqual({
      kind: "continue",
      outcome: { kind: "transition", target: "Done" },
    });
  });

  it("fails the State on rejection when no handler claims it", () => {
    expect(resolveApproval(approval(), "rejected")).toEqual({
      kind: "failed",
      errorRef: "approval_rejected",
    });
  });

  it("routes a rejection through an authored error handler when one exists", () => {
    const handled = approval({
      onError: [{ errorRef: "approval_rejected", transition: "Denied" }],
    });

    expect(resolveApproval(handled, "rejected")).toEqual({
      kind: "handled",
      errorRef: "approval_rejected",
      outcome: { kind: "transition", target: "Denied" },
    });
  });

  it("parks an expired approval for attention rather than deciding it either way", () => {
    expect(resolveApproval(approval(), "expired")).toEqual({
      kind: "attention",
      errorRef: "wait_expired",
    });
  });
});
