import { describe, expect, it } from "vitest";
import {
  assertRunTransition,
  assertStateTransition,
  RUN_STATUSES,
  RunTransitionError,
  STATE_STATUSES,
} from "./run";

describe("Run model", () => {
  it("exposes the complete canonical Run and State statuses", () => {
    expect(RUN_STATUSES).toEqual([
      "queued",
      "claimed",
      "running",
      "waiting",
      "succeeded",
      "failed",
      "cancelling",
      "cancelled",
      "attention_required",
      "needs_reconciliation",
    ]);
    expect(STATE_STATUSES).toEqual([
      "pending",
      "ready",
      "claimed",
      "running",
      "waiting",
      "succeeded",
      "failed",
      "skipped",
      "cancelling",
      "cancelled",
      "needs_reconciliation",
    ]);
  });

  it("accepts declared recovery transitions and rejects invented transitions", () => {
    expect(() => assertRunTransition("needs_reconciliation", "succeeded")).not.toThrow();
    expect(() => assertStateTransition("running", "needs_reconciliation")).not.toThrow();

    expect(() => assertRunTransition("succeeded", "running")).toThrow(
      new RunTransitionError("invalid_run_transition", "succeeded", "running")
    );
    expect(() => assertStateTransition("pending", "succeeded")).toThrow(
      new RunTransitionError("invalid_state_transition", "pending", "succeeded")
    );
  });
});
