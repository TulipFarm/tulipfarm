import type {
  AgentLoopInput,
  ModelInvocationRequest,
  ModelRequirements,
  ModelRequirementsPolicy,
  ModelStreamChunk,
} from "@tulipfarm/agent-runtime";
import {
  AgentLoop,
  InMemoryLoopCheckpointStore,
  ModelInvocationError,
} from "@tulipfarm/agent-runtime";
import { type CostBasis, FallbackModel, LlmProviderError } from "@tulipfarm/llm";
import {
  type EffortRung,
  LlmNotConfiguredError,
  type RunEventEffortInference,
  textContent,
} from "@tulipfarm/schema";
import { APICallError, type LanguageModel } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import type { EffortInferencePort } from "./effort-inference";
import type { LlmModelResolution } from "./llm";
import { LlmModelPort } from "./model";
import { type ModelCallGate, ProviderGate } from "./model-gate";
import type { SpendSink } from "./observability";

/**
 * These tests exercise streaming, cancellation and receipts, not pricing. Pricing itself belongs
 * to `SoulLlm`, which knows the provider and which chain link answered; the port only reports what
 * the resolution hands it. `unpriced` is the honest default for a mock model no authority prices.
 */
const TEST_PRICE = (): CostBasis => ({ kind: "unpriced" });

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
        price: TEST_PRICE,
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
  messages: [{ role: "user", content: textContent("hello") }],
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
        // Reported as unpriced, never as free: nobody could price this call.
        usage: { inputTokens: 11, outputTokens: 4, costBasis: "unpriced" },
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
        price: TEST_PRICE,
        model: mock as unknown as LanguageModel,
        routing: {
          outcome: "raw_model",
          selector,
          resolution: "raw_model_id",
          modelId: selector,
        },
        attemptedModelId: () => "gpt-5.6-terra",
      }),
    });

    await expect(port.invoke(request())).rejects.toMatchObject({
      name: "ModelInvocationError",
      reason: "model_billing_inactive",
      modelId: "gpt-5.6-terra",
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
        price: TEST_PRICE,
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
        price: TEST_PRICE,
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

  /** A selected chain with more than one link, so the head is not necessarily who answers. */
  function selectedPort(price: (tokensIn: number, tokensOut: number) => CostBasis): LlmModelPort {
    const mock = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream<StreamPart>({
          chunks: [...textParts("t1", ["ok"]), FINISH],
        }),
      }),
    });
    return new LlmModelPort({
      model: async (): Promise<LlmModelResolution> => ({
        kind: "available",
        price,
        model: mock as unknown as LanguageModel,
        routing: {
          outcome: "selected",
          selector: "balanced",
          resolution: "effort_preset",
          profileId: "primary",
          chain: [
            { profileId: "primary", modelId: "claude-sonnet-4-6" },
            { profileId: "primary", modelId: "claude-haiku-4-5" },
          ],
          cacheAllowed: true,
          rejectedFallbacks: [],
        },
      }),
    });
  }

  it("reports the cost the resolution priced, against the real token counts", async () => {
    // The port does not price. It hands the served token counts to the authority that knows the
    // provider and which chain link answered, and reports that answer unchanged.
    const seen: Array<[number, number]> = [];
    const port = selectedPort((tokensIn, tokensOut) => {
      seen.push([tokensIn, tokensOut]);
      return { kind: "priced", costUsd: 0.000093, source: "table" };
    });

    await expect(port.invoke(request({ modelProfileId: "balanced" }))).resolves.toMatchObject({
      usage: { inputTokens: 11, outputTokens: 4, costUsd: 0.000093, costBasis: "priced" },
    });
    expect(seen).toEqual([[11, 4]]);
  });

  it("reports an unpriceable call as unpriced rather than omitting cost silently", async () => {
    // An absent `costUsd` alone reads as free downstream. The basis says the cost is unknown.
    const result = await selectedPort(() => ({ kind: "unpriced" })).invoke(
      request({ modelProfileId: "balanced" })
    );
    expect(result.usage).toMatchObject({ costBasis: "unpriced" });
    expect(result.usage).not.toHaveProperty("costUsd");
  });

  it("reports a subscription seat as unmetered, not as an unpriced call", async () => {
    // A seat's zero cost is known; an unpriced call's is unknown. Downstream must tell them apart.
    const result = await selectedPort(() => ({ kind: "subscription" })).invoke(
      request({ modelProfileId: "balanced" })
    );
    expect(result.usage).toMatchObject({ costBasis: "subscription" });
    expect(result.usage).not.toHaveProperty("costUsd");
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
        price: TEST_PRICE,
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
        price: TEST_PRICE,
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
        price: TEST_PRICE,
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

  it("preserves an unconfigured model route as a participant-safe failure", async () => {
    const port = new LlmModelPort({
      model: async () => {
        throw new LlmNotConfiguredError();
      },
    });

    await expect(port.invoke(request({ modelProfileId: "auto" }))).rejects.toMatchObject({
      name: "ModelInvocationError",
      reason: "model_not_configured",
    });
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

    await expect(port.invoke(request({ modelProfileId: "balanced" }))).rejects.toMatchObject({
      name: "ModelInvocationError",
      reason: "model_error",
      cause: new Error('model profile "primary" denied: tools_unsupported'),
    });
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
          { role: "system", content: textContent("be brief") },
          { role: "user", content: textContent("hi") },
          { role: "assistant", content: textContent("one moment") },
          // Already rendered to text by the loop, and no longer naming the call it answered.
          { role: "tool", content: textContent("3 tasks") },
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
          { role: "user", content: textContent("create a ticket called first ticket") },
          {
            role: "assistant",
            content: textContent(
              JSON.stringify({
                toolCalls: [
                  { callId: "call-1", name: "record_create", arguments: { type: "ticket" } },
                ],
              })
            ),
          },
          {
            role: "tool",
            content: textContent(
              JSON.stringify({
                callId: "call-1",
                error: "invalid_arguments",
                detail: "must have required property 'status'",
              })
            ),
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

describe("LlmModelPort effort inference", () => {
  /** A resolution that reports back whatever rung was inferred, as `SoulLlm` does. */
  function inferringPort(
    effort: EffortInferencePort | undefined,
    onResolve: (inference: RunEventEffortInference | undefined) => void
  ): LlmModelPort {
    const mock = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream<StreamPart>({
          chunks: [...textParts("t1", ["ok"]), FINISH],
        }),
      }),
    });
    return new LlmModelPort({
      ...(effort === undefined ? {} : { effort }),
      model: async (selector, _requirements, inference): Promise<LlmModelResolution> => {
        onResolve(inference);
        const profileId = inference?.rung ?? selector;
        return {
          kind: "available",
          price: TEST_PRICE,
          model: mock as unknown as LanguageModel,
          routing: {
            outcome: "selected",
            selector,
            resolution: inference === undefined ? "effort_preset" : "effort_inferred",
            profileId,
            chain: [{ profileId, modelId: "claude-sonnet-5" }],
            cacheAllowed: true,
            rejectedFallbacks: [],
            ...(inference === undefined ? {} : { effortInference: inference }),
          },
        };
      },
      now: () => 0,
    });
  }

  const inference = (rung: EffortRung): RunEventEffortInference => ({
    rung,
    score: 4,
    firedSignals: ["design_keywords"],
    band: rung,
    usedClassifier: false,
    promptHash: "c".repeat(64),
  });

  it("infers the rung for a turn that asked for auto", async () => {
    const seen: (RunEventEffortInference | undefined)[] = [];
    const effort = { infer: vi.fn(async () => inference("thorough")) };
    const port = inferringPort(effort, (value) => seen.push(value));

    await port.invoke(request({ modelProfileId: "auto" }));

    expect(effort.infer).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([inference("thorough")]);
  });

  it("infers once per attempt, however many model calls the Tool loop makes", async () => {
    const effort = { infer: vi.fn(async () => inference("balanced")) };
    const port = inferringPort(effort, () => {});

    await port.invoke(request({ modelProfileId: "auto" }));
    await port.invoke(request({ modelProfileId: "auto", requestId: "request-2" }));
    await port.invoke(request({ modelProfileId: "auto", requestId: "request-3" }));

    expect(effort.infer).toHaveBeenCalledTimes(1);
  });

  it("scores the latest user message, not the assistant's own words", async () => {
    const scored: string[] = [];
    const effort: EffortInferencePort = {
      infer: async (prompt) => {
        scored.push(prompt);
        return inference("fast");
      },
    };
    const port = inferringPort(effort, () => {});

    await port.invoke(
      request({
        modelProfileId: "auto",
        messages: [
          { role: "system", content: textContent("You are a careful assistant.") },
          { role: "user", content: textContent("first question") },
          {
            role: "assistant",
            content: textContent("a long architectural essay about trade-offs"),
          },
          { role: "user", content: textContent("and the follow-up") },
        ],
      })
    );

    expect(scored).toEqual(["and the follow-up"]);
  });

  it("leaves a rung the participant picked alone", async () => {
    const effort = { infer: vi.fn(async () => inference("thorough")) };
    const port = inferringPort(effort, () => {});

    await port.invoke(request({ modelProfileId: "fast" }));

    expect(effort.infer).not.toHaveBeenCalled();
  });

  it("leaves a named ModelProfile alone", async () => {
    const effort = { infer: vi.fn(async () => inference("thorough")) };
    const port = inferringPort(effort, () => {});

    await port.invoke(request({ modelProfileId: "house-counsel" }));

    expect(effort.infer).not.toHaveBeenCalled();
  });

  it("does not re-ask when a turn has no user text to score", async () => {
    const effort = { infer: vi.fn(async () => inference("balanced")) };
    const port = inferringPort(effort, () => {});
    const blank = {
      messages: [
        { role: "assistant" as const, content: textContent("Anything else?") },
        { role: "user" as const, content: textContent("   ") },
      ],
    };

    await port.invoke(request({ modelProfileId: "auto", ...blank }));
    await port.invoke(request({ modelProfileId: "auto", requestId: "request-2", ...blank }));

    expect(effort.infer).not.toHaveBeenCalled();
  });

  it("routes as before when no inference is wired at all", async () => {
    const seen: (RunEventEffortInference | undefined)[] = [];
    const port = inferringPort(undefined, (value) => seen.push(value));

    await port.invoke(request({ modelProfileId: "auto" }));

    expect(seen).toEqual([undefined]);
  });

  it("keeps the receipt reporting auto and the rung the router landed on", async () => {
    const port = inferringPort({ infer: async () => inference("thorough") }, () => {});

    await port.invoke(request({ modelProfileId: "auto" }));

    expect(port.latestModelCallReceipt()).toMatchObject({
      effortPreset: "auto",
      effortApplied: "thorough",
    });
  });
});

describe("LlmModelPort — governance", () => {
  /** Captures the requirements the port derived, which is what profile selection is judged on. */
  function capturing(policy?: ModelRequirementsPolicy) {
    const seen: ModelRequirements[] = [];
    const mock = new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream<StreamPart>({ chunks: [FINISH] }) }),
    });
    const port = new LlmModelPort({
      model: async (selector, requirements): Promise<LlmModelResolution> => {
        seen.push(requirements);
        return {
          kind: "available",
          price: TEST_PRICE,
          model: mock as unknown as LanguageModel,
          routing: {
            outcome: "raw_model",
            selector,
            resolution: "raw_model_id",
            modelId: selector,
          },
        };
      },
      ...(policy === undefined ? {} : { policy }),
    });
    return { port, seen };
  }

  async function drain(port: LlmModelPort, req: ModelInvocationRequest): Promise<void> {
    for await (const _ of port.stream(req)) {
      // consume
    }
  }

  it("carries the turn's governance from the request into the requirements", async () => {
    // The port is built before the turn's Context resolves, so it cannot know which Agent acts.
    // If governance did not ride the request, it could never reach profile selection at all.
    const { port, seen } = capturing();

    await drain(port, request({ policy: { residency: "eu", dataRetention: "none" } }));

    expect(seen[0]).toMatchObject({ residency: "eu", dataRetention: "none" });
  });

  it("lets the turn's governance override the process-wide floor", async () => {
    const { port, seen } = capturing({ residency: "us" });

    await drain(port, request({ policy: { residency: "eu" } }));

    expect(seen[0]).toMatchObject({ residency: "eu" });
  });

  it("falls back to the process-wide floor when the request carries no governance", async () => {
    const { port, seen } = capturing({ residency: "us" });

    await drain(port, request());

    expect(seen[0]).toMatchObject({ residency: "us" });
  });
});

describe("LlmModelPort — wall clock", () => {
  it("aborts a provider that accepts the connection and then never answers", async () => {
    // The AI SDK sets no default fetch timeout and both production port constructions omitted the
    // optional signal, so this call would previously have hung forever holding the Run's lease.
    const hung = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream<StreamPart>({
          start() {
            // never enqueues, never closes
          },
        }),
      }),
    });
    const port = new LlmModelPort({
      model: async (selector): Promise<LlmModelResolution> => ({
        kind: "available",
        price: TEST_PRICE,
        model: hung as unknown as LanguageModel,
        routing: {
          outcome: "raw_model",
          selector,
          resolution: "raw_model_id",
          modelId: selector,
        },
      }),
      stallTimeoutMs: 50,
    });

    await expect(async () => {
      for await (const _ of port.stream(request())) {
        // consume
      }
    }).rejects.toThrow(ModelInvocationError);
  });
});

describe("LlmModelPort — what a call actually consumed", () => {
  it("reports the cache and reasoning splits the provider returned", async () => {
    const { port } = model([
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: "hi" },
      { type: "text-end", id: "1" },
      {
        type: "finish",
        finishReason: { unified: "stop", raw: "end_turn" },
        usage: {
          inputTokens: { total: 100, noCache: 20, cacheRead: 70, cacheWrite: 10 },
          outputTokens: { total: 50, text: 20, reasoning: 30 },
        },
      },
    ]);

    const chunks = await collect(port.stream(request()));
    const completed = chunks.find((c) => c.kind === "completed");

    // Folding these into the totals would make this call indistinguishable from one that read
    // nothing from cache and reasoned not at all — at several times the price.
    expect(completed?.result.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 70,
      cacheWriteTokens: 10,
      reasoningTokens: 30,
    });
  });

  it("omits the splits entirely when the provider reports none", async () => {
    const { port } = model([
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: "hi" },
      { type: "text-end", id: "1" },
      FINISH,
    ]);

    const chunks = await collect(port.stream(request()));
    const completed = chunks.find((c) => c.kind === "completed");

    expect(completed?.result.usage).not.toHaveProperty("cacheReadTokens");
    expect(completed?.result.usage).not.toHaveProperty("reasoningTokens");
  });

  it("carries what was already spent out on a mid-stream failure", async () => {
    const { port } = model([
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: "partial answer" },
      {
        type: "finish",
        finishReason: { unified: "stop", raw: "end_turn" },
        usage: {
          inputTokens: { total: 900, noCache: 900, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 40, text: 40, reasoning: 0 },
        },
      },
      { type: "error", error: new Error("connection reset") },
    ]);

    // The participant already has the partial answer and the provider already billed for it.
    // Reporting no usage here is what let a failure loop spend without touching the budget.
    const error = await collect(port.stream(request())).then(
      () => undefined,
      (err: unknown) => err
    );

    expect(error).toBeInstanceOf(ModelInvocationError);
    expect((error as ModelInvocationError).usage).toMatchObject({
      inputTokens: 900,
      outputTokens: 40,
    });
  });

  it("reports no usage when the call failed before the provider consumed anything", async () => {
    const { port } = model([
      { type: "text-start", id: "1" },
      { type: "error", error: new Error("connection reset") },
    ]);

    // The SDK still synthesises a zero-usage step here, so a naive "did anything arrive" test
    // would write an empty row into the spend ledger for every failed connection.
    const error = await collect(port.stream(request())).then(
      () => undefined,
      (err: unknown) => err
    );

    expect((error as ModelInvocationError).usage).toBeUndefined();
  });
});

describe("LlmModelPort — reporting spend", () => {
  function spy() {
    const calls: Parameters<SpendSink["recordLlmCall"]>[0][] = [];
    return {
      calls,
      sink: {
        recordLlmCall: (record: Parameters<SpendSink["recordLlmCall"]>[0]) => calls.push(record),
        recordTurn: () => undefined,
      } satisfies SpendSink,
    };
  }

  function portWith(parts: StreamPart[], sink: SpendSink): LlmModelPort {
    const mock = new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream<StreamPart>({ chunks: parts }) }),
    });
    return new LlmModelPort({
      model: async (selector): Promise<LlmModelResolution> => ({
        kind: "available",
        price: (tokensIn, tokensOut) => ({
          kind: "priced",
          costUsd: (tokensIn + tokensOut) / 1000,
          source: "table",
        }),
        provider: "anthropic",
        model: mock as unknown as LanguageModel,
        routing: {
          outcome: "raw_model",
          selector,
          resolution: "raw_model_id",
          modelId: selector,
        },
      }),
      spend: sink,
      conversationId: "conv-1",
    });
  }

  it("reports a completed call to the spend ledger", async () => {
    const { calls, sink } = spy();
    const port = portWith(
      [
        { type: "text-start", id: "1" },
        { type: "text-delta", id: "1", delta: "hi" },
        { type: "text-end", id: "1" },
        FINISH,
      ],
      sink
    );

    await collect(port.stream(request({ agentId: "support" })));

    // Nothing in production emitted this, so every cost view read zero — which is
    // indistinguishable from a quiet week, and is why it was never noticed.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      status: "ok",
      conversationId: "conv-1",
      agentId: "support",
      provider: "anthropic",
      model: "claude-opus-5",
      usage: { inputTokens: 11, outputTokens: 4 },
    });
  });

  it("reports a failed call, not only a successful one", async () => {
    const { calls, sink } = spy();
    const port = portWith(
      [
        { type: "text-start", id: "1" },
        { type: "text-delta", id: "1", delta: "partial" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "end_turn" },
          usage: {
            inputTokens: { total: 900, noCache: 900, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 40, text: 40, reasoning: 0 },
          },
        },
        { type: "error", error: new Error("connection reset") },
      ],
      sink
    );

    await collect(port.stream(request())).catch(() => undefined);

    expect(calls[0]).toMatchObject({
      status: "error",
      usage: { inputTokens: 900, outputTokens: 40 },
    });
  });
});

describe("LlmModelPort — the zero-output diagnostic is not a content leak", () => {
  const EMPTY_FINISH: StreamPart = {
    type: "finish",
    finishReason: { unified: "stop", raw: "end_turn" },
    usage: {
      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
    },
  };

  const SECRET = "quarterly revenue was forty-one million dollars";

  async function diagnose(): Promise<string> {
    const { port } = model([EMPTY_FINISH]);
    try {
      for await (const _ of port.stream(
        request({
          messages: [
            { role: "user", content: textContent(SECRET) },
            { role: "assistant", content: textContent("acknowledged") },
            { role: "user", content: textContent(`${SECRET} again`) },
          ],
        })
      )) {
        // drained for the throw
      }
    } catch (err) {
      // The loop logs the deepest cause, not the wrapper — that is the string that reaches ops.
      let current: unknown = err;
      while (current instanceof Error && current.cause !== undefined) current = current.cause;
      return current instanceof Error ? current.message : String(current);
    }
    throw new Error("expected the empty call to be reported as a fault");
  }

  it("reports the fault without putting message content in the message", async () => {
    const message = await diagnose();
    expect(message).toContain("model call produced no output");
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain("acknowledged");
  });

  it("still says enough to diagnose: shape, sizes and a correlatable digest", async () => {
    const message = await diagnose();
    expect(message).toMatch(/request=sha256:[0-9a-f]{12}\/\d+b/);
    expect(message).toContain('"messageCount":3');
    expect(message).toContain('"roles":["user","assistant","user"]');
    expect(message).toContain(`"chars":${`${SECRET} again`.length}`);
  });

  it("is stable across calls, so repeat failures correlate", async () => {
    const [a, b] = await Promise.all([diagnose(), diagnose()]);
    const digest = (m: string) => /request=(sha256:[0-9a-f]{12})/.exec(m)?.[1];
    expect(digest(a)).toBe(digest(b));
    expect(digest(a)).toBeDefined();
  });
});

/**
 * The metering half of prompt caching shipped long before the asking half. These pin the ask
 * itself: the decision is unit-tested in `@tulipfarm/llm`, so what matters here is that it reaches
 * the provider wire, and that routing's refusal survives the trip.
 */
describe("LlmModelPort prompt caching", () => {
  const LONG_SYSTEM = "s".repeat(1024 * 5);

  async function promptFor(overrides: {
    cacheAllowed?: boolean;
    provider?: string;
    system?: string;
    raw?: boolean;
  }): Promise<Record<string, unknown>[]> {
    const mock = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream<StreamPart>({
          chunks: [...textParts("t1", ["ok"]), FINISH],
        }),
      }),
    });
    const port = new LlmModelPort({
      model: async (selector): Promise<LlmModelResolution> => ({
        kind: "available",
        price: TEST_PRICE,
        model: mock as unknown as LanguageModel,
        provider: overrides.provider ?? "anthropic",
        routing: overrides.raw
          ? { outcome: "raw_model", selector, resolution: "raw_model_id", modelId: selector }
          : {
              outcome: "selected",
              selector,
              resolution: "effort_preset",
              profileId: "primary",
              chain: [{ profileId: "primary", modelId: "claude-sonnet-5" }],
              cacheAllowed: overrides.cacheAllowed ?? true,
              rejectedFallbacks: [],
            },
      }),
    });
    await port.invoke(
      request({
        messages: [
          { role: "system", content: textContent(overrides.system ?? LONG_SYSTEM) },
          { role: "user", content: textContent("hello") },
        ],
      })
    );
    return mock.doStreamCalls[0]?.prompt as unknown as Record<string, unknown>[];
  }

  const breakpointOn = (prompt: Record<string, unknown>[]): unknown =>
    prompt.find((m) => m.role === "system")?.providerOptions;

  it("asks the provider to cache a long, allowed instruction prefix", async () => {
    expect(breakpointOn(await promptFor({}))).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
  });

  it("sends no breakpoint when routing withheld caching, which is how sensitive prompts stay out", async () => {
    expect(breakpointOn(await promptFor({ cacheAllowed: false }))).toBeUndefined();
  });

  it("sends no breakpoint for a raw model id, because no profile checked sensitivity", async () => {
    expect(breakpointOn(await promptFor({ raw: true }))).toBeUndefined();
  });

  it("sends no breakpoint to a provider that caches without being asked", async () => {
    expect(breakpointOn(await promptFor({ provider: "openai" }))).toBeUndefined();
  });

  it("sends no breakpoint on a prefix too short for the provider to cache", async () => {
    expect(breakpointOn(await promptFor({ system: "you are helpful" }))).toBeUndefined();
  });

  it("still delivers the instructions when nothing is cached", async () => {
    const prompt = await promptFor({ cacheAllowed: false });
    expect(prompt.find((m) => m.role === "system")?.content).toBe(LONG_SYSTEM);
  });
});

/**
 * The gate refuses a call before the provider is ever dialled, so nothing in the stream's own
 * failure handling sees it. These pin the whole chain — gate to Turn — because the participant
 * copy for a shed provider already existed and this path could never reach it.
 */
describe("LlmModelPort — a call the provider gate refused", () => {
  const gatedPort = (gate: ModelCallGate, mock: MockLanguageModelV4): LlmModelPort =>
    new LlmModelPort({
      gate,
      model: async (
        selector,
        _requirements,
        _inference,
        _principal,
        linkGate
      ): Promise<LlmModelResolution> => ({
        kind: "available",
        price: TEST_PRICE,
        provider: "openai",
        model: new FallbackModel([mock], undefined, undefined, linkGate, [
          "openai",
        ]) as LanguageModel,
        routing: {
          outcome: "raw_model",
          selector,
          resolution: "raw_model_id",
          modelId: selector,
        },
      }),
    });

  /** Not retryable, so the call fails once and opens the breaker at a known count. */
  const rateLimited = (): APICallError =>
    new APICallError({
      message: "http 429",
      url: "https://provider.test/v1/responses",
      requestBodyValues: {},
      statusCode: 429,
      responseBody: "{}",
      isRetryable: false,
    });

  const failingModel = (): MockLanguageModelV4 =>
    new MockLanguageModelV4({
      doStream: async () => {
        throw rateLimited();
      },
    });

  const healthyModel = (): MockLanguageModelV4 =>
    new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream<StreamPart>({
          chunks: [...textParts("t1", ["hi"]), FINISH],
        }),
      }),
    });

  it("keeps later chats on the fallback while the primary circuit is open", async () => {
    const gate = new ProviderGate({ recoveryAfterMs: 60_000 });
    const sonnet = failingModel();
    const terra = healthyModel();
    const port = (): LlmModelPort =>
      new LlmModelPort({
        gate,
        model: async (
          selector,
          _requirements,
          _inference,
          _principal,
          linkGate
        ): Promise<LlmModelResolution> => ({
          kind: "available",
          price: TEST_PRICE,
          provider: "anthropic",
          model: new FallbackModel([sonnet, terra], undefined, undefined, linkGate, [
            "anthropic",
            "codex",
          ]) as LanguageModel,
          routing: {
            outcome: "selected",
            selector,
            resolution: "profile_ref",
            profileId: "balanced",
            chain: [
              { profileId: "balanced", modelId: "sonnet" },
              { profileId: "balanced-fallback-1", modelId: "terra" },
            ],
            cacheAllowed: false,
            rejectedFallbacks: [],
          },
        }),
      });

    await expect(port().invoke(request())).resolves.toBeDefined();
    await expect(port().invoke(request())).resolves.toBeDefined();

    expect(sonnet.doStreamCalls).toHaveLength(1);
    expect(terra.doStreamCalls).toHaveLength(2);
  });

  it("reports a shed provider as unavailable, not as a generic model failure", async () => {
    const gate = new ProviderGate({ failureThreshold: 1, recoveryAfterMs: 60_000 });

    await expect(gatedPort(gate, failingModel()).invoke(request())).rejects.toMatchObject({
      name: "ModelInvocationError",
      reason: "model_rate_limited",
    });

    const healthy = healthyModel();
    await expect(gatedPort(gate, healthy).invoke(request())).rejects.toMatchObject({
      name: "ModelInvocationError",
      reason: "model_provider_unavailable",
    });
    expect(healthy.doStreamCalls).toHaveLength(0);
  });

  it("reports a call that never got a slot as unavailable", async () => {
    vi.useFakeTimers();
    try {
      const gate = new ProviderGate({ maxConcurrency: 1, queueTimeoutMs: 1_000 });
      // Another turn holds the only slot for longer than this one is willing to queue.
      await gate.acquire("openai");
      const queued = healthyModel();

      const assertion = expect(gatedPort(gate, queued).invoke(request())).rejects.toMatchObject({
        name: "ModelInvocationError",
        reason: "model_provider_unavailable",
      });
      await vi.advanceTimersByTimeAsync(1_001);
      await assertion;

      expect(queued.doStreamCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is the reason the Turn reports, so the participant is told the provider is down", async () => {
    const gate = new ProviderGate({ failureThreshold: 1, recoveryAfterMs: 60_000 });
    const turn = (port: LlmModelPort): AgentLoop =>
      new AgentLoop({
        model: port,
        tools: { dispatch: async () => ({ status: "succeeded", callId: "call-1", output: {} }) },
        checkpoints: new InMemoryLoopCheckpointStore(),
        events: { append: async () => {} },
        budget: { consume: async () => ({ outcome: "allowed" }) },
        isCancelled: async () => false,
      });
    const loopInput: AgentLoopInput = {
      businessId: "biz-1",
      runId: "run-1",
      stateId: "state-1",
      modelProfileId: "balanced",
      contextDigest: "sha256:context",
      guardrailDigest: "sha256:guardrail",
      messages: [{ role: "user", content: textContent("hello") }],
      tools: [],
      limits: { maxIterations: 1, maxToolCalls: 1, maxRepairAttempts: 1 },
    };

    await turn(gatedPort(gate, failingModel())).run(loopInput);
    const outcome = await turn(gatedPort(gate, healthyModel())).run(loopInput);

    expect(outcome).toMatchObject({ status: "failed", reason: "model_provider_unavailable" });
  });
});
