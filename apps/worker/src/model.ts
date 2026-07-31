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
 * A `tool` message arrives here already rendered to text by the loop, and the call it answered is
 * no longer identifiable — so it is carried as a user message rather than as a tool result the
 * provider would reject for naming no call.
 */
function splitPrompt(transcript: readonly { role: string; content: string }[]): {
  instructions: SystemModelMessage[];
  messages: SdkMessage[];
} {
  const instructions: SystemModelMessage[] = [];
  const messages: SdkMessage[] = [];
  for (const message of transcript) {
    if (message.role === "system") {
      instructions.push({ role: "system", content: message.content });
    } else if (message.role === "assistant") {
      messages.push({ role: "assistant", content: message.content });
    } else {
      messages.push({ role: "user", content: message.content });
    }
  }
  return { instructions, messages };
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
