import type { AgentLoopInput, AgentLoopOutcome } from "@tulipfarm/agent-runtime";
import { RunTransitionError, type StateStatus } from "@tulipfarm/run-kernel";
import { describe, expect, it } from "vitest";
import { type AgentStateRequest, AgentStateRunner } from "./agent-state";

const counters = { iterations: 1, toolCalls: 0, repairs: 0 };

function request(from: StateStatus = "claimed"): AgentStateRequest {
  return { businessId: "biz-1", runId: "run-1", stateKey: "state-1", from };
}

const LOOP_INPUT: AgentLoopInput = {
  businessId: "biz-1",
  runId: "run-1",
  stateId: "state-1",
  modelProfileId: "primary",
  contextDigest: "sha256:context",
  guardrailDigest: "sha256:guardrail",
  messages: [],
  tools: [],
  limits: { maxIterations: 4, maxToolCalls: 4, maxRepairAttempts: 2 },
};

function runner(
  outcome: AgentLoopOutcome | (() => Promise<AgentLoopOutcome>),
  overrides: { waitId?: string } = {}
) {
  const transitions: { from: StateStatus; to: StateStatus }[] = [];
  const waits: { approvalId: string }[] = [];
  let loopRuns = 0;

  const agentState = new AgentStateRunner({
    loop: {
      run: async () => {
        loopRuns += 1;
        return typeof outcome === "function" ? await outcome() : outcome;
      },
    },
    transitions: {
      transition: async (input) => {
        transitions.push({ from: input.from, to: input.to });
      },
    },
    waits: {
      register: async (input) => {
        waits.push({ approvalId: input.approvalId });
        return { waitId: overrides.waitId ?? "wait-1" };
      },
    },
  });

  return {
    agentState,
    transitions,
    waits,
    get loopRuns() {
      return loopRuns;
    },
  };
}

describe("AgentStateRunner", () => {
  it("drives a completed loop through running to succeeded", async () => {
    const harness = runner({ status: "completed", output: { label: "bug" }, ...counters });
    const result = await harness.agentState.execute(request(), LOOP_INPUT);

    expect(harness.transitions).toEqual([
      { from: "claimed", to: "running" },
      { from: "running", to: "succeeded" },
    ]);
    expect(result).toMatchObject({ status: "succeeded", output: { label: "bug" } });
  });

  it("fails the State when the loop hits a durable limit", async () => {
    const harness = runner({ status: "failed", reason: "iteration_limit", ...counters });
    const result = await harness.agentState.execute(request(), LOOP_INPUT);

    expect(harness.transitions.at(-1)).toEqual({ from: "running", to: "failed" });
    expect(result).toMatchObject({ status: "failed", reason: "iteration_limit" });
  });

  it("registers a durable wait and parks the State instead of finishing it", async () => {
    const harness = runner({
      status: "awaiting_approval",
      approvalId: "appr-1",
      callId: "call-1",
      ...counters,
    });
    const result = await harness.agentState.execute(request(), LOOP_INPUT);

    expect(harness.waits).toEqual([{ approvalId: "appr-1" }]);
    expect(harness.transitions.at(-1)).toEqual({ from: "running", to: "waiting" });
    expect(result).toMatchObject({ status: "waiting", waitId: "wait-1" });
  });

  it("takes a cancelled loop through cancelling to cancelled", async () => {
    const harness = runner({ status: "cancelled", ...counters });
    const result = await harness.agentState.execute(request(), LOOP_INPUT);

    expect(harness.transitions).toEqual([
      { from: "claimed", to: "running" },
      { from: "running", to: "cancelling" },
      { from: "cancelling", to: "cancelled" },
    ]);
    expect(result).toMatchObject({ status: "cancelled" });
  });

  it("marks the State for reconciliation when the loop throws mid-flight", async () => {
    const harness = runner(async () => {
      throw new Error("worker crashed");
    });
    const result = await harness.agentState.execute(request(), LOOP_INPUT);

    expect(harness.transitions.at(-1)).toEqual({ from: "running", to: "needs_reconciliation" });
    expect(result).toMatchObject({ status: "needs_reconciliation" });
  });

  it("refuses to start from a terminal State status and never runs the loop", async () => {
    const harness = runner({ status: "completed", output: null, ...counters });

    await expect(
      harness.agentState.execute(request("succeeded"), LOOP_INPUT)
    ).rejects.toBeInstanceOf(RunTransitionError);
    expect(harness.loopRuns).toBe(0);
  });
});
