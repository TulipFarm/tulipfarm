import { textContent } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import type { ModelInvocationRequest, ModelInvocationResult, ModelPort } from "../ports";
import { InMemoryLoopCheckpointStore } from "./checkpoint";
import type {
  AgentLoopEvent,
  AgentLoopInput,
  ToolDispatchPort,
  ToolDispatchResult,
} from "./contract";
import { AgentLoop } from "./loop";

/**
 * The QA journey that found #419: `@support-triage <a bug report>` narrated a hand-off, filed no
 * Ticket, and still ended `completed`. The same Agent in the same session answered a knowledge
 * question correctly, so the harness failed along the read/write boundary. These Cases pin both
 * halves of that: an impossible hand-off stops the Turn, and a read Skill does not take the
 * write away.
 */

function textResult(text: string): ModelInvocationResult {
  return {
    requestId: "req",
    output: { kind: "text", text },
    usage: { inputTokens: 5, outputTokens: 5 },
  };
}

function toolCallResult(
  calls: readonly { callId: string; name: string; arguments: unknown }[]
): ModelInvocationResult {
  return {
    requestId: "req",
    output: { kind: "tool_calls", calls },
    usage: { inputTokens: 5, outputTokens: 5 },
  };
}

/** Records the Tool names each request offered, so narrowing is asserted per iteration. */
function recordingModel(...results: readonly ModelInvocationResult[]): ModelPort & {
  toolNamesByRequest: string[][];
} {
  const queue = [...results];
  const port = {
    toolNamesByRequest: [] as string[][],
    invoke: async (request: ModelInvocationRequest) => {
      port.toolNamesByRequest.push((request.tools ?? []).map((tool) => tool.name));
      const next = queue.shift();
      if (next === undefined) throw new Error("model called more times than scripted");
      return next;
    },
  };
  return port;
}

function dispatcher(...results: readonly ToolDispatchResult[]): ToolDispatchPort & {
  calls: { name: string }[];
} {
  const queue = [...results];
  const port = {
    calls: [] as { name: string }[],
    dispatch: async (call: { name: string }) => {
      port.calls.push({ name: call.name });
      return queue.shift() ?? { status: "succeeded" as const, callId: "call-1", output: {} };
    },
  };
  return port;
}

/** The Support Triage Agent's catalog: reads, plus the one write that files a Ticket. */
const TRIAGE_CATALOG = [
  { name: "load_skill", inputSchema: { type: "object" }, mutating: false },
  { name: "query_knowledge", inputSchema: { type: "object" }, mutating: false },
  { name: "record_create", inputSchema: { type: "object" }, mutating: true },
  { name: "present", inputSchema: { type: "object" }, mutating: false },
];

/** `knowledge-research`'s shipped `tools:` frontmatter — every entry a read. */
const SKILL_SCOPES = new Map([["knowledge-research", ["query_knowledge"]]]);

function triageInput(overrides: Partial<AgentLoopInput> = {}): AgentLoopInput {
  return {
    businessId: "biz-1",
    runId: "run-1",
    stateId: "state-1",
    modelProfileId: "primary",
    contextDigest: "sha256:context",
    guardrailDigest: "sha256:guardrail",
    messages: [{ role: "user", content: textContent("the export button opens a blank page") }],
    tools: TRIAGE_CATALOG,
    skillToolScopes: SKILL_SCOPES,
    limits: { maxIterations: 6, maxToolCalls: 6, maxRepairAttempts: 2 },
    ...overrides,
  };
}

function loop(model: ModelPort, tools: ToolDispatchPort, events: AgentLoopEvent[]): AgentLoop {
  return new AgentLoop({
    model,
    tools,
    checkpoints: new InMemoryLoopCheckpointStore(),
    events: {
      append: async (event: AgentLoopEvent) => {
        events.push(event);
      },
    },
    budget: { consume: async () => ({ outcome: "allowed" }) },
    isCancelled: async () => false,
  });
}

describe("AgentLoop hand-off barrier", () => {
  it("fails the Turn when the model reaches for a hand-off Tool nothing exposed", async () => {
    const events: AgentLoopEvent[] = [];
    const tools = dispatcher();
    const model = recordingModel(
      toolCallResult([
        { callId: "call-1", name: "transfer_to_agent", arguments: { agentId: "support-triage" } },
      ]),
      textResult("I've handed this to support-triage as an urgent, blocking issue.")
    );

    const outcome = await loop(model, tools, events).run(triageInput());

    expect(outcome).toMatchObject({ status: "failed", reason: "handoff_unavailable" });
    // The model is never asked again, so the narration it would have written cannot exist.
    expect(model.toolNamesByRequest).toHaveLength(1);
    expect(tools.calls).toEqual([]);
    expect(events.find((event) => event.type === "tool_call_rejected")?.outcome).toBe(
      "handoff_unavailable"
    );
  });

  it("still refuses an ordinary unexposed Tool as feedback rather than ending the Turn", async () => {
    const events: AgentLoopEvent[] = [];
    const model = recordingModel(
      toolCallResult([{ callId: "call-1", name: "send_invoice", arguments: {} }]),
      textResult("I cannot send invoices, but here is what I can do.")
    );

    const outcome = await loop(model, dispatcher(), events).run(triageInput());

    expect(outcome).toMatchObject({ status: "completed" });
  });
});

describe("AgentLoop Skill narrowing across the read/write boundary", () => {
  const loadResearch = { status: "succeeded" as const, callId: "call-1", output: {} };

  it("keeps the Skill's own read reachable after load_skill", async () => {
    const events: AgentLoopEvent[] = [];
    const tools = dispatcher(loadResearch, {
      status: "succeeded",
      callId: "call-2",
      output: { hits: [] },
    });
    const model = recordingModel(
      toolCallResult([
        { callId: "call-1", name: "load_skill", arguments: { name: "knowledge-research" } },
      ]),
      toolCallResult([{ callId: "call-2", name: "query_knowledge", arguments: {} }]),
      textResult("A reset link lasts 24 hours.")
    );

    const outcome = await loop(model, tools, events).run(triageInput());

    expect(outcome).toMatchObject({ status: "completed" });
    expect(model.toolNamesByRequest[1]).toContain("query_knowledge");
  });

  it("keeps the write reachable after a read Skill narrows the offer", async () => {
    const events: AgentLoopEvent[] = [];
    const tools = dispatcher(loadResearch, {
      status: "succeeded",
      callId: "call-2",
      output: { id: "ticket-1" },
    });
    const model = recordingModel(
      toolCallResult([
        { callId: "call-1", name: "load_skill", arguments: { name: "knowledge-research" } },
      ]),
      toolCallResult([
        { callId: "call-2", name: "record_create", arguments: { type: "ticket", kind: "bug" } },
      ]),
      textResult("Filed as a bug; I cannot estimate a fix date yet.")
    );

    const outcome = await loop(model, tools, events).run(triageInput());

    expect(outcome).toMatchObject({ status: "completed" });
    expect(model.toolNamesByRequest[1]).toContain("record_create");
    expect(tools.calls.map((call) => call.name)).toEqual(["load_skill", "record_create"]);
  });

  it("still hides a read the active Skill did not declare", async () => {
    const events: AgentLoopEvent[] = [];
    const model = recordingModel(
      toolCallResult([
        { callId: "call-1", name: "load_skill", arguments: { name: "knowledge-research" } },
      ]),
      textResult("done")
    );

    await loop(model, dispatcher(loadResearch), events).run(
      triageInput({
        tools: [
          ...TRIAGE_CATALOG,
          { name: "record_search", inputSchema: { type: "object" }, mutating: false },
        ],
      })
    );

    expect(model.toolNamesByRequest[1]).not.toContain("record_search");
  });
});
