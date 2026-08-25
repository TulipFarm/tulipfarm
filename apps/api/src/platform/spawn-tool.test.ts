import { DelegationError } from "@tulipfarm/agent-runtime";
import { ChildRunError } from "@tulipfarm/run-kernel";
import { isParked } from "@tulipfarm/tool-host";
import { describe, expect, it, vi } from "vitest";
import { spawnSubagentTool } from "./spawn-tool";
import type { PlatformToolContext } from "./tools";

const PARENT_RUN = "00000000-0000-4000-8000-0000000000a1";
const CHILD_RUN = "00000000-0000-4000-8000-0000000000c1";

const ARGS = {
  name: "Summarizer",
  instructions: "Answer in one sentence.",
  task: "Summarize the incident.",
};

const AWAITING = {
  personaName: "Summarizer",
  childRunId: CHILD_RUN,
  depth: 1,
  deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  status: "awaiting" as const,
  answer: null,
  waitId: "wait-1",
};

function ctx(
  overrides: {
    outcome?: unknown;
    reject?: unknown;
    requestContext?: Record<string, unknown> | undefined;
  } = {}
): PlatformToolContext & { spawnSubagent: ReturnType<typeof vi.fn> } {
  const spawnSubagent = vi.fn(async () => {
    if (overrides.reject) throw overrides.reject;
    return overrides.outcome ?? AWAITING;
  });
  return {
    spawnSubagent,
    requestContext:
      "requestContext" in overrides
        ? overrides.requestContext
        : { runId: PARENT_RUN, stateKey: "invoke", toolCallId: "call-1", agentId: "concierge" },
  } as unknown as PlatformToolContext & { spawnSubagent: ReturnType<typeof vi.fn> };
}

describe("spawn_subagent", () => {
  it("parks the caller on the helper's wait instead of returning a result", async () => {
    const c = ctx();

    const result = await spawnSubagentTool.handler(ARGS, c);

    expect(isParked(result)).toBe(true);
    expect(result).toMatchObject({ parked: { kind: "child_run", childRunId: CHILD_RUN } });
  });

  it("keys the spawn on the Tool call so a resumed turn adopts rather than respawns", async () => {
    const c = ctx();

    await spawnSubagentTool.handler(ARGS, c);

    expect(c.spawnSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        parentRunId: PARENT_RUN,
        parentStateKey: "invoke",
        callId: "call-1",
        parentAgentId: "concierge",
      })
    );
  });

  it("passes the caller's instructions as the persona, never as authority", async () => {
    const c = ctx();

    await spawnSubagentTool.handler({ ...ARGS, toolNames: ["record_list"] }, c);

    const input = c.spawnSubagent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.persona).toEqual({ name: "Summarizer", instructions: "Answer in one sentence." });
    expect(input.toolNames).toEqual(["record_list"]);
  });

  it("returns the answer directly when the helper already finished", async () => {
    const c = ctx({
      outcome: { ...AWAITING, status: "succeeded", answer: "all clear", waitId: null },
    });

    const result = await spawnSubagentTool.handler(ARGS, c);

    expect(isParked(result)).toBe(false);
    expect(result).toMatchObject({ success: true, data: { answer: "all clear" } });
  });

  it("refuses outside a durable Run rather than spawning an unparented helper", async () => {
    const c = ctx({ requestContext: undefined });

    const result = await spawnSubagentTool.handler(ARGS, c);

    expect(result).toMatchObject({ success: false, error: { code: "unavailable" } });
    expect(c.spawnSubagent).not.toHaveBeenCalled();
  });

  it("refuses when there is no Tool call id to make the spawn idempotent", async () => {
    // Without one, every resume of the parked turn would mint another helper.
    const c = ctx({ requestContext: { runId: PARENT_RUN, stateKey: "invoke" } });

    const result = await spawnSubagentTool.handler(ARGS, c);

    expect(result).toMatchObject({ success: false, error: { code: "unavailable" } });
    expect(c.spawnSubagent).not.toHaveBeenCalled();
  });

  it("refuses the depth ceiling as a tool error rather than crashing the turn", async () => {
    const c = ctx({ reject: new DelegationError("depth_limit_exceeded", "depth") });

    const result = await spawnSubagentTool.handler(ARGS, c);

    expect(result).toMatchObject({ success: false, error: { code: "validation_error" } });
  });

  it("refuses an authority the caller does not hold as a tool error", async () => {
    const c = ctx({ reject: new ChildRunError("child_authority_amplification", "tools") });

    const result = await spawnSubagentTool.handler(ARGS, c);

    expect(result).toMatchObject({ success: false, error: { code: "validation_error" } });
  });

  it.each([
    ["missing instructions", { name: "x", task: "t" }],
    ["empty instructions", { name: "x", instructions: "", task: "t" }],
    ["missing task", { name: "x", instructions: "i" }],
    ["unknown property", { ...ARGS, escalate: true }],
  ])("rejects %s before spawning anything", async (_label, args) => {
    const c = ctx();

    const result = await spawnSubagentTool.handler(args, c);

    expect(result).toMatchObject({ success: false, error: { code: "validation_error" } });
    expect(c.spawnSubagent).not.toHaveBeenCalled();
  });

  it("is declared mutating and under its own authorization action", async () => {
    // Sharing `platform.agent.delegate` would let a grant to use audited helpers confer the power
    // to invent unaudited ones.
    expect(spawnSubagentTool.mutating).toBe(true);
    expect(spawnSubagentTool.authorization?.action).toBe("platform.agent.spawn");
  });
});
