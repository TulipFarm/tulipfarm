import type { ModelInvocationRequest, ModelStreamChunk } from "@tulipfarm/agent-runtime";
import { LlmProviderError } from "@tulipfarm/llm";
import type { LanguageModel } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import type { LlmModelResolution } from "./llm";
import { LlmModelPort } from "./model";

type DoStreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
type StreamPart = DoStreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

function model(parts: StreamPart[]): {
  port: LlmModelPort;
  calls: () => MockLanguageModelV4["doStreamCalls"];
} {
  const mock = new MockLanguageModelV4({
    doStream: async () => ({ stream: simulateReadableStream<StreamPart>({ chunks: parts }) }),
  });
  return {
    port: new LlmModelPort({
      model: async (selector): Promise<LlmModelResolution> => ({
        kind: "available",
        model: mock as unknown as LanguageModel,
        routing: {
          outcome: "raw_model",
          selector,
          resolution: "raw_model_id",
          modelId: selector,
        },
      }),
    }),
    calls: () => mock.doStreamCalls,
  };
}

/** The terminal chunk of a v4 provider stream: without it the SDK reports no output at all. */
const FINISH: StreamPart = {
  type: "finish",
  finishReason: { unified: "stop", raw: "end_turn" },
  usage: {
    inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 4, text: 4, reasoning: 0 },
  },
};

const request = (overrides: Partial<ModelInvocationRequest> = {}): ModelInvocationRequest => ({
  requestId: "request-1",
  modelProfileId: "claude-opus-5",
  messages: [{ role: "user", content: "hello" }],
  tools: [],
  ...overrides,
});

async function collect(chunks: AsyncIterable<ModelStreamChunk>): Promise<ModelStreamChunk[]> {
  const collected: ModelStreamChunk[] = [];
  for await (const chunk of chunks) collected.push(chunk);
  return collected;
}

const textParts = (id: string, pieces: string[]): StreamPart[] => [
  { type: "text-start", id },
  ...pieces.map((delta): StreamPart => ({ type: "text-delta", id, delta })),
  { type: "text-end", id },
];

describe("LlmModelPort", () => {
  it("yields text as it arrives, then the completed result", async () => {
    const { port } = model([...textParts("t1", ["Hel", "lo"]), FINISH]);

    const chunks = await collect(port.stream(request()));

    expect(chunks.slice(0, -1)).toEqual([
      { kind: "text_delta", text: "Hel" },
      { kind: "text_delta", text: "lo" },
    ]);
    expect(chunks.at(-1)).toEqual({
      kind: "completed",
      result: {
        requestId: "request-1",
        output: { kind: "text", text: "Hello" },
        usage: { inputTokens: 11, outputTokens: 4 },
      },
    });
  });

  it("drains the same stream when only the outcome is wanted", async () => {
    const { port } = model([...textParts("t1", ["done"]), FINISH]);

    await expect(port.invoke(request())).resolves.toMatchObject({
      output: { kind: "text", text: "done" },
    });
  });

  it("carries a safe provider failure reason across the model port", async () => {
    const providerError = new LlmProviderError(
      "model_billing_inactive",
      new Error("provider response")
    );
    const mock = new MockLanguageModelV4({
      doStream: async () => {
        throw providerError;
      },
    });
    const port = new LlmModelPort({
      model: async (selector): Promise<LlmModelResolution> => ({
        kind: "available",
        model: mock as unknown as LanguageModel,
        routing: {
          outcome: "raw_model",
          selector,
          resolution: "raw_model_id",
          modelId: selector,
        },
      }),
    });

    await expect(port.invoke(request())).rejects.toMatchObject({
      name: "ModelInvocationError",
      reason: "model_billing_inactive",
    });
  });

  it("emits the routing decision with a deterministic invocation key before calling the model", async () => {
    const emitted: {
      type: string;
      payload: unknown;
      key: string;
    }[] = [];
    const mock = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream<StreamPart>({
          chunks: [...textParts("t1", ["ok"]), FINISH],
        }),
      }),
    });
    const port = new LlmModelPort({
      model: async (): Promise<LlmModelResolution> => ({
        kind: "available",
        model: mock as unknown as LanguageModel,
        routing: {
          outcome: "selected",
          selector: "balanced",
          resolution: "effort_preset",
          profileId: "primary",
          chain: [
            { profileId: "primary", modelId: "claude-sonnet-5" },
            { profileId: "backup", modelId: "claude-haiku-5" },
          ],
          cacheAllowed: true,
          rejectedFallbacks: [{ profileId: "tiny", reason: "context_window_exceeded" }],
        },
      }),
      routingEvents: {
        emit: async (type, payload, key) => {
          emitted.push({ type, payload, key });
        },
      },
    });

    await port.invoke(request({ modelProfileId: "balanced" }));

    expect(emitted).toEqual([
      {
        type: "model.routed",
        key: "model:request-1",
        payload: {
          outcome: "selected",
          selector: "balanced",
          resolution: "effort_preset",
          profileId: "primary",
          chain: [
            { profileId: "primary", modelId: "claude-sonnet-5" },
            { profileId: "backup", modelId: "claude-haiku-5" },
          ],
          cacheAllowed: true,
          rejectedFallbacks: [{ profileId: "tiny", reason: "context_window_exceeded" }],
        },
      },
    ]);
  });

  it("opens selected ModelProfile budgets before recording the routing decision or calling the model", async () => {
    const order: string[] = [];
    const mock = new MockLanguageModelV4({
      doStream: async () => {
        order.push("model");
        return {
          stream: simulateReadableStream<StreamPart>({
            chunks: [...textParts("t1", ["ok"]), FINISH],
          }),
        };
      },
    });
    const port = new LlmModelPort({
      model: async (): Promise<LlmModelResolution> => ({
        kind: "available",
        model: mock as unknown as LanguageModel,
        budgetLimits: { tokens: { value: 2_000, scope: "model" } },
        routing: {
          outcome: "selected",
          selector: "balanced",
          resolution: "effort_preset",
          profileId: "primary",
          chain: [{ profileId: "primary", modelId: "claude-sonnet-5" }],
          cacheAllowed: true,
          rejectedFallbacks: [],
          budgetLimits: { tokens: { value: 2_000, scope: "model" } },
        },
      }),
      budgets: {
        open: async (limits) => {
          order.push(`open:${limits.tokens?.value}`);
        },
      },
      routingEvents: {
        emit: async () => {
          order.push("event");
        },
      },
    });

    await port.invoke(request({ modelProfileId: "balanced" }));

    expect(order).toEqual(["open:2000", "event", "model"]);
  });

  it("adds priced cost usage when the selected model is known to the price table", async () => {
    const mock = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream<StreamPart>({
          chunks: [...textParts("t1", ["ok"]), FINISH],
        }),
      }),
    });
    const port = new LlmModelPort({
      model: async (): Promise<LlmModelResolution> => ({
        kind: "available",
        model: mock as unknown as LanguageModel,
        routing: {
          outcome: "selected",
          selector: "balanced",
          resolution: "effort_preset",
          profileId: "primary",
          chain: [{ profileId: "primary", modelId: "claude-sonnet-4-6" }],
          cacheAllowed: true,
          rejectedFallbacks: [],
        },
      }),
    });

    await expect(port.invoke(request({ modelProfileId: "balanced" }))).resolves.toMatchObject({
      usage: { inputTokens: 11, outputTokens: 4, costUsd: 0.000093 },
    });
  });

  it("records a participant receipt for the selected model call after it completes", async () => {
    const ticks = [100, 142];
    const mock = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream<StreamPart>({
          chunks: [...textParts("t1", ["ok"]), FINISH],
        }),
      }),
    });
    const port = new LlmModelPort({
      model: async (): Promise<LlmModelResolution> => ({
        kind: "available",
        model: mock as unknown as LanguageModel,
        routing: {
          outcome: "selected",
          selector: "balanced",
          resolution: "effort_preset",
          profileId: "primary",
          chain: [
            { profileId: "primary", modelId: "claude-sonnet-5" },
            { profileId: "backup", modelId: "claude-haiku-5" },
          ],
          cacheAllowed: true,
          rejectedFallbacks: [],
        },
      }),
      now: () => ticks.shift() ?? 142,
    });

    await port.invoke(request({ requestId: "run-1:invoke:1", modelProfileId: "balanced" }));

    expect(port.latestModelCallReceipt()).toEqual({
      modelId: "claude-sonnet-5",
      effortPreset: "balanced",
      modelCallLatencyMs: 42,
    });
  });

  it("names the rung Auto actually applied, so a client never has to guess it", async () => {
    const mock = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream<StreamPart>({
          chunks: [...textParts("t1", ["ok"]), FINISH],
        }),
      }),
    });
    const port = new LlmModelPort({
      model: async (): Promise<LlmModelResolution> => ({
        kind: "available",
        model: mock as unknown as LanguageModel,
        routing: {
          outcome: "selected",
          selector: "auto",
          resolution: "effort_preset",
          // `deriveModelProfiles` ids a preset's head profile by the preset name, so this *is* the
          // rung `auto` landed on for this deployment.
          profileId: "fast",
          chain: [{ profileId: "fast", modelId: "claude-haiku-5" }],
          cacheAllowed: true,
          rejectedFallbacks: [],
        },
      }),
      now: () => 0,
    });

    await port.invoke(request({ modelProfileId: "auto" }));

    expect(port.latestModelCallReceipt()).toMatchObject({
      effortPreset: "auto",
      effortApplied: "fast",
    });
  });

  it("claims no applied rung when a preset resolves to a non-rung ModelProfile", async () => {
    const mock = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream<StreamPart>({
          chunks: [...textParts("t1", ["ok"]), FINISH],
        }),
      }),
    });
    const port = new LlmModelPort({
      model: async (): Promise<LlmModelResolution> => ({
        kind: "available",
        model: mock as unknown as LanguageModel,
        routing: {
          outcome: "selected",
          selector: "auto",
          resolution: "effort_preset",
          profileId: "house-counsel",
          chain: [{ profileId: "house-counsel", modelId: "claude-opus-5" }],
          cacheAllowed: true,
          rejectedFallbacks: [],
        },
      }),
      now: () => 0,
    });

    await port.invoke(request({ modelProfileId: "auto" }));

    const receipt = port.latestModelCallReceipt();
    expect(receipt?.effortPreset).toBe("auto");
    expect(receipt?.effortApplied).toBeUndefined();
  });

  it("keeps no receipt on a port whose model call never completed", async () => {
    const port = new LlmModelPort({
      model: async (): Promise<LlmModelResolution> => ({
        kind: "denied",
        routing: {
          outcome: "denied",
          selector: "balanced",
          resolution: "effort_preset",
          profileId: "primary",
          reason: "tools_unsupported",
          attempts: [{ profileId: "primary", reason: "tools_unsupported" }],
        },
      }),
    });

    await expect(port.invoke(request({ modelProfileId: "balanced" }))).rejects.toThrow();
    expect(port.latestModelCallReceipt()).toBeUndefined();
  });

  it("emits denial evidence before refusing a model call", async () => {
    const emitted: unknown[] = [];
    const port = new LlmModelPort({
      model: async (): Promise<LlmModelResolution> => ({
        kind: "denied",
        routing: {
          outcome: "denied",
          selector: "balanced",
          resolution: "effort_preset",
          profileId: "primary",
          reason: "tools_unsupported",
          attempts: [{ profileId: "primary", reason: "tools_unsupported" }],
        },
      }),
      routingEvents: {
        emit: async (_type, payload) => {
          emitted.push(payload);
        },
      },
    });

    await expect(port.invoke(request({ modelProfileId: "balanced" }))).rejects.toThrow(
      'model profile "primary" denied: tools_unsupported'
    );
    expect(emitted).toEqual([
      {
        outcome: "denied",
        selector: "balanced",
        resolution: "effort_preset",
        profileId: "primary",
        reason: "tools_unsupported",
        attempts: [{ profileId: "primary", reason: "tools_unsupported" }],
      },
    ]);
  });

  it("treats a call as the answer even when the model narrated first", async () => {
    // A provider that explains itself before calling has not answered yet; reading the narration
    // as the answer would end the turn one step early.
    const { port } = model([
      ...textParts("t1", ["let me look that up"]),
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "list_tasks",
        input: JSON.stringify({ limit: 3 }),
      },
      FINISH,
    ]);

    const result = await port.invoke(request());

    expect(result.output).toEqual({
      kind: "tool_calls",
      calls: [{ callId: "call-1", name: "list_tasks", arguments: { limit: 3 } }],
    });
  });

  it("declares Tools without an executor, so dispatch can only go through the broker", async () => {
    // An `execute` here would be a second effect path beside the Tool Broker.
    const { port, calls } = model([...textParts("t1", ["ok"]), FINISH]);

    await port.invoke(
      request({
        tools: [
          {
            name: "list_tasks",
            description: "Lists tasks",
            inputSchema: { type: "object", properties: { limit: { type: "number" } } },
          },
        ],
      })
    );

    const tools = calls()[0]?.tools ?? [];
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ type: "function", name: "list_tasks" });
  });

  it("sends instructions apart from the transcript, which is where the SDK takes them", async () => {
    // A system message inside `messages` is rejected outright — every turn would fail.
    const { port, calls } = model([...textParts("t1", ["ok"]), FINISH]);

    await port.invoke(
      request({
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "hi" },
          { role: "assistant", content: "one moment" },
          // Already rendered to text by the loop, and no longer naming the call it answered.
          { role: "tool", content: "3 tasks" },
        ],
      })
    );

    // The SDK re-attaches instructions as leading system messages on the provider prompt; what it
    // refuses is being handed them inside `messages`.
    expect(calls()[0]?.prompt).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "one moment" }] },
      { role: "user", content: [{ type: "text", text: "3 tasks" }] },
    ]);
  });

  it("renders the loop's tool-call record as a real tool-call/tool-result pair, linked by callId", async () => {
    // Without this linkage a rejected call's error arrives as an unattributed user message and the
    // model has no way to tell it is feedback on its own last action — it just repeats the call.
    const { port, calls } = model([...textParts("t1", ["ok"]), FINISH]);

    await port.invoke(
      request({
        messages: [
          { role: "user", content: "create a ticket called first ticket" },
          {
            role: "assistant",
            content: JSON.stringify({
              toolCalls: [
                { callId: "call-1", name: "record_create", arguments: { type: "ticket" } },
              ],
            }),
          },
          {
            role: "tool",
            content: JSON.stringify({
              callId: "call-1",
              error: "invalid_arguments",
              detail: "must have required property 'status'",
            }),
          },
        ],
      })
    );

    expect(calls()[0]?.prompt).toEqual([
      { role: "user", content: [{ type: "text", text: "create a ticket called first ticket" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "record_create",
            input: { type: "ticket" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "record_create",
            output: {
              type: "text",
              value: JSON.stringify({
                error: "invalid_arguments",
                detail: "must have required property 'status'",
              }),
            },
          },
        ],
      },
    ]);
  });
});
