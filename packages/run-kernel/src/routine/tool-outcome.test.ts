import type { routine as routineSchema } from "@tulipfarm/schema";
import { describe, expect, it, vi } from "vitest";
import { compileRoutine } from "./compiler";
import { applyRoutineToolStateOutcome } from "./tool-outcome";

function state() {
  const compiled = compileRoutine(
    {
      apiVersion: "tulipfarm.ai/v1",
      kind: "Routine",
      metadata: {
        id: "11111111-1111-4111-8111-111111111111",
        slug: "tool-outcome",
        schemaVersion: 1,
        authoredVersion: 1,
        lifecycle: "published",
      },
      spec: {
        owner: "agent:assistant",
        start: "Send",
        states: [
          {
            type: "tool",
            name: "Send",
            toolRef: { name: "acme.send", version: "1.0.0" },
            action: "message.send",
            input: {},
            end: true,
          },
        ],
      },
    } as routineSchema.RoutineDefinition,
    {
      identityCeiling: {
        principalKind: "agent",
        principalId: "assistant",
        grants: ["*"],
        maxRiskClass: "high",
      },
    }
  );
  const state = compiled.states.get("Send");
  if (state === undefined) throw new Error("missing compiled Tool State");
  return state;
}

function ports() {
  return {
    complete: vi.fn(),
    awaitApproval: vi.fn(async () => "waiting" as const),
    wait: vi.fn(async () => "waiting" as const),
    reconcile: vi.fn(async () => "needs_reconciliation" as const),
    fail: vi.fn(() => "failed" as const),
  };
}

describe("applyRoutineToolStateOutcome", () => {
  it("publishes a successful provider output and advances the authored State", async () => {
    const actions = ports();
    await expect(
      applyRoutineToolStateOutcome(
        state(),
        { kind: "succeeded", output: { receiptId: "receipt-1" } },
        actions
      )
    ).resolves.toEqual({ kind: "end" });
    expect(actions.complete).toHaveBeenCalledWith({ receiptId: "receipt-1" });
  });

  it("never opens a new wait while validating an already-settled State", async () => {
    const actions = ports();
    await expect(
      applyRoutineToolStateOutcome(
        state(),
        { kind: "awaiting_approval", reason: "approval_required", approvalId: "approval-1" },
        actions,
        { settledReplay: true }
      )
    ).resolves.toBe("needs_reconciliation");
    expect(actions.awaitApproval).not.toHaveBeenCalled();
    expect(actions.reconcile).toHaveBeenCalledWith("routine:settled_tool_evidence_invalid");
  });

  it("parks provider retry waits without treating them as failures", async () => {
    const actions = ports();
    await expect(
      applyRoutineToolStateOutcome(
        state(),
        {
          kind: "waiting",
          effectId: "effect-1",
          attempt: 1,
          notBefore: "2026-09-13T00:01:00.000Z",
          reason: "rate_limited",
          delayMs: 1_000,
          waitId: "wait-1",
        },
        actions
      )
    ).resolves.toBe("waiting");
    expect(actions.wait).toHaveBeenCalledWith("rate_limited");
  });
});
