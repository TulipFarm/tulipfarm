import type {
  ModelInvocationRequest,
  ModelInvocationResult,
  ModelOutput,
  ModelPort,
} from "@tulipfarm/agent-runtime";
import {
  generateText,
  jsonSchema,
  type LanguageModel,
  type ModelMessage as SdkMessage,
  type SystemModelMessage,
  type ToolSet,
  tool,
} from "ai";

/**
 * A `ModelPort` for evals backed by the Soul's configured providers.
 *
 * Unlike the Worker's streaming `LlmModelPort`, evals only need the final result, so this
 * implements `invoke` via `generateText`. Tools are declared WITHOUT `execute` (same rule as the
 * worker): the provider stops at the tool call and hands it back, so the harness can grade the
 * decision without running an effect. The agent-loop target's dispatch port owns whether anything
 * actually happens.
 */

function toOutput(
  calls: Awaited<ReturnType<typeof generateText>>["toolCalls"],
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

export function llmEvalModelPort(model: LanguageModel): ModelPort {
  return {
    async invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult> {
      const { instructions, messages } = splitPrompt(request.messages);
      const result = await generateText({
        model,
        messages: [...instructions, ...messages],
        ...(request.tools === undefined || request.tools.length === 0
          ? {}
          : { tools: toToolSet(request.tools) }),
        ...(request.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: request.maxOutputTokens }),
      });
      return {
        requestId: request.requestId,
        output: toOutput(result.toolCalls, result.text),
        usage: {
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
        },
      };
    },
  };
}
