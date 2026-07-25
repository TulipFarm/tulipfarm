import type { routine as routineSchema } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { humanTaskAssignment, planHumanTaskWait, resolveHumanTask } from "./human";
import { RoutineStepError } from "./step";
import { compileWithTargets } from "./test-support";

const ctx = {
  businessId: "biz",
  runId: "run-1",
  waitId: "wait-1",
  now: "2026-07-25T10:00:00.000Z",
};

function humanTask(extra: Record<string, unknown> = {}) {
  const state: routineSchema.RoutineState = {
    type: "human_task",
    name: "Review",
    assigneeRoles: ["ops"],
    deadlineMs: 600_000,
    transition: "Done",
    ...extra,
  };
  return compileWithTargets(state);
}

describe("planHumanTaskWait", () => {
  it("opens a bounded human-task wait addressed to the authored assignee roles", () => {
    const input = planHumanTaskWait(humanTask(), ctx);

    expect(input.kind).toBe("human_task");
    expect(input.allowedPrincipals).toEqual(["role:ops"]);
    expect(input.deadlineAt).toBe("2026-07-25T10:10:00.000Z");
    expect(input.expectedSignals).toBe(1);
  });

  it("describes the assignment the caller must publish, without inventing an assignee", () => {
    expect(humanTaskAssignment(humanTask())).toEqual({
      stateKey: "Review",
      roles: ["ops"],
      principals: ["role:ops"],
    });
  });

  it("refuses a human task with no bounded deadline", () => {
    expect(() => planHumanTaskWait(humanTask({ deadlineMs: undefined }), ctx)).toThrow(
      new RoutineStepError("deadline_not_bounded", "Review")
    );
  });
});

describe("resolveHumanTask", () => {
  it("continues once the task is completed", () => {
    expect(resolveHumanTask(humanTask(), "completed")).toEqual({
      kind: "continue",
      outcome: { kind: "transition", target: "Done" },
    });
  });

  it("takes the authored handler when the assignee declined", () => {
    const handled = humanTask({ onError: [{ errorRef: "task_declined", transition: "Escalate" }] });

    expect(resolveHumanTask(handled, "declined")).toEqual({
      kind: "handled",
      errorRef: "task_declined",
      outcome: { kind: "transition", target: "Escalate" },
    });
    expect(resolveHumanTask(humanTask(), "declined")).toEqual({
      kind: "failed",
      errorRef: "task_declined",
    });
  });

  it("parks an expired task for attention instead of completing or failing it", () => {
    expect(resolveHumanTask(humanTask(), "expired")).toEqual({
      kind: "attention",
      errorRef: "wait_expired",
    });
  });
});
