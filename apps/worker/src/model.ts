import type {
  ModelInvocationRequest,
  ModelInvocationResult,
  ModelOutput,
  ModelPort,
  ModelStreamChunk,
} from "@tulipfarm/agent-runtime";
import {
  jsonSchema,
  type LanguageModel,
  type ModelMessage as SdkMessage,
  type SystemModelMessage,
  streamText,
  type ToolCallPart,
  type ToolResultPart,
  type ToolSet,
  tool,
} from "ai";

/**
 * `ModelPort` over the Soul's configured providers (plan §2).
 *
 * The Agent loop owns the Tool loop, so the Tools declared here deliberately have **no** `execute`:
 * the provider stops at the tool call and hands it back, and dispatch goes through the Tool Broker
 * where authorization and effects belong. Letting the SDK run a Tool would put an effect path
 * beside the broker, which is exactly the second authority the architecture forbids.
 *
 * Streaming is the primary path because a participant should see text as it is produced; `invoke`
 * is the same call drained to its result, so a caller that only wants the outcome behaves
 * identically.
 */

export interface LlmModelPortOptions {
  /**
   * The provider for a resolved model id. Asked per call rather than held, so a Soul that
   * republishes its providers mid-turn is honoured on the next iteration instead of on restart.
   */
  model(modelId: string): Promise<LanguageModel>;
  /** Aborts an in-flight model call when the worker is draining. */
  readonly signal?: AbortSignal;
}

export class LlmModelPort implements ModelPort {
  constructor(private readonly options: LlmModelPortOptions) {}

  async invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult> {
    for await (const chunk of this.stream(request)) {
      if (chunk.kind === "completed") return chunk.result;
    }
    throw new Error("model stream ended without a result");
  }

  async *stream(request: ModelInvocationRequest): AsyncIterable<ModelStreamChunk> {
    const { instructions, messages } = splitPrompt(request.messages);
    const result = streamText({
      model: await this.options.model(request.modelProfileId),
      messages,
      ...(instructions.length === 0 ? {} : { instructions }),
      ...(request.tools === undefined || request.tools.length === 0
        ? {}
        : { tools: toToolSet(request.tools) }),
      ...(request.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: request.maxOutputTokens }),
      ...(this.options.signal === undefined ? {} : { abortSignal: this.options.signal }),
    });

    for await (const part of result.fullStream) {
      if (part.type === "text-delta" && part.text.length > 0) {
        yield { kind: "text_delta", text: part.text };
      }
    }

    const [calls, text, usage] = await Promise.all([result.toolCalls, result.text, result.usage]);

    yield {
      kind: "completed",
      result: {
        requestId: request.requestId,
        output: toOutput(calls, text),
        usage: {
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
        },
      },
    };
  }
}

/**
 * A model answer as the loop reads it.
 *
 * Tool calls win over text when both are present: a provider that narrates before calling has not
 * answered yet, and treating that narration as the answer would end the turn one step early.
 */
function toOutput(
  calls: Awaited<ReturnType<typeof streamText>["toolCalls"]>,
  text: string
): ModelOutput {
  if (calls.length > 0) {
    return {
      kind: "tool_calls",
      calls: calls.map((call) => ({
        callId: call.toolCallId,
        name: call.toolName,
        arguments: call.input,
      })),
    };
  }
  return { kind: "text", text };
}

/**
 * The loop's flat transcript as a provider prompt.
 *
 * System messages are separated out: the SDK refuses them inside `messages` and takes them through
 * `instructions`, which is also the honest shape — an instruction is not a turn in the
 * conversation, and their order relative to the transcript carries no meaning.
 *
 * An `assistant` message that records the loop's own proposed tool calls (see
 * `assistantToolCallMessage` in the loop) is rendered as real `tool-call` parts, and the `tool`
 * messages answering them are rendered as `tool-result` parts on the toolCallId they name. Without
 * this the result would arrive as an unattributed user message and the provider — and the model
 * reading it — would have no way to tell it is feedback on the model's own last action, which is
 * why a rejected call used to repeat forever instead of being corrected.
 */
function splitPrompt(transcript: readonly { role: string; content: string }[]): {
  instructions: SystemModelMessage[];
  messages: SdkMessage[];
} {
  const instructions: SystemModelMessage[] = [];
  const messages: SdkMessage[] = [];
  const toolNamesByCallId = new Map<string, string>();
  let pendingResults: ToolResultPart[] = [];

  const flushResults = () => {
    if (pendingResults.length > 0) {
      messages.push({ role: "tool", content: pendingResults });
      pendingResults = [];
    }
  };

  for (const message of transcript) {
    if (message.role === "system") {
      flushResults();
      instructions.push({ role: "system", content: message.content });
      continue;
    }

    if (message.role === "assistant") {
      const calls = parseToolCalls(message.content);
      if (calls === undefined) {
        flushResults();
        messages.push({ role: "assistant", content: message.content });
        continue;
      }
      flushResults();
      for (const call of calls) toolNamesByCallId.set(call.callId, call.name);
      const parts: ToolCallPart[] = calls.map((call) => ({
        type: "tool-call",
        toolCallId: call.callId,
        toolName: call.name,
        input: call.arguments,
      }));
      messages.push({ role: "assistant", content: parts });
      continue;
    }

    if (message.role === "tool") {
      const result = parseToolResult(message.content);
      if (result !== undefined) {
        pendingResults.push({
          type: "tool-result",
          toolCallId: result.callId,
          toolName: toolNamesByCallId.get(result.callId) ?? "unknown",
          output: { type: "text", value: JSON.stringify(result.payload) },
        });
        continue;
      }
    }

    flushResults();
    messages.push({ role: "user", content: message.content });
  }
  flushResults();
  return { instructions, messages };
}

/** Recognizes the loop's `assistantToolCallMessage` encoding; any other assistant text passes through. */
function parseToolCalls(
  content: string
): readonly { callId: string; name: string; arguments: unknown }[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("toolCalls" in parsed) ||
    !Array.isArray((parsed as { toolCalls: unknown }).toolCalls)
  ) {
    return undefined;
  }
  return (parsed as { toolCalls: unknown[] }).toolCalls.flatMap((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { callId?: unknown }).callId !== "string" ||
      typeof (entry as { name?: unknown }).name !== "string"
    ) {
      return [];
    }
    const call = entry as { callId: string; name: string; arguments: unknown };
    return [{ callId: call.callId, name: call.name, arguments: call.arguments }];
  });
}

/** Recognizes the loop's `toolMessage` encoding: `{ callId, ...payload }`. */
function parseToolResult(
  content: string
): { callId: string; payload: Record<string, unknown> } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { callId?: unknown }).callId !== "string"
  ) {
    return undefined;
  }
  const { callId, ...payload } = parsed as { callId: string } & Record<string, unknown>;
  return { callId, payload };
}

function toToolSet(
  tools: readonly {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema: Readonly<Record<string, unknown>>;
  }[]
): ToolSet {
  return Object.fromEntries(
    tools.map((definition) => [
      definition.name,
      tool({
        ...(definition.description === undefined ? {} : { description: definition.description }),
        inputSchema: jsonSchema(definition.inputSchema as Parameters<typeof jsonSchema>[0]),
      }),
    ])
  );
}
