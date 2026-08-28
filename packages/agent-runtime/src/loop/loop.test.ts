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
import { MAX_TOOL_RESULT_CHARS } from "./oversize";
import { callSignature } from "./repeat";

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

/** Records the prompt it was handed, so the Tool results the model reads back can be inspected. */
function promptRecordingModel(...results: readonly ModelInvocationResult[]): ModelPort & {
  prompts: ModelMessage[][];
} {
  const queue = [...results];
  const port = {
    prompts: [] as ModelMessage[][],
    invoke: async (request: ModelInvocationRequest) => {
      port.prompts.push([...request.messages]);
      const next = queue.shift();
      if (next === undefined) throw new Error("model called more times than scripted");
      return next;
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
  cancelPollMs?: number;
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
    ...(options.cancelPollMs === undefined ? {} : { cancelPollMs: options.cancelPollMs }),
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
      output: { url: "https://x.example", content: "By Vicent Marti. ".repeat(2_500) },
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
        {
          requestId: "req",
          output: { kind: "text", text: "" },
          usage: { inputTokens: 5, outputTokens: 0 },
        },
        toolCallResult([
          { callId: "call-1", name: "web_fetch", arguments: { url: "https://x.example" } },
        ]),
        textResult("It ships in September.")
      ),
      tools: dispatcher({
        status: "succeeded",
        callId: "call-1",
        output: { url: "https://x.example", content: "Ships in September. ".repeat(2_200) },
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

  // A model that batches "load the forge Skill" twice would otherwise be handed the same SKILL.md
  // body twice, at full token cost. Within one batch nothing can have changed between the two, so
  // the second dispatch is pure waste — unlike a repeat in a later iteration, which `repeat.ts`
  // deliberately re-runs because the answer may have moved.
  it("dispatches an exactly repeated read in one batch only once", async () => {
    const tools = trackingDispatcher();
    const outcome = await loop({
      model: scriptedModel(
        toolCallResult([
          { callId: "c1", name: "github.issue.search", arguments: { q: "open" } },
          { callId: "c2", name: "github.issue.search", arguments: { q: "open" } },
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

    expect(outcome).toMatchObject({ status: "completed" });
    expect(tools.calls).toEqual(["github.issue.search"]);
  });

  // Key order is the provider's choice, not the model's meaning, so it must not decide whether a
  // duplicate is spotted.
  it("collapses a repeat whose arguments were serialized in a different key order", async () => {
    const tools = trackingDispatcher();
    await loop({
      model: scriptedModel(
        toolCallResult([
          { callId: "c1", name: "github.issue.search", arguments: { a: 1, b: 2 } },
          { callId: "c2", name: "github.issue.search", arguments: { b: 2, a: 1 } },
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

    expect(tools.calls).toEqual(["github.issue.search"]);
  });

  it("still dispatches reads that differ only by argument", async () => {
    const tools = trackingDispatcher();
    await loop({
      model: scriptedModel(
        toolCallResult([
          { callId: "c1", name: "github.issue.search", arguments: { q: "open" } },
          { callId: "c2", name: "github.issue.search", arguments: { q: "closed" } },
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

    expect(tools.calls).toEqual(["github.issue.search", "github.issue.search"]);
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
    { name: "skill", inputSchema: { type: "object" } },
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

  it("narrows to a Skill's declared tools (plus the always-exposed baseline) after a skill load succeeds", async () => {
    const tools = dispatcher({
      status: "succeeded",
      callId: "call-1",
      output: { name: "routine-forge" },
    });
    const model = recordingModel(
      toolCallResult([{ callId: "call-1", name: "skill", arguments: { name: "routine-forge" } }]),
      textResult("done")
    );
    const outcome = await loop({ model, tools }).run(
      input({
        tools: catalog,
        skillToolScopes: new Map([["routine-forge", ["routine_forge"]]]),
      })
    );

    expect(outcome).toMatchObject({ status: "completed" });
    // Iteration 1 (before the skill load resolves) still sees everything.
    expect(model.toolNamesByRequest[0]).toEqual(catalog.map((t) => t.name));
    // Iteration 2 is narrowed to the declared scope plus the always-exposed baseline.
    expect(model.toolNamesByRequest[1]).toEqual(
      expect.arrayContaining(["skill", "complete_task", "routine_forge"])
    );
    expect(model.toolNamesByRequest[1]).not.toContain("record_search");
    expect(model.toolNamesByRequest[1]).not.toContain("agent_list");
  });

  it("inspecting a Skill neither narrows nor becomes the active Skill", async () => {
    const tools = dispatcher(
      { status: "succeeded", callId: "call-1", output: { name: "routine-forge", inspected: true } },
      { status: "succeeded", callId: "call-2", output: { ok: true } }
    );
    const model = recordingModel(
      toolCallResult([
        { callId: "call-1", name: "skill", arguments: { name: "routine-forge", mode: "inspect" } },
      ]),
      toolCallResult([{ callId: "call-2", name: "record_search", arguments: {} }]),
      textResult("done")
    );
    await loop({ model, tools }).run(
      input({
        tools: catalog,
        skillToolScopes: new Map([["routine-forge", ["routine_forge"]]]),
      })
    );

    // An inspected Skill is material, not instructions: the offer stays whole and no later
    // dispatch is tagged as acting under the Skill that was merely read.
    expect(model.toolNamesByRequest[1]).toEqual(catalog.map((t) => t.name));
    expect(tools.calls[1]?.activeSkillName).toBeUndefined();
  });

  it("does not narrow when the active Skill has no declared scope", async () => {
    const tools = dispatcher({
      status: "succeeded",
      callId: "call-1",
      output: { name: "no-scope-skill" },
    });
    const model = recordingModel(
      toolCallResult([{ callId: "call-1", name: "skill", arguments: { name: "no-scope-skill" } }]),
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
      toolCallResult([{ callId: "call-1", name: "skill", arguments: { name: "routine-forge" } }]),
      toolCallResult([{ callId: "call-2", name: "skill", arguments: { name: "agent-forge" } }]),
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
      expect.arrayContaining(["skill", "complete_task", "agent_list"])
    );
    expect(model.toolNamesByRequest[2]).not.toContain("routine_forge");
  });

  it("still authorizes dispatch of a Tool the narrowed offer excluded (narrowing is not a security boundary)", async () => {
    const tools = dispatcher(
      { status: "succeeded", callId: "call-1", output: { name: "routine-forge" } },
      { status: "succeeded", callId: "call-2", output: { ok: true } }
    );
    const model = scriptedModel(
      toolCallResult([{ callId: "call-1", name: "skill", arguments: { name: "routine-forge" } }]),
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
    expect(tools.calls.map((c) => c.name)).toEqual(["skill", "record_search"]);
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

  it("answers every declared call before parking, so the resumed transcript is well-formed", async () => {
    // The assistant message declares both calls, but the park stops dispatch at the first. An
    // unanswered tool call is a transcript the provider rejects, so the trailing call must still
    // carry a result by the time the resumed Turn hands it to the model.
    const checkpoints = new InMemoryLoopCheckpointStore();
    const tools = [
      { name: "github.issue.comment", inputSchema: { type: "object" }, mutating: true },
      { name: "github.issue.read", inputSchema: { type: "object" }, mutating: false },
    ];
    const parked = await loop({
      model: scriptedModel(
        toolCallResult([
          { callId: "c1", name: "github.issue.comment", arguments: { body: "ship it" } },
          { callId: "c2", name: "github.issue.read", arguments: { number: 7 } },
        ])
      ),
      tools: dispatcher({ status: "awaiting_approval", callId: "c1", approvalId: "appr-1" }),
      checkpoints,
      events: collector().sink,
    }).run(input({ tools }));

    expect(parked).toMatchObject({ status: "awaiting_approval", callId: "c1" });

    const model = promptRecordingModel(textResult("commented"));
    const resumed = await loop({
      model,
      tools: dispatcher({ status: "succeeded", callId: "c1", output: { commented: true } }),
      checkpoints,
      events: collector().sink,
    }).run(input({ tools }));

    expect(resumed.status).toBe("completed");

    const transcript = model.prompts.at(0) ?? [];
    const declared = transcript
      .filter((message) => message.role === "assistant")
      .flatMap((message) => {
        const parsed = JSON.parse(contentText(message.content)) as {
          toolCalls?: { callId: string }[];
        };
        return (parsed.toolCalls ?? []).map((call) => call.callId);
      });
    const answered = transcript
      .filter((message) => message.role === "tool")
      .map((message) => (JSON.parse(contentText(message.content)) as { callId: string }).callId);

    expect(declared).toEqual(["c1", "c2"]);
    expect(new Set(answered)).toEqual(new Set(declared));
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

describe("AgentLoop keeping a failed Turn's work for the retry", () => {
  /** Runs one Tool, then dies on the next model call with `reason`. */
  async function failAfterOneTool(reason: "model_provider_unavailable" | "budget_exhausted") {
    const checkpoints = new InMemoryLoopCheckpointStore();
    let call = 0;
    const model: ModelPort = {
      invoke: async () => {
        call += 1;
        if (call === 1) {
          return toolCallResult([
            { callId: "c1", name: "github.issue.comment", arguments: { body: "hi" } },
          ]);
        }
        throw new ModelInvocationError("model_provider_unavailable", new Error("overloaded"));
      },
    };
    const outcome = await loop({
      model,
      tools: dispatcher({ status: "succeeded", callId: "c1", output: { stars: 412 } }),
      checkpoints,
      ...(reason === "budget_exhausted"
        ? {
            budget: {
              consume: async (charge: { key: string; amount: number }) => ({
                outcome: charge.key === "tokens" ? "exhausted" : "allowed",
              }),
            },
          }
        : {}),
    }).run(input());
    return { outcome, saved: await checkpoints.load("biz-1", "run-1", "state-1") };
  }

  it("keeps the Tool results when the provider had a bad moment, so a retry need not buy them again", async () => {
    const { outcome, saved } = await failAfterOneTool("model_provider_unavailable");

    expect(outcome).toMatchObject({ status: "failed", reason: "model_provider_unavailable" });
    // The expensive part of the Turn is the Tool result, not the model call that died after it.
    // Dropping it here is what made Retry re-run every Tool from the top.
    expect(saved?.resume).toBeDefined();
    expect(JSON.stringify(saved?.resume?.messages)).toContain("412");
  });

  it("drops them when the failure is one a retry cannot fix", async () => {
    const { outcome, saved } = await failAfterOneTool("budget_exhausted");

    expect(outcome).toMatchObject({ status: "failed", reason: "budget_exhausted" });
    // Retrying an exhausted budget fails the same way, so holding the Tool arguments and outputs
    // would retain them for a Turn that can never use them.
    expect(saved?.resume).toBeUndefined();
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

describe("AgentLoop oversized Tool results", () => {
  /** Records the prompt it was handed, so the transcript the model reads back can be inspected. */
  function promptRecordingModel(...results: readonly ModelInvocationResult[]): ModelPort & {
    prompts: ModelMessage[][];
  } {
    const queue = [...results];
    const port = {
      prompts: [] as ModelMessage[][],
      invoke: async (request: ModelInvocationRequest) => {
        port.prompts.push([...request.messages]);
        const next = queue.shift();
        if (next === undefined) throw new Error("model called more times than scripted");
        return next;
      },
    };
    return port;
  }

  const callOnce = toolCallResult([
    { callId: "call-1", name: "github.issue.comment", arguments: {} },
  ]);

  const toolText = (prompt: readonly ModelMessage[]): string => {
    const messages = prompt.filter((message) => message.role === "tool");
    expect(messages).toHaveLength(1);
    return contentText(messages[0].content);
  };

  it("shortens an oversized result before it reaches the transcript", async () => {
    // A denied or failed call carries its reason straight into the transcript — the distiller only
    // runs on a succeeded result. So this ceiling is the only thing between a provider dumping a
    // response body into `reason` and every later iteration of the Turn carrying it, which is the
    // bytes-times-steps runaway the re-read cap already bounds for Files.
    const model = promptRecordingModel(callOnce, textResult("summarised"));
    const warnings: unknown[] = [];

    const outcome = await loop({
      model,
      tools: dispatcher({ status: "failed", callId: "call-1", reason: "e".repeat(120_000) }),
      log: { warn: (obj: unknown) => warnings.push(obj) },
    }).run(input());

    expect(outcome).toMatchObject({ status: "completed" });

    const raw = toolText(model.prompts[1]);
    expect(raw.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
    expect(JSON.parse(raw)).toMatchObject({ callId: "call-1", truncated: true });
    expect(warnings).toContainEqual(
      expect.objectContaining({ event: "agent_loop.tool_result_capped", callId: "call-1" })
    );
  });

  it("leaves a distilled result alone, so the two ceilings never cut the same bytes twice", async () => {
    // A succeeded result passes the distiller first, which bounds it well below this ceiling. The
    // cap has to recognise that as already small enough: cutting a summary a second time would
    // strip the citations that are the only reason a distilled result is usable at all.
    const model = promptRecordingModel(callOnce, textResult("summarised"));
    const warnings: unknown[] = [];

    const outcome = await loop({
      model,
      tools: dispatcher({
        status: "succeeded",
        callId: "call-1",
        output: { body: "x".repeat(120_000) },
      }),
      log: { warn: (obj: unknown) => warnings.push(obj) },
    }).run(input());

    expect(outcome).toMatchObject({ status: "completed" });

    const parsed = JSON.parse(toolText(model.prompts[1])) as { output: { truncated?: boolean } };
    // Bounded by the distiller, under its own key — not by the cap at the payload's top level.
    expect(parsed.output.truncated).toBe(true);
    expect(warnings).not.toContainEqual(
      expect.objectContaining({ event: "agent_loop.tool_result_capped" })
    );
  });

  it("hands a result that already fits through exactly as the Tool returned it", async () => {
    const model = promptRecordingModel(callOnce, textResult("summarised"));
    const warnings: unknown[] = [];

    await loop({
      model,
      tools: dispatcher({ status: "succeeded", callId: "call-1", output: { ok: true } }),
      log: { warn: (obj: unknown) => warnings.push(obj) },
    }).run(input());

    expect(JSON.parse(toolText(model.prompts[1]))).toEqual({
      callId: "call-1",
      output: { ok: true },
    });
    expect(warnings).toEqual([]);
  });
});

describe("AgentLoop cancellation while the model is answering", () => {
  /** A model that answers slowly, so a stop can land while its call is still in flight. */
  function slowStreamingModel(chunks: number): ModelPort & { yielded: number } {
    const port = {
      yielded: 0,
      invoke: async () => textResult("done"),
      stream: async function* (): AsyncIterable<ModelStreamChunk> {
        for (let index = 0; index < chunks; index += 1) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          port.yielded += 1;
          yield { kind: "text_delta" as const, text: `chunk-${index}` };
        }
        yield { kind: "completed" as const, result: textResult("done") };
      },
    };
    return port;
  }

  it("stops a Turn mid-answer rather than waiting for the model to finish", async () => {
    // The loop's own check runs at the top of an iteration, so without a poll during the call this
    // Turn would stream all fifty chunks — and be billed for them — after the stop was asked for.
    const model = slowStreamingModel(50);
    let stopping = false;
    const flip = setTimeout(() => {
      stopping = true;
    }, 15);

    const outcome = await loop({
      model,
      cancelled: async () => stopping,
      cancelPollMs: 1,
    }).run(input());

    clearTimeout(flip);
    expect(outcome).toMatchObject({ status: "cancelled" });
    expect(model.yielded).toBeLessThan(50);
  });

  it("hands the provider a signal, so an adapter that honours it stops at the source", async () => {
    let seen: AbortSignal | undefined;
    const model = {
      invoke: async (request: ModelInvocationRequest) => {
        seen = request.signal;
        return textResult("done");
      },
    };

    const outcome = await loop({ model }).run(input());

    expect(outcome).toMatchObject({ status: "completed" });
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(false);
  });

  it("reads a provider's abort as a stop, not as a model failure", async () => {
    // An aborted call rejects with whatever the provider throws. Classified on the error alone it
    // would be recorded as `model_error`, putting a failed Turn in front of someone who pressed
    // stop — and charging a repair budget against it.
    let stopping = false;
    const model = {
      invoke: async () => {
        stopping = true;
        await new Promise((resolve) => setTimeout(resolve, 25));
        throw new Error("The operation was aborted");
      },
    };

    const outcome = await loop({
      model,
      cancelled: async () => stopping,
      cancelPollMs: 1,
    }).run(input());

    expect(outcome).toMatchObject({ status: "cancelled" });
  });

  it("leaves an uncancelled Turn to finish normally", async () => {
    const model = slowStreamingModel(3);
    const outcome = await loop({ model, cancelPollMs: 1 }).run(input());

    expect(outcome).toMatchObject({ status: "completed" });
    expect(model.yielded).toBe(3);
  });
});

describe("AgentLoop repeated Tool calls inside one Turn", () => {
  const listCall = (callId: string, args: unknown) =>
    toolCallResult([{ callId, name: "github.issue.comment", arguments: args }]);

  /** Every Tool result in the final prompt, in the order the model reads them. */
  const results = (prompt: readonly ModelMessage[]) =>
    prompt
      .filter((message) => message.role === "tool")
      .map((message) => JSON.parse(contentText(message.content)) as Record<string, unknown>);

  it("tells the model when it asks the same question twice", async () => {
    const model = promptRecordingModel(
      listCall("call-1", { body: "hi" }),
      listCall("call-2", { body: "hi" }),
      textResult("done")
    );

    await loop({
      model,
      tools: dispatcher(
        { status: "succeeded", callId: "call-1", output: { ok: true } },
        { status: "succeeded", callId: "call-2", output: { ok: true } }
      ),
    }).run(input());

    const [first, second] = results(model.prompts[2]);
    expect(first.repeatedCall).toBeUndefined();
    expect(second.repeatedCall).toMatchObject({ count: 2 });
    expect((second.repeatedCall as { note: string }).note).toContain("call 2");
  });

  it("matches a repeat whose arguments arrived in a different key order", async () => {
    const model = promptRecordingModel(
      listCall("call-1", { body: "hi", title: "t" }),
      listCall("call-2", { title: "t", body: "hi" }),
      textResult("done")
    );

    await loop({
      model,
      tools: dispatcher(
        { status: "succeeded", callId: "call-1", output: { ok: true } },
        { status: "succeeded", callId: "call-2", output: { ok: true } }
      ),
    }).run(input());

    expect(results(model.prompts[2])[1].repeatedCall).toMatchObject({ count: 2 });
  });

  it("leaves a genuinely different call unmarked", async () => {
    const model = promptRecordingModel(
      listCall("call-1", { body: "hi" }),
      listCall("call-2", { body: "different" }),
      textResult("done")
    );

    await loop({
      model,
      tools: dispatcher(
        { status: "succeeded", callId: "call-1", output: { ok: true } },
        { status: "succeeded", callId: "call-2", output: { ok: true } }
      ),
    }).run(input());

    for (const result of results(model.prompts[2])) {
      expect(result.repeatedCall).toBeUndefined();
    }
  });

  it("still dispatches the repeat, so authority is re-checked and the answer is fresh", async () => {
    // Serving a cached result would skip the broker, and with it the authorization it re-checks on
    // every call — the same reason a re-read File is fetched again each iteration.
    const tools = dispatcher(
      { status: "succeeded", callId: "call-1", output: { ok: true } },
      { status: "succeeded", callId: "call-2", output: { ok: true } }
    );

    await loop({
      model: promptRecordingModel(
        listCall("call-1", { body: "hi" }),
        listCall("call-2", { body: "hi" }),
        textResult("done")
      ),
      tools,
    }).run(input());

    expect(tools.calls).toHaveLength(2);
  });
});

describe("AgentLoop park-time answers and cancellation accounting", () => {
  const readTools = [
    { name: "github.issue.search", inputSchema: { type: "object" }, mutating: false },
    { name: "github.pull_request.search", inputSchema: { type: "object" }, mutating: false },
  ];

  /** The Tool results the resumed Turn hands back to the model, keyed by callId. */
  async function transcriptAfterPark(
    parkTools: ToolDispatchPort
  ): Promise<Record<string, Record<string, unknown>>> {
    const checkpoints = new InMemoryLoopCheckpointStore();
    const parked = await loop({
      model: scriptedModel(
        toolCallResult([
          { callId: "c1", name: "github.issue.search", arguments: { q: "a" } },
          { callId: "c2", name: "github.pull_request.search", arguments: { q: "b" } },
        ])
      ),
      tools: parkTools,
      checkpoints,
    }).run(input({ tools: readTools }));
    expect(parked).toMatchObject({ status: "awaiting_approval", callId: "c1" });

    const model = promptRecordingModel(textResult("done"));
    await loop({
      model,
      tools: dispatcher({ status: "succeeded", callId: "c1", output: {} }),
      checkpoints,
    }).run(input({ tools: readTools }));

    return Object.fromEntries(
      (model.prompts.at(0) ?? [])
        .filter((message) => message.role === "tool")
        .map((message) => {
          const parsed = JSON.parse(contentText(message.content)) as { callId: string };
          return [parsed.callId, parsed as unknown as Record<string, unknown>];
        })
    );
  }

  it("does not tell the model a superseded approval never ran", async () => {
    // A concurrent batch dispatches every call before any outcome is read, so `c2` reached the
    // broker and left a second approval pending there. Calling that "not dispatched" invites the
    // model to re-issue it, which asks an operator to clear two approvals for one intention.
    const results = await transcriptAfterPark(
      dispatcher(
        { status: "awaiting_approval", callId: "c1", approvalId: "appr-1" },
        { status: "awaiting_approval", callId: "c2", approvalId: "appr-2" }
      )
    );

    expect(results.c2).toMatchObject({ error: "superseded" });
    expect(results.c2.detail).toContain("do not re-issue");
  });

  it("still tells the model when a call genuinely never ran", async () => {
    // A write dispatches alone, so `c2` never reached the broker and re-issuing it is correct.
    const checkpoints = new InMemoryLoopCheckpointStore();
    const mixed = [
      { name: "github.issue.comment", inputSchema: { type: "object" }, mutating: true },
      { name: "github.issue.read", inputSchema: { type: "object" }, mutating: false },
    ];
    await loop({
      model: scriptedModel(
        toolCallResult([
          { callId: "c1", name: "github.issue.comment", arguments: { body: "x" } },
          { callId: "c2", name: "github.issue.read", arguments: { number: 7 } },
        ])
      ),
      tools: dispatcher({ status: "awaiting_approval", callId: "c1", approvalId: "appr-1" }),
      checkpoints,
    }).run(input({ tools: mixed }));

    const model = promptRecordingModel(textResult("done"));
    await loop({
      model,
      tools: dispatcher({ status: "succeeded", callId: "c1", output: {} }),
      checkpoints,
    }).run(input({ tools: mixed }));

    const c2 = (model.prompts.at(0) ?? [])
      .filter((message) => message.role === "tool")
      .map((message) => JSON.parse(contentText(message.content)) as Record<string, unknown>)
      .find((result) => result.callId === "c2");
    expect(c2).toMatchObject({ error: "not_dispatched" });
  });

  it("does not answer a succeeded call twice when a later call in the batch parks", async () => {
    // The succeeded path has to record itself as answered. If it pushes its Tool message directly,
    // the park below sees no answer for it and backfills a second one — leaving two results for
    // one callId, the later of them contradicting the output the Tool actually returned.
    const checkpoints = new InMemoryLoopCheckpointStore();
    const parked = await loop({
      model: scriptedModel(
        toolCallResult([
          { callId: "c1", name: "github.issue.search", arguments: { q: "a" } },
          { callId: "c2", name: "github.pull_request.search", arguments: { q: "b" } },
        ])
      ),
      tools: dispatcher(
        { status: "succeeded", callId: "c1", output: { found: 3 } },
        { status: "awaiting_approval", callId: "c2", approvalId: "appr-1" }
      ),
      checkpoints,
    }).run(input({ tools: readTools }));
    expect(parked).toMatchObject({ status: "awaiting_approval", callId: "c2" });

    const model = promptRecordingModel(textResult("done"));
    await loop({
      model,
      tools: dispatcher({ status: "succeeded", callId: "c2", output: {} }),
      checkpoints,
    }).run(input({ tools: readTools }));

    const forC1 = (model.prompts.at(0) ?? [])
      .filter((message) => message.role === "tool")
      .map((message) => JSON.parse(contentText(message.content)) as Record<string, unknown>)
      .filter((result) => result.callId === "c1");

    expect(forC1).toHaveLength(1);
    expect(forC1[0]).toMatchObject({ output: { found: 3 } });
  });

  it("charges what the provider burned before a stop", async () => {
    // A stop is not a refund. Dropping the partial usage would let a Run that is started and
    // stopped over and over spend against a budget it never charges.
    const consumed: { key: string; amount: number }[] = [];
    let asked = 0;
    const model: ModelPort = {
      invoke: async (request: ModelInvocationRequest) => {
        await new Promise<void>((resolve) => {
          request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new ModelInvocationError("model_error", new Error("aborted by caller"), {
          inputTokens: 100,
          outputTokens: 20,
          costUsd: 0.01,
        });
      },
    };

    const outcome = await loop({
      model,
      // False once, so the Turn gets past the top-of-iteration check and the model call actually
      // starts. Stopping before it would spend nothing, which is not the case under test.
      cancelled: async () => {
        asked += 1;
        return asked > 1;
      },
      cancelPollMs: 1,
      budget: {
        consume: async (charge) => {
          consumed.push(charge);
          return { outcome: "allowed" };
        },
      },
    }).run(input());

    expect(outcome.status).toBe("cancelled");
    expect(consumed).toContainEqual({ key: "tokens", amount: 120 });
    expect(consumed.some((charge) => charge.key === "costMicros")).toBe(true);
  });

  it("completes a Turn whose Tool arguments are too deep to sign", async () => {
    // The repeat marker is advice. Losing it must never cost a Tool result the Run paid for.
    //
    // The depth is found at run time rather than hard-coded: both limits below are stack-bound, so
    // a machine with a different stack moves them together and any fixed number would eventually
    // sit on the wrong side of one of them.
    const nest = (levels: number) => {
      const root: Record<string, unknown> = {};
      let cursor = root;
      for (let i = 0; i < levels; i += 1) {
        const next: Record<string, unknown> = {};
        cursor.n = next;
        cursor = next;
      }
      return root;
    };
    let deep: Record<string, unknown> | undefined;
    for (let levels = 256; levels <= 65_536; levels *= 2) {
      const candidate = nest(levels);
      // The Tool call has to serialize, or the Turn would have died before the annotation ran.
      try {
        JSON.stringify(candidate);
      } catch {
        break;
      }
      if (callSignature("x", candidate) === undefined) {
        deep = candidate;
        break;
      }
    }
    expect(deep).toBeDefined();

    const outcome = await loop({
      model: scriptedModel(
        toolCallResult([{ callId: "c1", name: "github.issue.comment", arguments: deep }]),
        textResult("done")
      ),
      tools: dispatcher({ status: "succeeded", callId: "c1", output: { ok: true } }),
    }).run(input());

    expect(outcome).toMatchObject({ status: "completed", toolCalls: 1 });
  });
});
