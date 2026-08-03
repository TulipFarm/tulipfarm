import type { routine as routineSchema } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { RoutineStepError } from "./step";
import { compileWithTargets } from "./test-support";
import { isTimerWait, planTimerWait } from "./wait";

const ctx = {
  businessId: "biz",
  runId: "run-1",
  waitId: "wait-1",
  stateKey: "Settle#0/Pause",
  now: "2026-07-25T10:00:00.000Z",
};

function wait(waitFor: Record<string, unknown>) {
  const state: routineSchema.RoutineState = {
    type: "wait",
    name: "Pause",
    waitFor,
    transition: "Done",
  };
  return compileWithTargets(state);
}

describe("isTimerWait", () => {
  it("recognises a clock wait and rejects an event wait", () => {
    expect(isTimerWait(wait({ kind: "timer", durationMs: 1_000 }))).toBe(true);
    expect(isTimerWait(wait({ kind: "event", eventType: "invoice.paid" }))).toBe(false);
  });
});

describe("planTimerWait", () => {
  it("opens a bounded timer under the durable occurrence key", () => {
    expect(planTimerWait(wait({ kind: "timer", durationMs: 3_600_000 }), ctx)).toEqual({
      id: "wait-1",
      businessId: "biz",
      runId: "run-1",
      stateKey: "Settle#0/Pause",
      kind: "timer",
      aggregation: "first",
      schemaRef: "wait:timer:Pause",
      allowedPrincipals: [],
      expectedSignals: 1,
      quorum: null,
      deadlineAt: "2026-07-25T11:00:00.000Z",
      createdAt: ctx.now,
    });
  });

  it("refuses a timer with no positive duration", () => {
    expect(() => planTimerWait(wait({ kind: "timer" }), ctx)).toThrow(
      new RoutineStepError("deadline_not_bounded", "Pause")
    );
    expect(() => planTimerWait(wait({ kind: "timer", durationMs: 0 }), ctx)).toThrow(
      new RoutineStepError("deadline_not_bounded", "Pause")
    );
  });

  it("refuses a wait no clock can resolve", () => {
    expect(() => planTimerWait(wait({ kind: "event", eventType: "invoice.paid" }), ctx)).toThrow(
      new RoutineStepError("wait_kind_not_supported", "Pause")
    );
  });
});
