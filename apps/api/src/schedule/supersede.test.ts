import { describe, expect, it } from "vitest";
import { type ActiveRunLister, supersedeRoutineRuns } from "./supersede";

function lister(ids: readonly string[]): ActiveRunLister {
  return { listActiveByRoutine: async () => ids };
}

describe("supersedeRoutineRuns", () => {
  /**
   * `overlapPolicy: "supersede"` promises the newest occurrence replaces the running one. The
   * dispatcher used to start the replacement and leave the replaced Run going, which is `allow`
   * under another name.
   */
  it("cancels every unfinished Run of the Routine", async () => {
    const cancelled: string[] = [];
    await supersedeRoutineRuns(
      lister(["run-1", "run-2"]),
      async (input) => {
        cancelled.push(input.runId);
      },
      "routine-a"
    );
    expect(cancelled).toEqual(["run-1", "run-2"]);
  });

  it("names the reason so a cancelled Run is not mistaken for a failure", async () => {
    const reasons: string[] = [];
    await supersedeRoutineRuns(
      lister(["run-1"]),
      async (input) => {
        reasons.push(input.reason);
      },
      "routine-a"
    );
    expect(reasons).toEqual(["superseded_by_schedule"]);
  });

  it("does nothing when no Run is active", async () => {
    let calls = 0;
    await supersedeRoutineRuns(
      lister([]),
      async () => {
        calls += 1;
      },
      "routine-a"
    );
    expect(calls).toBe(0);
  });

  it("propagates a refusal rather than letting the replacement start alongside it", async () => {
    await expect(
      supersedeRoutineRuns(
        lister(["run-1"]),
        async () => {
          throw new Error("cancel refused");
        },
        "routine-a"
      )
    ).rejects.toThrow("cancel refused");
  });
});
