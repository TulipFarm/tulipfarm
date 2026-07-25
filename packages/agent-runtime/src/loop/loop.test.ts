import { describe, expect, it } from "vitest";
import type { ModelInvocationResult, ModelPort } from "../ports";
import { InMemoryLoopCheckpointStore } from "./checkpoint";
import {
  AgentLoop,
  type AgentLoopEvent,
  type AgentLoopInput,
  type ToolDispatchPort,
  type ToolDispatchResult,
} from "./loop";

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
    invoke: async () => {
      port.requests += 1;
      const next = queue.shift();
      if (next === undefined) throw new Error("model called more times than scripted");
      return next;
    },
  };
  return port;
}

function dispatcher(...results: readonly ToolDispatchResult[]): ToolDispatchPort & {
  calls: { name: string; arguments: unknown }[];
} {
  const queue = [...results];
  const port = {
    calls: [] as { name: string; arguments: unknown }[],
    dispatch: async (call: { name: string; arguments: unknown }) => {
      port.calls.push({ name: call.name, arguments: call.arguments });
      return queue.shift() ?? { status: "succeeded" as const, callId: "call-1", output: {} };
    },
  };
  return port;
}

function input(overrides: Partial<AgentLoopInput> = {}): AgentLoopInput {
  return {
    businessId: "biz-1",
    runId: "run-1",
    stateId: "state-1",
    modelProfileId: "primary",
    contextDigest: "sha256:context",
    guardrailDigest: "sha256:guardrail",
    messages: [{ role: "user", content: "triage the issue" }],
    tools: [{ name: "github.issue.comment", inputSchema: { type: "object", required: ["body"] } }],
    limits: { maxIterations: 5, maxToolCalls: 3, maxRepairAttempts: 2 },
    ...overrides,
  };
}

function collector() {
  const events: AgentLoopEvent[] = [];
  return {
    events,
    sink: {
      append: async (event: AgentLoopEvent) => {
        events.push(event);
      },
    },
  };
}

function loop(options: {
  model: ModelPort;
  tools?: ToolDispatchPort;
  checkpoints?: InMemoryLoopCheckpointStore;
  events?: { append: (event: AgentLoopEvent) => Promise<void> };
  budget?: { consume: (input: { key: string; amount: number }) => Promise<{ outcome: string }> };
  cancelled?: () => Promise<boolean>;
}) {
  return new AgentLoop({
    model: options.model,
    tools: options.tools ?? dispatcher(),
    checkpoints: options.checkpoints ?? new InMemoryLoopCheckpointStore(),
    events: options.events ?? collector().sink,
    budget: options.budget ?? { consume: async () => ({ outcome: "allowed" }) },
    isCancelled: options.cancelled ?? (async () => false),
  });
}

describe("AgentLoop", () => {
  it("returns the model answer without dispatching a Tool", async () => {
    const tools = dispatcher();
    const outcome = await loop({ model: scriptedModel(textResult("done")), tools }).run(input());

    expect(outcome).toMatchObject({ status: "completed", iterations: 1, toolCalls: 0 });
    expect(tools.calls).toEqual([]);
  });

  it("routes every Tool call through the broker dispatcher and feeds results back", async () => {
    const tools = dispatcher({ status: "succeeded", callId: "call-1", output: { ok: true } });
    const outcome = await loop({
      model: scriptedModel(
        toolCallResult([
          { callId: "call-1", name: "github.issue.comment", arguments: { body: "hi" } },
        ]),
        textResult("commented")
      ),
      tools,
    }).run(input());

    expect(tools.calls).toEqual([{ name: "github.issue.comment", arguments: { body: "hi" } }]);
    expect(outcome).toMatchObject({ status: "completed", toolCalls: 1, iterations: 2 });
  });

  it("feeds a denial back as data and never retries the denied call itself", async () => {
    const tools = dispatcher({
      status: "denied",
      callId: "call-1",
      reason: "authorization_denied",
    });
    const outcome = await loop({
      model: scriptedModel(
        toolCallResult([
          { callId: "call-1", name: "github.issue.comment", arguments: { body: "hi" } },
        ]),
        textResult("cannot do that")
      ),
      tools,
    }).run(input());

    expect(tools.calls).toHaveLength(1);
    expect(outcome).toMatchObject({ status: "completed" });
  });

  it("repairs a malformed Tool call within the repair budget", async () => {
    const tools = dispatcher(
      { status: "invalid_arguments", callId: "call-1", reason: "invalid_arguments" },
      { status: "succeeded", callId: "call-2", output: {} }
    );
    const outcome = await loop({
      model: scriptedModel(
        toolCallResult([{ callId: "call-1", name: "github.issue.comment", arguments: {} }]),
        toolCallResult([
          { callId: "call-2", name: "github.issue.comment", arguments: { body: "hi" } },
        ]),
        textResult("fixed")
      ),
      tools,
    }).run(input());

    expect(outcome).toMatchObject({ status: "completed", repairs: 1 });
  });

  it("fails closed once the repair budget is spent", async () => {
    const tools = dispatcher(
      { status: "invalid_arguments", callId: "call-1", reason: "invalid_arguments" },
      { status: "invalid_arguments", callId: "call-2", reason: "invalid_arguments" },
      { status: "invalid_arguments", callId: "call-3", reason: "invalid_arguments" }
    );
    const outcome = await loop({
      model: scriptedModel(
        toolCallResult([{ callId: "call-1", name: "github.issue.comment", arguments: {} }]),
        toolCallResult([{ callId: "call-2", name: "github.issue.comment", arguments: {} }]),
        toolCallResult([{ callId: "call-3", name: "github.issue.comment", arguments: {} }])
      ),
      tools,
    }).run(input());

    expect(outcome).toMatchObject({ status: "failed", reason: "repair_budget_exhausted" });
  });

  it("normalizes a provider that omits or repeats a call id", async () => {
    const tools = dispatcher({ status: "succeeded", callId: "call-1", output: {} });
    const outcome = await loop({
      model: scriptedModel(
        toolCallResult([
          { callId: "", name: "github.issue.comment", arguments: { body: "a" } },
          { callId: "", name: "github.issue.comment", arguments: { body: "b" } },
        ]),
        textResult("done")
      ),
      tools,
    }).run(input());

    expect(tools.calls).toHaveLength(2);
    expect(outcome).toMatchObject({ status: "completed", toolCalls: 2 });
  });

  it("denies a Tool the caller never exposed to the model", async () => {
    const tools = dispatcher();
    const outcome = await loop({
      model: scriptedModel(
        toolCallResult([{ callId: "call-1", name: "shell.exec", arguments: {} }]),
        textResult("ok")
      ),
      tools,
    }).run(input());

    expect(tools.calls).toEqual([]);
    expect(outcome).toMatchObject({ status: "completed" });
  });

  it("stops at the iteration limit instead of looping forever", async () => {
    const outcome = await loop({
      model: scriptedModel(
        toolCallResult([{ callId: "c1", name: "github.issue.comment", arguments: { body: "1" } }]),
        toolCallResult([{ callId: "c2", name: "github.issue.comment", arguments: { body: "2" } }])
      ),
      tools: dispatcher(
        { status: "succeeded", callId: "c1", output: {} },
        { status: "succeeded", callId: "c2", output: {} }
      ),
    }).run(input({ limits: { maxIterations: 2, maxToolCalls: 9, maxRepairAttempts: 2 } }));

    expect(outcome).toMatchObject({ status: "failed", reason: "iteration_limit" });
  });

  it("stops at the Tool-call limit", async () => {
    const outcome = await loop({
      model: scriptedModel(
        toolCallResult([{ callId: "c1", name: "github.issue.comment", arguments: { body: "1" } }]),
        toolCallResult([{ callId: "c2", name: "github.issue.comment", arguments: { body: "2" } }])
      ),
      tools: dispatcher(
        { status: "succeeded", callId: "c1", output: {} },
        { status: "succeeded", callId: "c2", output: {} }
      ),
    }).run(input({ limits: { maxIterations: 9, maxToolCalls: 1, maxRepairAttempts: 2 } }));

    expect(outcome).toMatchObject({ status: "failed", reason: "tool_call_limit" });
  });

  it("stops when the durable budget is exhausted", async () => {
    const outcome = await loop({
      model: scriptedModel(textResult("done")),
      budget: { consume: async () => ({ outcome: "exhausted" }) },
    }).run(input());

    expect(outcome).toMatchObject({ status: "failed", reason: "budget_exhausted" });
  });

  it("yields cancellation before calling the model again", async () => {
    const model = scriptedModel(
      toolCallResult([{ callId: "c1", name: "github.issue.comment", arguments: { body: "1" } }])
    );
    let checks = 0;
    const outcome = await loop({
      model,
      tools: dispatcher({ status: "succeeded", callId: "c1", output: {} }),
      cancelled: async () => {
        checks += 1;
        return checks > 1;
      },
    }).run(input());

    expect(outcome).toMatchObject({ status: "cancelled" });
    expect(model.requests).toBe(1);
  });

  it("yields a durable wait when a Tool call needs Approval", async () => {
    const outcome = await loop({
      model: scriptedModel(
        toolCallResult([{ callId: "c1", name: "github.issue.comment", arguments: { body: "1" } }])
      ),
      tools: dispatcher({ status: "awaiting_approval", callId: "c1", approvalId: "appr-1" }),
    }).run(input());

    expect(outcome).toMatchObject({ status: "awaiting_approval", approvalId: "appr-1" });
  });

  it("AJV-validates structured output and repairs an invalid one", async () => {
    const outcome = await loop({
      model: scriptedModel(
        {
          requestId: "req",
          output: { kind: "structured", value: { label: 5 } },
          usage: { inputTokens: 1, outputTokens: 1 },
        },
        {
          requestId: "req",
          output: { kind: "structured", value: { label: "bug" } },
          usage: { inputTokens: 1, outputTokens: 1 },
        }
      ),
    }).run(
      input({
        outputSchema: {
          type: "object",
          required: ["label"],
          properties: { label: { type: "string" } },
        },
      })
    );

    expect(outcome).toMatchObject({ status: "completed", output: { label: "bug" }, repairs: 1 });
  });

  it("resumes from the persisted checkpoint after a crash rather than restarting limits", async () => {
    const checkpoints = new InMemoryLoopCheckpointStore();
    await checkpoints.save({
      businessId: "biz-1",
      runId: "run-1",
      stateId: "state-1",
      iterations: 2,
      toolCalls: 2,
      repairs: 0,
    });

    const outcome = await loop({
      model: scriptedModel(
        toolCallResult([{ callId: "c1", name: "github.issue.comment", arguments: { body: "1" } }])
      ),
      tools: dispatcher({ status: "succeeded", callId: "c1", output: {} }),
      checkpoints,
    }).run(input({ limits: { maxIterations: 9, maxToolCalls: 2, maxRepairAttempts: 2 } }));

    expect(outcome).toMatchObject({ status: "failed", reason: "tool_call_limit" });
  });

  it("emits durable, content-free loop events for stream recovery", async () => {
    const events = collector();
    await loop({
      model: scriptedModel(
        toolCallResult([
          { callId: "c1", name: "github.issue.comment", arguments: { body: "s3cret" } },
        ]),
        textResult("done")
      ),
      tools: dispatcher({ status: "succeeded", callId: "c1", output: {} }),
      events: events.sink,
    }).run(input());

    expect(events.events.map((event) => event.type)).toEqual([
      "iteration_started",
      "tool_call_dispatched",
      "iteration_started",
      "completed",
    ]);
    expect(events.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(JSON.stringify(events.events)).not.toContain("s3cret");
  });
});
