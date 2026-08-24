import { contentText, textContent } from "@tulipfarm/schema";
import { describe, expect, it, vi } from "vitest";
import type {
  ModelInvocationRequest,
  ModelInvocationResult,
  ModelMessage,
  ModelPort,
  ModelStreamChunk,
} from "../ports";
import { ModelInvocationError } from "../ports";
import { InMemoryLoopCheckpointStore } from "./checkpoint";
import type {
  AgentLoopEvent,
  AgentLoopInput,
  LoopAttachmentPort,
  ToolDispatchPort,
  ToolDispatchRequest,
  ToolDispatchResult,
} from "./contract";
import type { ToolResultDistillerPort } from "./distill";
import { AgentLoop } from "./loop";

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

/** Like `scriptedModel`, but records the Files each request actually carried. */
function attachmentRecordingModel(...results: readonly ModelInvocationResult[]): ModelPort & {
  attachmentsByRequest: string[][];
} {
  const queue = [...results];
  const port = {
    attachmentsByRequest: [] as string[][],
    invoke: async (request: ModelInvocationRequest) => {
      port.attachmentsByRequest.push((request.attachments ?? []).map((file) => file.fileId));
      const next = queue.shift();
      if (next === undefined) throw new Error("model called more times than scripted");
      return next;
    },
  };
  return port;
}

/** A `file_read` result that asks for a File to be put in front of the model. */
function attachedFile(fileId: string, mediaType = "application/pdf"): ToolDispatchResult {
  return {
    status: "succeeded",
    callId: "call-1",
    output: { fileId, mediaType, filename: `${fileId}.pdf`, kind: "attached", attached: true },
  };
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
  calls: { name: string; arguments: unknown; activeSkillName?: string }[];
} {
  const queue = [...results];
  const port = {
    calls: [] as { name: string; arguments: unknown; activeSkillName?: string }[],
    dispatch: async (call: ToolDispatchRequest) => {
      port.calls.push({
        name: call.name,
        arguments: call.arguments,
        ...(call.activeSkillName === undefined ? {} : { activeSkillName: call.activeSkillName }),
      });
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
    messages: [{ role: "user", content: textContent("triage the issue") }],
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
  attachments?: LoopAttachmentPort;
  distiller?: ToolResultDistillerPort;
}) {
  return new AgentLoop({
    model: options.model,
    tools: options.tools ?? dispatcher(),
    checkpoints: options.checkpoints ?? new InMemoryLoopCheckpointStore(),
    events: options.events ?? collector().sink,
    budget: options.budget ?? { consume: async () => ({ outcome: "allowed" }) },
    isCancelled: options.cancelled ?? (async () => false),
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
    ...(options.distiller === undefined ? {} : { distiller: options.distiller }),
  });
}

describe("AgentLoop", () => {
  it("summarises a Tool result against the prompt the Agent wrote, not the words the person typed", async () => {
    // A follow-up Message is written for someone who has been reading along: "who wrote it?"
    // names no subject. The Agent resolves that into a self-contained prompt, and the Tool
    // carries it past itself to the summariser — which is the only thing that reads it.
    const asks: string[] = [];
    const distiller: ToolResultDistillerPort = {
      distill: async (request) => {
        asks.push(request.ask);
        return { summary: "Vicent Marti wrote it.", citations: [] };
      },
    };
    const tools = dispatcher({
      status: "succeeded",
      callId: "call-1",
      output: { url: "https://x.example", content: "By Vicent Marti. ".repeat(500) },
    });

    await loop({
      model: scriptedModel(
        toolCallResult([
          {
            callId: "call-1",
            name: "web_fetch",
            arguments: { url: "https://x.example", prompt: "who wrote this article?" },
          },
        ]),
        textResult("Vicent Marti.")
      ),
      tools,
      distiller,
    }).run(
      input({
        messages: [{ role: "user", content: textContent("who wrote it?") }],
        tools: [{ name: "web_fetch", inputSchema: { type: "object", required: ["url"] } }],
      })
    );

    expect(asks).toEqual(["who wrote this article?"]);
  });

  it("never summarises a result against the loop's own repair prompt", async () => {
    // A repair prompt is pushed onto the transcript as a `user` Message, so reading the live
    // transcript for "the latest ask" would summarise a page against the loop's own JSON.
    const asks: string[] = [];
    const distiller: ToolResultDistillerPort = {
      distill: async (request) => {
        asks.push(request.ask);
        return { summary: "It ships in September.", citations: [] };
      },
    };

    await loop({
      model: scriptedModel(
        { requestId: "req", output: { kind: "text", text: "" }, usage: {} },
        toolCallResult([
          { callId: "call-1", name: "web_fetch", arguments: { url: "https://x.example" } },
        ]),
        textResult("It ships in September.")
      ),
      tools: dispatcher({
        status: "succeeded",
        callId: "call-1",
        output: { url: "https://x.example", content: "Ships in September. ".repeat(500) },
      }),
      distiller,
    }).run(
      input({
        messages: [{ role: "user", content: textContent("when does it ship?") }],
        tools: [{ name: "web_fetch", inputSchema: { type: "object", required: ["url"] } }],
      })
    );

    expect(asks).toEqual(["when does it ship?"]);
  });

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
      { status: "invalid_arguments", callId: "call-1", reason: "body is required" },
      { status: "invalid_arguments", callId: "call-2", reason: "body must be a string" },
      { status: "invalid_arguments", callId: "call-3", reason: "body is too long" }
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

  it("stops repairing a rejection that does not move when the arguments do", async () => {
    const warn = vi.fn();
    const tools = dispatcher(
      { status: "invalid_arguments", callId: "call-1", reason: "the destination is unreachable" },
      { status: "invalid_arguments", callId: "call-2", reason: "the destination is unreachable" },
      { status: "invalid_arguments", callId: "call-3", reason: "the destination is unreachable" }
    );
    const outcome = await loop({
      model: scriptedModel(
        toolCallResult([
          { callId: "call-1", name: "github.issue.comment", arguments: { body: "a" } },
        ]),
        toolCallResult([
          { callId: "call-2", name: "github.issue.comment", arguments: { body: "b" } },
        ]),
        toolCallResult([
          { callId: "call-3", name: "github.issue.comment", arguments: { body: "c" } },
        ]),
        textResult("that destination cannot be reached")
      ),
      tools,
      log: { warn },
    }).run(input());

    // The third identical rejection is data, not a repair, so the Turn reports the obstacle
    // instead of dying on a budget it spent proving the answer would not change.
    expect(outcome).toMatchObject({ status: "completed", repairs: 2 });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "agent_loop.rejection_not_repairable",
        callId: "call-3",
        occurrences: 3,
      }),
      expect.any(String)
    );
  });

  it("keeps repairing when the same Tool rejects for a different reason each time", async () => {
    const tools = dispatcher(
      { status: "invalid_arguments", callId: "call-1", reason: "body is required" },
      { status: "invalid_arguments", callId: "call-2", reason: "body must be a string" },
      { status: "succeeded", callId: "call-3", output: {} }
    );
    const outcome = await loop({
      model: scriptedModel(
        toolCallResult([{ callId: "call-1", name: "github.issue.comment", arguments: {} }]),
        toolCallResult([
          { callId: "call-2", name: "github.issue.comment", arguments: { body: 1 } },
        ]),
        toolCallResult([
          { callId: "call-3", name: "github.issue.comment", arguments: { body: "hi" } },
        ]),
        textResult("fixed")
      ),
      tools,
    }).run(input());

    expect(outcome).toMatchObject({ status: "completed", repairs: 2 });
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

  it("charges what a failed model call already spent", async () => {
    const charges: { key: string; amount: number }[] = [];
    const outcome = await loop({
      model: {
        invoke: async () => {
          throw new ModelInvocationError("model_error", new Error("connection reset"), {
            inputTokens: 900,
            outputTokens: 40,
            costUsd: 0.000005,
            costBasis: "priced",
          });
        },
      },
      budget: {
        consume: async (charge) => {
          charges.push(charge);
          return { outcome: "allowed" };
        },
      },
    }).run(input());

    // A mid-stream failure is not a free call: the prompt was submitted and the partial answer
    // was generated and durably stored. Charging nothing let a Run that fails every iteration
    // spend without ever touching the ceiling that was supposed to stop it.
    expect(outcome).toMatchObject({ status: "failed", reason: "model_error" });
    expect(charges).toEqual([
      { key: "iterations", amount: 1 },
      { key: "tokens", amount: 940 },
      { key: "costMicros", amount: 5 },
    ]);
  });

  it("charges nothing for a failed call that reported no usage", async () => {
    const charges: { key: string; amount: number }[] = [];
    await loop({
      model: {
        invoke: async () => {
          throw new ModelInvocationError("model_provider_unavailable", new Error("refused"));
        },
      },
      budget: {
        consume: async (charge) => {
          charges.push(charge);
          return { outcome: "allowed" };
        },
      },
    }).run(input());

    expect(charges).toEqual([{ key: "iterations", amount: 1 }]);
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

  it("stops after request_input before asking the model to continue", async () => {
    const model = scriptedModel(
      toolCallResult([{ callId: "input-1", name: "request_input", arguments: { component: {} } }]),
      toolCallResult([{ callId: "create-1", name: "agent_create", arguments: {} }])
    );
    const tools = dispatcher({
      status: "succeeded",
      callId: "input-1",
      output: { suspendRun: true },
    });

    const outcome = await loop({ model, tools }).run(
      input({
        tools: [
          { name: "request_input", inputSchema: {}, mutating: true },
          { name: "agent_create", inputSchema: {}, mutating: true },
        ],
      })
    );

    expect(outcome).toMatchObject({ status: "input_required", callId: "input-1" });
    expect(model.requests).toBe(1);
    expect(tools.calls).toEqual([{ name: "request_input", arguments: { component: {} } }]);
  });

  it("ends the Turn when request_input reaches nobody, rather than letting the model proceed", async () => {
    const model = scriptedModel(
      toolCallResult([{ callId: "input-1", name: "request_input", arguments: { component: {} } }]),
      toolCallResult([{ callId: "create-1", name: "agent_create", arguments: {} }])
    );
    const tools = dispatcher({
      status: "failed",
      callId: "input-1",
      reason: "/props: must have required property 'choices'",
    });

    const outcome = await loop({ model, tools }).run(
      input({
        tools: [
          { name: "request_input", inputSchema: {}, mutating: true },
          { name: "agent_create", inputSchema: {}, mutating: true },
        ],
      })
    );

    expect(outcome).toMatchObject({ status: "failed", reason: "input_request_failed" });
    expect(model.requests).toBe(1);
    expect(tools.calls.map((call) => call.name)).toEqual(["request_input"]);
  });

  it("stops at a request_input whose result carries no suspend flag", async () => {
    const model = scriptedModel(
      toolCallResult([{ callId: "input-1", name: "request_input", arguments: { component: {} } }]),
      toolCallResult([{ callId: "create-1", name: "agent_create", arguments: {} }])
    );
    // What a ledger replay of an ask an earlier attempt already made answers.
    const tools = dispatcher({
      status: "succeeded",
      callId: "input-1",
      output: { replayed: true },
    });

    const outcome = await loop({ model, tools }).run(
      input({
        tools: [
          { name: "request_input", inputSchema: {}, mutating: true },
          { name: "agent_create", inputSchema: {}, mutating: true },
        ],
      })
    );

    expect(outcome).toMatchObject({ status: "input_required", callId: "input-1" });
    expect(tools.calls.map((call) => call.name)).toEqual(["request_input"]);
  });

  it("stops at a denied request_input dispatched beside other reads", async () => {
    const model = scriptedModel(
      toolCallResult([
        { callId: "list-1", name: "agent_list", arguments: {} },
        { callId: "input-1", name: "request_input", arguments: { component: {} } },
      ]),
      toolCallResult([{ callId: "create-1", name: "agent_create", arguments: {} }])
    );
    const tools = dispatcher(
      { status: "succeeded", callId: "list-1", output: { agents: [] } },
      { status: "denied", callId: "input-1", reason: "a guardrail refused it" }
    );

    const outcome = await loop({ model, tools }).run(
      input({
        tools: [
          { name: "agent_list", inputSchema: {}, mutating: false },
          { name: "request_input", inputSchema: {}, mutating: false },
          { name: "agent_create", inputSchema: {}, mutating: true },
        ],
      })
    );

    expect(outcome).toMatchObject({ status: "failed", reason: "input_request_failed" });
    expect(model.requests).toBe(1);
    expect(tools.calls.map((call) => call.name)).toEqual(["agent_list", "request_input"]);
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

  it("preserves a participant-safe provider failure reason", async () => {
    const providerError = new Error("provider response must remain operator-only");
    const model: ModelPort = {
      invoke: async () => {
        throw new ModelInvocationError("model_billing_inactive", providerError);
      },
    };
    const warn = vi.fn();

    const outcome = await loop({ model, log: { warn } }).run(input());

    expect(outcome).toMatchObject({
      status: "failed",
      reason: "model_billing_inactive",
      modelFailure: { requestId: "run-1:state-1:1" },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "model_billing_inactive",
        error: "provider response must remain operator-only",
      }),
      "model call failed"
    );
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

  const threeReadTools = [
    ...readTools,
    { name: "github.release.list", inputSchema: { type: "object" }, mutating: false },
  ];

  const threeReadCalls = [
    { callId: "c1", name: "github.issue.search", arguments: {} },
    { callId: "c2", name: "github.pull_request.search", arguments: {} },
    { callId: "c3", name: "github.release.list", arguments: {} },
  ];

  it("applies every dispatched result when an approval fires partway through a batch", async () => {
    const events = collector();
    const tools = dispatcher(
      { status: "succeeded", callId: "c1", output: {} },
      { status: "awaiting_approval", callId: "c2", approvalId: "appr-2" },
      { status: "succeeded", callId: "c3", output: { ok: true } }
    );

    const outcome = await loop({
      model: scriptedModel(toolCallResult(threeReadCalls)),
      tools,
      events: events.sink,
    }).run(
      input({
        tools: threeReadTools,
        limits: { maxIterations: 9, maxToolCalls: 9, maxRepairAttempts: 2 },
      })
    );

    expect(outcome).toMatchObject({
      status: "awaiting_approval",
      approvalId: "appr-2",
      callId: "c2",
      // Two of the three ran; the parked one is charged by the replay that actually performs it.
      toolCalls: 2,
    });
    // All three were dispatched and charged, so all three must be applied — a call whose result
    // is never applied leaves an unanswered Tool call in the transcript.
    expect(
      events.events.filter((event) => event.type === "tool_call_dispatched").map((e) => e.callId)
    ).toEqual(["c1", "c2", "c3"]);
  });

  it("counts a repair from a call dispatched after the batch's approval", async () => {
    const tools = dispatcher(
      { status: "awaiting_approval", callId: "c1", approvalId: "appr-1" },
      { status: "invalid_arguments", callId: "c2", reason: "missing body" },
      { status: "succeeded", callId: "c3", output: {} }
    );

    const outcome = await loop({
      model: scriptedModel(toolCallResult(threeReadCalls)),
      tools,
    }).run(
      input({
        tools: threeReadTools,
        limits: { maxIterations: 9, maxToolCalls: 9, maxRepairAttempts: 2 },
      })
    );

    expect(outcome).toMatchObject({
      status: "awaiting_approval",
      approvalId: "appr-1",
      repairs: 1,
    });
  });

  it("parks on the first approval and reports the superseded one", async () => {
    const warn = vi.fn();
    const tools = dispatcher(
      { status: "succeeded", callId: "c1", output: {} },
      { status: "awaiting_approval", callId: "c2", approvalId: "appr-2" },
      { status: "awaiting_approval", callId: "c3", approvalId: "appr-3" }
    );

    const outcome = await loop({
      model: scriptedModel(toolCallResult(threeReadCalls)),
      tools,
      log: { warn },
    }).run(
      input({
        tools: threeReadTools,
        limits: { maxIterations: 9, maxToolCalls: 9, maxRepairAttempts: 2 },
      })
    );

    expect(outcome).toMatchObject({ status: "awaiting_approval", approvalId: "appr-2" });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "agent_loop.batch_outcome_superseded",
        callId: "c3",
        approvalId: "appr-3",
        actedOn: "approval",
      }),
      expect.any(String)
    );
  });

  it("fails on the first decisive outcome when a repair exhausts before a later approval", async () => {
    const tools = dispatcher(
      { status: "invalid_arguments", callId: "c1", reason: "bad" },
      { status: "invalid_arguments", callId: "c2", reason: "bad" },
      { status: "awaiting_approval", callId: "c3", approvalId: "appr-3" }
    );

    const outcome = await loop({
      model: scriptedModel(toolCallResult(threeReadCalls)),
      tools,
    }).run(
      input({
        tools: threeReadTools,
        limits: { maxIterations: 9, maxToolCalls: 9, maxRepairAttempts: 1 },
      })
    );

    expect(outcome).toMatchObject({ status: "failed", reason: "repair_budget_exhausted" });
  });
});

describe("AgentLoop skill-scoped tool narrowing", () => {
  const catalog = [
    { name: "load_skill", inputSchema: { type: "object" } },
    { name: "load_skill_reference", inputSchema: { type: "object" } },
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
      expect.arrayContaining([
        "load_skill",
        "load_skill_reference",
        "complete_task",
        "routine_forge",
      ])
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
    expect(tools.calls[0]?.activeSkillName).toBeUndefined();
    expect(tools.calls[1]?.activeSkillName).toBe("routine-forge");
  });
});

describe("AgentLoop resume after an approval park", () => {
  /** Records the prompt it was handed, so the recovered transcript can be inspected. */
  function promptRecordingModel(...results: readonly ModelInvocationResult[]): ModelPort & {
    requests: number;
    prompts: ModelMessage[][];
  } {
    const queue = [...results];
    const port = {
      requests: 0,
      prompts: [] as ModelMessage[][],
      invoke: async (request: ModelInvocationRequest) => {
        port.requests += 1;
        port.prompts.push([...request.messages]);
        const next = queue.shift();
        if (next === undefined) throw new Error("model called more times than scripted");
        return next;
      },
    };
    return port;
  }

  const mutatingTool = [
    { name: "github.issue.comment", inputSchema: { type: "object" }, mutating: true },
  ];

  /** Parks a Turn on an approval, then re-enters the same State against the same checkpoints. */
  async function parkThenResume(resumeDispatcher: ToolDispatchPort) {
    const checkpoints = new InMemoryLoopCheckpointStore();
    const parkEvents = collector();
    const parked = await loop({
      model: scriptedModel(
        toolCallResult([
          { callId: "c1", name: "github.issue.comment", arguments: { body: "ship it" } },
        ])
      ),
      tools: dispatcher({ status: "awaiting_approval", callId: "c1", approvalId: "appr-1" }),
      checkpoints,
      events: parkEvents.sink,
    }).run(input({ tools: mutatingTool }));

    const resumeEvents = collector();
    const model = promptRecordingModel(textResult("commented"));
    const resumed = await loop({
      model,
      tools: resumeDispatcher,
      checkpoints,
      events: resumeEvents.sink,
    }).run(input({ tools: mutatingTool }));

    return { parked, parkEvents, resumed, resumeEvents, model };
  }

  it("replays the approved call without asking the model to re-plan it", async () => {
    const tools = dispatcher({ status: "succeeded", callId: "c1", output: { commented: true } });
    const { parked, resumed, model } = await parkThenResume(tools);

    expect(parked).toMatchObject({ status: "awaiting_approval", callId: "c1", toolCalls: 0 });
    expect(tools.calls).toEqual([{ name: "github.issue.comment", arguments: { body: "ship it" } }]);
    // One model call on resume: the final answer. The approved call needed no second plan.
    expect(model.requests).toBe(1);
    // One iteration from the parked attempt, one from the resumed answer; one Tool call.
    expect(resumed).toMatchObject({ status: "completed", iterations: 2, toolCalls: 1 });
  });

  it("continues the event sequence rather than colliding with the parked attempt's", async () => {
    const { parkEvents, resumeEvents } = await parkThenResume(
      dispatcher({ status: "succeeded", callId: "c1", output: {} })
    );

    const parkedHighest = Math.max(...parkEvents.events.map((event) => event.sequence));
    const resumedLowest = Math.min(...resumeEvents.events.map((event) => event.sequence));
    expect(resumedLowest).toBeGreaterThan(parkedHighest);
  });

  it("feeds a denied approval back to the model instead of replaying it forever", async () => {
    const tools = dispatcher({ status: "denied", callId: "c1", reason: "denied by operator" });
    const { resumed, model } = await parkThenResume(tools);

    expect(resumed).toMatchObject({ status: "completed" });
    const transcript = (model.prompts.at(0) ?? [])
      .map((message) => contentText(message.content))
      .join("\n");
    expect(transcript).toContain("denied by operator");
  });
});

describe("AgentLoop re-reading a File mid-Turn", () => {
  const readCall = toolCallResult([
    { callId: "call-1", name: "file_read", arguments: { fileId: "file-1" } },
  ]);

  it("puts a re-read File in front of the model on the next step", async () => {
    // The whole point of sending a File only on the Turn it was attached to: an Agent that needs
    // it three Turns later gets it back, so the saving is a saving rather than forgetting.
    const model = attachmentRecordingModel(readCall, textResult("the audit lists three findings"));
    const port = { read: async () => new Uint8Array([1, 2, 3]) };
    const outcome = await loop({
      model,
      tools: dispatcher(attachedFile("file-1")),
      attachments: port,
    }).run(input({ tools: [{ name: "file_read", inputSchema: { type: "object" } }] }));

    expect(outcome.status).toBe("completed");
    expect(model.attachmentsByRequest).toEqual([[], ["file-1"]]);
  });

  it("honours a share revoked between the read and the next step", async () => {
    // The port's refusal is the authorization check, and it runs again every iteration. A cached
    // copy would keep serving a File the person is no longer allowed to see.
    const model = attachmentRecordingModel(
      readCall,
      toolCallResult([{ callId: "call-2", name: "file_read", arguments: { fileId: "file-2" } }]),
      textResult("done")
    );
    let allowed = true;
    const port = {
      read: async () => {
        const bytes = allowed ? new Uint8Array([1]) : undefined;
        allowed = false;
        return bytes;
      },
    };
    const outcome = await loop({
      model,
      tools: dispatcher(attachedFile("file-1"), attachedFile("file-2")),
      attachments: port,
    }).run(input({ tools: [{ name: "file_read", inputSchema: { type: "object" } }] }));

    expect(outcome.status).toBe("completed");
    expect(model.attachmentsByRequest).toEqual([[], ["file-1"], []]);
  });

  it("carries a File exactly once when it was both attached and re-read", async () => {
    const model = attachmentRecordingModel(readCall, textResult("same document"));
    const outcome = await loop({
      model,
      tools: dispatcher(attachedFile("file-1")),
      attachments: { read: async () => new Uint8Array([9]) },
    }).run(
      input({
        tools: [{ name: "file_read", inputSchema: { type: "object" } }],
        attachments: [
          { fileId: "file-1", mediaType: "application/pdf", name: "a.pdf", data: new Uint8Array() },
        ],
      })
    );

    expect(outcome.status).toBe("completed");
    expect(model.attachmentsByRequest).toEqual([["file-1"], ["file-1"]]);
  });

  it("sends nothing extra when a text File was read, since its content came back as text", async () => {
    const model = attachmentRecordingModel(readCall, textResult("answered from the text"));
    const outcome = await loop({
      model,
      tools: dispatcher({
        status: "succeeded",
        callId: "call-1",
        output: { fileId: "file-1", kind: "text", text: "hello", mediaType: "text/plain" },
      }),
      attachments: { read: async () => new Uint8Array([1]) },
    }).run(input({ tools: [{ name: "file_read", inputSchema: { type: "object" } }] }));

    expect(outcome.status).toBe("completed");
    expect(model.attachmentsByRequest).toEqual([[], []]);
  });

  it("survives a park: a resumed Turn still holds what it went and got", async () => {
    const checkpoints = new InMemoryLoopCheckpointStore();
    const parked = await loop({
      model: scriptedModel(
        readCall,
        toolCallResult([{ callId: "call-2", name: "approve_me", arguments: {} }])
      ),
      tools: dispatcher(attachedFile("file-1"), {
        status: "awaiting_approval",
        callId: "call-2",
        approvalId: "approval-1",
      }),
      attachments: { read: async () => new Uint8Array([1]) },
      checkpoints,
    }).run(
      input({
        tools: [
          { name: "file_read", inputSchema: { type: "object" } },
          { name: "approve_me", inputSchema: { type: "object" } },
        ],
      })
    );
    expect(parked.status).toBe("awaiting_approval");

    const model = attachmentRecordingModel(textResult("still knows the document"));
    const resumed = await loop({
      model,
      tools: dispatcher({ status: "succeeded", callId: "call-2", output: {} }),
      attachments: { read: async () => new Uint8Array([1]) },
      checkpoints,
    }).run(
      input({
        tools: [
          { name: "file_read", inputSchema: { type: "object" } },
          { name: "approve_me", inputSchema: { type: "object" } },
        ],
      })
    );

    expect(resumed.status).toBe("completed");
    expect(model.attachmentsByRequest).toEqual([["file-1"]]);
  });

  it("sends nothing when no attachment port is wired, rather than failing the Turn", async () => {
    const model = attachmentRecordingModel(readCall, textResult("no bytes to be had"));
    const outcome = await loop({ model, tools: dispatcher(attachedFile("file-1")) }).run(
      input({ tools: [{ name: "file_read", inputSchema: { type: "object" } }] })
    );

    expect(outcome.status).toBe("completed");
    expect(model.attachmentsByRequest).toEqual([[], []]);
  });
});
