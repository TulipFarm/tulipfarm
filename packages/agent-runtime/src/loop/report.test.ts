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
 * The QA journey that found #429: Content Drafter presented a "Draft blocked" Alert saying it had
 * not created a post Record, then created one in the same Turn. The card is durable, so the reader
 * keeps a report authored before the effect it denies.
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

function scriptedModel(...results: readonly ModelInvocationResult[]): ModelPort & {
  requests: number;
} {
  const queue = [...results];
  const port = {
    requests: 0,
    invoke: async (_request: ModelInvocationRequest) => {
      port.requests += 1;
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

/** Content Drafter's catalog: the Knowledge read, the report Tools, and the Record write. */
const DRAFTER_CATALOG = [
  { name: "query_knowledge", inputSchema: { type: "object" }, mutating: false },
  { name: "present", inputSchema: { type: "object" }, mutating: false },
  { name: "update_presentation", inputSchema: { type: "object" }, mutating: false },
  { name: "record_get", inputSchema: { type: "object" }, mutating: false },
  { name: "record_create", inputSchema: { type: "object" }, mutating: true },
];

function drafterInput(overrides: Partial<AgentLoopInput> = {}): AgentLoopInput {
  return {
    businessId: "biz-1",
    runId: "run-1",
    stateId: "state-1",
    modelProfileId: "primary",
    contextDigest: "sha256:context",
    guardrailDigest: "sha256:guardrail",
    messages: [
      { role: "user", content: textContent("draft one Instagram post and tell me its Record id") },
    ],
    tools: DRAFTER_CATALOG,
    limits: { maxIterations: 8, maxToolCalls: 8, maxRepairAttempts: 2 },
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

const BLOCKED_CARD = {
  callId: "call-2",
  name: "present",
  arguments: {
    component: {
      name: "Alert",
      version: "1.0",
      props: {
        severity: "warning",
        title: "Draft blocked",
        message:
          "I couldn't retrieve the required qa-journeys-s8 Brand Voice Guide. Following my " +
          "workflow, I did not draft or create a post Record, so there is no Record identifier.",
      },
    },
  },
};

describe("AgentLoop report-before-effect barrier", () => {
  it("stops a Turn that writes after presenting its report to the participant", async () => {
    const events: AgentLoopEvent[] = [];
    const tools = dispatcher(
      { status: "succeeded", callId: "call-1", output: { hits: [] } },
      { status: "succeeded", callId: "call-2", output: { artifact: { id: "artifact-1" } } },
      { status: "succeeded", callId: "call-3", output: { id: "post-1" } },
      { status: "succeeded", callId: "call-4", output: { id: "post-1" } }
    );
    const model = scriptedModel(
      toolCallResult([{ callId: "call-1", name: "query_knowledge", arguments: { q: "brand" } }]),
      toolCallResult([BLOCKED_CARD]),
      toolCallResult([
        { callId: "call-3", name: "record_create", arguments: { type: "qa-journeys-s8-post" } },
      ]),
      toolCallResult([{ callId: "call-4", name: "record_get", arguments: { id: "post-1" } }]),
      textResult("The draft is blocked; there is no Record identifier.")
    );

    const outcome = await loop(model, tools, events).run(drafterInput());

    expect(outcome).toMatchObject({ status: "failed", reason: "effect_after_report" });
    // The write never reaches the broker, so no Record can outlive the card that denied it.
    expect(tools.calls.map((call) => call.name)).toEqual(["query_knowledge", "present"]);
    // No repair path: the model is never asked to explain the refusal away.
    expect(model.requests).toBe(3);
    expect(events.find((event) => event.type === "tool_call_rejected")?.outcome).toBe(
      "effect_after_report"
    );
  });

  it("leaves a Turn that writes before it reports untouched", async () => {
    const events: AgentLoopEvent[] = [];
    const tools = dispatcher(
      { status: "succeeded", callId: "call-1", output: { id: "post-1" } },
      { status: "succeeded", callId: "call-2", output: { artifact: { id: "artifact-1" } } }
    );
    const model = scriptedModel(
      toolCallResult([
        { callId: "call-1", name: "record_create", arguments: { type: "qa-journeys-s8-post" } },
      ]),
      toolCallResult([
        {
          callId: "call-2",
          name: "present",
          arguments: {
            component: { name: "Alert", version: "1.0", props: { message: "Drafted" } },
          },
        },
      ]),
      textResult("Drafted as post-1, pending approval.")
    );

    const outcome = await loop(model, tools, events).run(drafterInput());

    expect(outcome).toMatchObject({ status: "completed" });
    expect(tools.calls.map((call) => call.name)).toEqual(["record_create", "present"]);
  });

  it("still lets a reported Turn keep reading", async () => {
    const events: AgentLoopEvent[] = [];
    const tools = dispatcher(
      { status: "succeeded", callId: "call-1", output: { artifact: { id: "artifact-1" } } },
      { status: "succeeded", callId: "call-2", output: { id: "post-1" } }
    );
    const model = scriptedModel(
      toolCallResult([
        {
          callId: "call-1",
          name: "present",
          arguments: {
            component: { name: "Alert", version: "1.0", props: { message: "Blocked" } },
          },
        },
      ]),
      toolCallResult([{ callId: "call-2", name: "record_get", arguments: { id: "post-1" } }]),
      textResult("Nothing was drafted.")
    );

    const outcome = await loop(model, tools, events).run(drafterInput());

    expect(outcome).toMatchObject({ status: "completed" });
    expect(tools.calls.map((call) => call.name)).toEqual(["present", "record_get"]);
  });
});
