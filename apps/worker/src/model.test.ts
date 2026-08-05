import type { ModelInvocationRequest, ModelStreamChunk } from "@tulipfarm/agent-runtime";
import type { LanguageModel } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
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
    port: new LlmModelPort({ model: async () => mock as unknown as LanguageModel }),
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
