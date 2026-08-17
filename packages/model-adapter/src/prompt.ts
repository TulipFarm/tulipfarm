import type { ModelInvocationRequest, ModelOutput } from "@tulipfarm/agent-runtime";
import type { PromptCacheDecision } from "@tulipfarm/llm";
import {
  jsonSchema,
  type ModelMessage as SdkMessage,
  type SystemModelMessage,
  type streamText,
  type ToolCallPart,
  type ToolResultPart,
  type ToolSet,
  tool,
} from "ai";

/**
 * Translation between the Agent loop transcript and the `ai` SDK prompt shape.
 *
 * Kept apart from the port itself because none of it touches the port: every function here is a
 * pure conversion, and the loop encodings they recognize are what changes when the transcript
 * format does.
 */

/** Tool calls outrank text; narration before a call is not the final answer. */
export function toOutput(
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
 * Size of the part of the prompt that repeats unchanged between turns.
 *
 * Tool declarations sit ahead of the instructions in the provider's cacheable prefix and are just
 * as stable, so leaving them out would under-measure a prompt that is mostly tool schemas.
 */
export function stablePrefixChars(
  instructions: readonly SystemModelMessage[],
  tools: ModelInvocationRequest["tools"]
): number {
  const instructionChars = instructions.reduce((total, m) => total + m.content.length, 0);
  const toolChars = (tools ?? []).reduce(
    (total, t) =>
      total + t.name.length + (t.description?.length ?? 0) + JSON.stringify(t.inputSchema).length,
    0
  );
  return instructionChars + toolChars;
}

/**
 * Marks the end of the stable prefix so the provider caches everything up to it.
 *
 * Only the last instruction is marked: a breakpoint covers everything before it, so marking each
 * block would spend the provider's limited breakpoints for no extra coverage. The annotation is
 * namespaced by provider, so a chain that falls back across vendors carries an option the
 * answering provider ignores rather than one it misreads.
 */
export function withCacheBreakpoint(
  instructions: readonly SystemModelMessage[],
  decision: PromptCacheDecision
): SystemModelMessage[] {
  if (decision.kind === "skip") return [...instructions];
  const last = instructions.length - 1;
  return instructions.map((message, index) =>
    index === last ? { ...message, providerOptions: decision.providerOptions } : message
  );
}

/** Convert loop transcript to SDK prompt; tool results stay attributed to their tool calls. */
export function splitPrompt(transcript: readonly { role: string; content: string }[]): {
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

/** Recognizes loop-encoded Tool calls; other assistant text passes through. */
export function parseToolCalls(
  content: string
): readonly { callId: string; name: string; arguments: unknown }[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Model output that is not valid JSON yields no tool call.
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
export function parseToolResult(
  content: string
): { callId: string; payload: Record<string, unknown> } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Model output that is not valid JSON yields no tool call.
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

export function toToolSet(
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
