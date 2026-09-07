import type { ActionDispatchPlan } from "@tulipfarm/run-kernel";
import { describe, expect, it } from "vitest";
import { DispatchRoutineActionPort } from "./action-port";

const plan: ActionDispatchPlan = {
  action: "record_create",
  arguments: { type: "repo_stats", data: { stars: 1 } },
  idempotencyKey: "idem",
  effectId: "effect",
  logicalEffectOrdinal: 0,
  permissionCeiling: { maxRiskClass: "high" },
};

function portReturning(result: Record<string, unknown>) {
  const seen: Record<string, unknown>[] = [];
  const port = new DispatchRoutineActionPort({
    dispatch: async (request) => {
      seen.push(request as unknown as Record<string, unknown>);
      return { callId: "c", ...result } as never;
    },
  });
  return { port, seen };
}

const request = { businessId: "b", runId: "r", stateKey: "Save", plan };

describe("DispatchRoutineActionPort", () => {
  it("publishes the Tool's own output when the call really ran", async () => {
    const { port } = portReturning({ status: "succeeded", output: { id: "rec_1" } });
    await expect(port.execute(request)).resolves.toEqual({
      kind: "succeeded",
      output: { id: "rec_1" },
    });
  });

  it("publishes the immutable stored output when the Tool effect is replayed", async () => {
    const { port } = portReturning({
      status: "succeeded",
      replayed: true,
      output: { id: "rec_1" },
    });
    await expect(port.execute(request)).resolves.toEqual({
      kind: "succeeded",
      output: { id: "rec_1" },
    });
  });

  it("holds the call to the State's authored ceiling", async () => {
    const { port, seen } = portReturning({ status: "succeeded", output: null });
    await port.execute(request);
    expect(seen[0]?.permissionCeiling).toEqual({ maxRiskClass: "high" });
  });

  it("parks on an unfinished call rather than guessing either way", async () => {
    const { port } = portReturning({ status: "awaiting_approval", approvalId: "a" });
    await expect(port.execute(request)).resolves.toEqual({
      kind: "unavailable",
      reason: "awaiting_approval",
    });
  });
});
