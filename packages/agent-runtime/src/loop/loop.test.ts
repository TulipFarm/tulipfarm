import { describe, expect, it, vi } from "vitest";
import type {
  ModelInvocationRequest,
  ModelInvocationResult,
  ModelPort,
  ModelStreamChunk,
} from "../ports";
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

/**
 * A model that streams `deltas` and then reports `result`. Mirrors a real adapter: text arrives in
 * pieces, and the same outcome a non-streaming call would return lands in the final chunk.
 */
function streamingModel(
  deltas: readonly string[],
  result: ModelInvocationResult
): ModelPort & { invoked: number; streamed: number } {
  const port = {
    invoked: 0,
    streamed: 0,
    invoke: async () => {
      port.invoked += 1;
      return result;
    },
    stream: async function* (): AsyncIterable<ModelStreamChunk> {
      port.streamed += 1;
      for (const text of deltas) yield { kind: "text_delta" as const, text };
      yield { kind: "completed" as const, result };
    },
  };
  return port;
}

/** Like `scriptedModel`, but records each request's offered Tool names for narrowing assertions. */
function recordingModel(...results: readonly ModelInvocationResult[]): ModelPort & {
  requests: number;
  toolNamesByRequest: string[][];
} {
  const queue = [...results];
  const port = {
    requests: 0,
    toolNamesByRequest: [] as string[][],
    invoke: async (request: ModelInvocationRequest) => {
      port.requests += 1;
      port.toolNamesByRequest.push((request.tools ?? []).map((t) => t.name));
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
  log?: { warn(obj: unknown, msg?: string): void };
}) {
  return new AgentLoop({
    model: options.model,
    tools: options.tools ?? dispatcher(),
    checkpoints: options.checkpoints ?? new InMemoryLoopCheckpointStore(),
    events: options.events ?? collector().sink,
    budget: options.budget ?? { consume: async () => ({ outcome: "allowed" }) },
    isCancelled: options.cancelled ?? (async () => false),
    ...(options.log === undefined ? {} : { log: options.log }),
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

  it("retries a blank final completion within the repair budget", async () => {
    const outcome = await loop({
      model: scriptedModel(textResult(""), textResult("here you go")),
    }).run(input());

    expect(outcome).toMatchObject({ status: "completed", output: "here you go", repairs: 1 });
  });

  it("fails closed as empty_model_output once the repair budget is spent on blank completions", async () => {
    const outcome = await loop({
      model: scriptedModel(textResult(""), textResult(""), textResult("")),
    }).run(input({ limits: { maxIterations: 5, maxToolCalls: 3, maxRepairAttempts: 2 } }));

    expect(outcome).toMatchObject({ status: "failed", reason: "empty_model_output", repairs: 3 });
  });

  it("logs a diagnostic warning when the model returns a blank final completion", async () => {
    const warn = vi.fn();
    await loop({
      model: scriptedModel(textResult(""), textResult("done")),
      log: { warn },
    }).run(input());

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "agent_loop.empty_completion" }),
      expect.any(String)
    );
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

  it("charges token and priced cost budgets after a model call reports usage", async () => {
    const charges: { key: string; amount: number }[] = [];
    const outcome = await loop({
      model: scriptedModel({
        ...textResult("done"),
        usage: { inputTokens: 7, outputTokens: 3, costUsd: 0.0000001 },
      }),
      budget: {
        consume: async (charge) => {
          charges.push(charge);
          return { outcome: "allowed" };
        },
      },
    }).run(input());

    expect(outcome).toMatchObject({ status: "completed" });
    expect(charges).toEqual([
      { key: "iterations", amount: 1 },
      { key: "tokens", amount: 10 },
      { key: "costMicros", amount: 1 },
    ]);
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

  it("emits ordered text deltas while a streaming model is still answering", async () => {
    const events = collector();
    const model = streamingModel(["Hel", "lo ", "there"], textResult("Hello there"));

    const outcome = await loop({ model, events: events.sink }).run(input());

    expect(model.streamed).toBe(1);
    expect(model.invoked).toBe(0);
    expect(outcome).toMatchObject({ status: "completed", output: "Hello there" });

    const deltas = events.events.filter((event) => event.type === "text_delta");
    expect(deltas.map((event) => event.text)).toEqual(["Hel", "lo ", "there"]);
    expect(deltas.map((event) => event.textIndex)).toEqual([1, 2, 3]);
    // Deltas share the one monotonic sequence, so a reader resuming by cursor sees them in place.
    expect(deltas.map((event) => event.sequence)).toEqual([2, 3, 4]);
  });

  it("falls back to invoke when the adapter cannot stream", async () => {
    const events = collector();
    const outcome = await loop({
      model: scriptedModel(textResult("done")),
      events: events.sink,
    }).run(input());

    expect(outcome).toMatchObject({ status: "completed", output: "done" });
    expect(events.events.some((event) => event.type === "text_delta")).toBe(false);
  });

  it("skips empty deltas so a reader never sees a no-op chunk", async () => {
    const events = collector();
    const model = streamingModel(["", "done", ""], textResult("done"));

    await loop({ model, events: events.sink }).run(input());

    const deltas = events.events.filter((event) => event.type === "text_delta");
    expect(deltas.map((event) => event.text)).toEqual(["done"]);
    expect(deltas.map((event) => event.textIndex)).toEqual([1]);
  });

  it("fails the turn when a stream ends without a result", async () => {
    const model: ModelPort = {
      invoke: async () => textResult("unused"),
      stream: async function* (): AsyncIterable<ModelStreamChunk> {
        yield { kind: "text_delta", text: "partial" };
      },
    };

    const outcome = await loop({ model }).run(input());

    // A truncated stream is a broken adapter, not an empty answer — never completed with "partial".
    expect(outcome).toMatchObject({ status: "failed", reason: "model_error" });
  });

  it("numbers deltas continuously across iterations", async () => {
    const events = collector();
    const queue = [
      {
        deltas: ["thinking"],
        result: toolCallResult([
          { callId: "c1", name: "github.issue.comment", arguments: { body: "hi" } },
        ]),
      },
      { deltas: ["all ", "done"], result: textResult("all done") },
    ];
    const model: ModelPort = {
      invoke: async () => textResult("unused"),
      stream: async function* (): AsyncIterable<ModelStreamChunk> {
        const next = queue.shift();
        if (next === undefined) throw new Error("model streamed more times than scripted");
        for (const text of next.deltas) yield { kind: "text_delta" as const, text };
        yield { kind: "completed" as const, result: next.result };
      },
    };

    await loop({
      model,
      tools: dispatcher({ status: "succeeded", callId: "c1", output: {} }),
      events: events.sink,
    }).run(input());

    const deltas = events.events.filter((event) => event.type === "text_delta");
    expect(deltas.map((event) => event.text)).toEqual(["thinking", "all ", "done"]);
    expect(deltas.map((event) => event.textIndex)).toEqual([1, 2, 3]);
  });
});

describe("AgentLoop concurrent dispatch", () => {
  const readTools = [
    { name: "github.issue.search", inputSchema: { type: "object" }, mutating: false },
    { name: "github.pull_request.search", inputSchema: { type: "object" }, mutating: false },
  ];

  /** Tracks in-flight dispatches so a test can prove two calls overlapped rather than serialized. */
  function trackingDispatcher(delayMs = 5): ToolDispatchPort & {
    calls: string[];
    maxConcurrent: number;
  } {
    let inFlight = 0;
    const port = {
      calls: [] as string[],
      maxConcurrent: 0,
      dispatch: async (call: { callId: string; name: string; arguments: unknown }) => {
        port.calls.push(call.name);
        inFlight += 1;
        port.maxConcurrent = Math.max(port.maxConcurrent, inFlight);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        inFlight -= 1;
        return { status: "succeeded" as const, callId: call.callId, output: {} };
      },
    };
    return port;
  }

  it("dispatches consecutive non-mutating Tool calls concurrently", async () => {
    const tools = trackingDispatcher();
    const outcome = await loop({
      model: scriptedModel(
        toolCallResult([
          { callId: "c1", name: "github.issue.search", arguments: {} },
          { callId: "c2", name: "github.pull_request.search", arguments: {} },
        ]),
        textResult("done")
      ),
      tools,
    }).run(
      input({
        tools: readTools,
        limits: { maxIterations: 5, maxToolCalls: 5, maxRepairAttempts: 2 },
      })
    );

    expect(outcome).toMatchObject({ status: "completed", toolCalls: 2 });
    expect(tools.maxConcurrent).toBe(2);
  });

  it("keeps mutating Tool calls strictly sequential even when interleaved with reads", async () => {
    const tools = trackingDispatcher();
    const mixedTools = [
      ...readTools,
      { name: "github.issue.comment", inputSchema: { type: "object" }, mutating: true },
    ];
    const outcome = await loop({
      model: scriptedModel(
        toolCallResult([
          { callId: "c1", name: "github.issue.comment", arguments: { body: "1" } },
          { callId: "c2", name: "github.issue.comment", arguments: { body: "2" } },
        ]),
        textResult("done")
      ),
      tools,
    }).run(
      input({
        tools: mixedTools,
        limits: { maxIterations: 5, maxToolCalls: 5, maxRepairAttempts: 2 },
      })
    );

    expect(outcome).toMatchObject({ status: "completed", toolCalls: 2 });
    expect(tools.maxConcurrent).toBe(1);
  });

  it("stops at the exact Tool-call limit when a parallel batch would exceed it", async () => {
    const tools = dispatcher(
      { status: "succeeded", callId: "c1", output: {} },
      { status: "succeeded", callId: "c2", output: {} }
    );
    const outcome = await loop({
      model: scriptedModel(
        toolCallResult([
          { callId: "c1", name: "github.issue.search", arguments: {} },
          { callId: "c2", name: "github.pull_request.search", arguments: {} },
        ])
      ),
      tools,
    }).run(
      input({
        tools: readTools,
        limits: { maxIterations: 9, maxToolCalls: 1, maxRepairAttempts: 2 },
      })
    );

    expect(outcome).toMatchObject({ status: "failed", reason: "tool_call_limit" });
    expect(tools.calls).toHaveLength(1);
  });

  it("still fails closed on the repair budget when an invalid call lands inside a parallel batch", async () => {
    const tools = dispatcher(
      { status: "succeeded", callId: "c1", output: {} },
      { status: "invalid_arguments", callId: "c2", reason: "invalid_arguments" },
      { status: "invalid_arguments", callId: "c3", reason: "invalid_arguments" },
      { status: "invalid_arguments", callId: "c4", reason: "invalid_arguments" }
    );
    const outcome = await loop({
      model: scriptedModel(
        toolCallResult([
          { callId: "c1", name: "github.issue.search", arguments: {} },
          { callId: "c2", name: "github.pull_request.search", arguments: {} },
        ]),
        toolCallResult([{ callId: "c3", name: "github.issue.search", arguments: {} }]),
        toolCallResult([{ callId: "c4", name: "github.issue.search", arguments: {} }])
      ),
      tools,
    }).run(
      input({
        tools: readTools,
        limits: { maxIterations: 9, maxToolCalls: 9, maxRepairAttempts: 2 },
      })
    );

    expect(outcome).toMatchObject({ status: "failed", reason: "repair_budget_exhausted" });
  });
});

describe("AgentLoop skill-scoped tool narrowing", () => {
  const catalog = [
    { name: "load_skill", inputSchema: { type: "object" } },
    { name: "complete_task", inputSchema: { type: "object" } },
    { name: "routine_forge", inputSchema: { type: "object" } },
    { name: "record_search", inputSchema: { type: "object" } },
    { name: "agent_list", inputSchema: { type: "object" } },
  ];

  it("offers the full catalog unchanged when no skillToolScopes is given", async () => {
    const model = recordingModel(textResult("done"));
    await loop({ model }).run(input({ tools: catalog }));

    expect(model.toolNamesByRequest[0]).toEqual(catalog.map((t) => t.name));
  });

  it("narrows to a Skill's declared tools (plus the always-exposed baseline) after load_skill succeeds", async () => {
    const tools = dispatcher({
      status: "succeeded",
      callId: "call-1",
      output: { name: "routine-forge" },
    });
    const model = recordingModel(
      toolCallResult([
        { callId: "call-1", name: "load_skill", arguments: { name: "routine-forge" } },
      ]),
      textResult("done")
    );
    const outcome = await loop({ model, tools }).run(
      input({
        tools: catalog,
        skillToolScopes: new Map([["routine-forge", ["routine_forge"]]]),
      })
    );

    expect(outcome).toMatchObject({ status: "completed" });
    // Iteration 1 (before load_skill resolves) still sees everything.
    expect(model.toolNamesByRequest[0]).toEqual(catalog.map((t) => t.name));
    // Iteration 2 is narrowed to the declared scope plus the always-exposed baseline.
    expect(model.toolNamesByRequest[1]).toEqual(
      expect.arrayContaining(["load_skill", "complete_task", "routine_forge"])
    );
    expect(model.toolNamesByRequest[1]).not.toContain("record_search");
    expect(model.toolNamesByRequest[1]).not.toContain("agent_list");
  });

  it("does not narrow when the active Skill has no declared scope", async () => {
    const tools = dispatcher({
      status: "succeeded",
      callId: "call-1",
      output: { name: "no-scope-skill" },
    });
    const model = recordingModel(
      toolCallResult([
        { callId: "call-1", name: "load_skill", arguments: { name: "no-scope-skill" } },
      ]),
      textResult("done")
    );
    await loop({ model, tools }).run(
      input({
        tools: catalog,
        skillToolScopes: new Map([["routine-forge", ["routine_forge"]]]),
      })
    );

    expect(model.toolNamesByRequest[1]).toEqual(catalog.map((t) => t.name));
  });

  it("replaces rather than unions the scope when the model switches Skills mid-turn", async () => {
    const tools = dispatcher(
      { status: "succeeded", callId: "call-1", output: { name: "routine-forge" } },
      { status: "succeeded", callId: "call-2", output: { name: "agent-forge" } }
    );
    const model = recordingModel(
      toolCallResult([
        { callId: "call-1", name: "load_skill", arguments: { name: "routine-forge" } },
      ]),
      toolCallResult([
        { callId: "call-2", name: "load_skill", arguments: { name: "agent-forge" } },
      ]),
      textResult("done")
    );
    await loop({ model, tools }).run(
      input({
        tools: catalog,
        skillToolScopes: new Map([
          ["routine-forge", ["routine_forge"]],
          ["agent-forge", ["agent_list"]],
        ]),
      })
    );

    expect(model.toolNamesByRequest[2]).toEqual(
      expect.arrayContaining(["load_skill", "complete_task", "agent_list"])
    );
    expect(model.toolNamesByRequest[2]).not.toContain("routine_forge");
  });

  it("still authorizes dispatch of a Tool the narrowed offer excluded (narrowing is not a security boundary)", async () => {
    const tools = dispatcher(
      { status: "succeeded", callId: "call-1", output: { name: "routine-forge" } },
      { status: "succeeded", callId: "call-2", output: { ok: true } }
    );
    const model = scriptedModel(
      toolCallResult([
        { callId: "call-1", name: "load_skill", arguments: { name: "routine-forge" } },
      ]),
      toolCallResult([{ callId: "call-2", name: "record_search", arguments: {} }]),
      textResult("done")
    );
    const outcome = await loop({ model, tools }).run(
      input({
        tools: catalog,
        skillToolScopes: new Map([["routine-forge", ["routine_forge"]]]),
      })
    );

    expect(outcome).toMatchObject({ status: "completed" });
    expect(tools.calls.map((c) => c.name)).toEqual(["load_skill", "record_search"]);
  });
});
