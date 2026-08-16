import type { ajv } from "@tulipfarm/schema";
import type { ModelMessage } from "../ports";

/** How model output and Tool results are shaped into transcript messages the model reads back. */

export interface NormalizedToolCall {
  readonly callId: string;
  readonly name: string;
  readonly arguments: unknown;
}

type CompiledValidator = ReturnType<typeof ajv.compile>;

export function normalizeCalls(
  calls: readonly { readonly callId: string; readonly name: string; readonly arguments: unknown }[],
  iteration: number
): readonly NormalizedToolCall[] {
  // Providers sometimes omit or repeat call ids; correlation must stay unambiguous regardless.
  const seen = new Set<string>();
  return calls.map((call, index) => {
    const candidate = call.callId.trim();
    const callId =
      candidate === "" || seen.has(candidate) ? `call-${iteration}-${index + 1}` : candidate;
    seen.add(callId);
    return { callId, name: call.name, arguments: call.arguments };
  });
}

export function toolMessage(callId: string, payload: Record<string, unknown>): ModelMessage {
  return { role: "tool", content: JSON.stringify({ callId, ...payload }) };
}

export function assistantToolCallMessage(
  calls: readonly { readonly callId: string; readonly name: string; readonly arguments: unknown }[]
): ModelMessage {
  return {
    role: "assistant",
    content: JSON.stringify({
      toolCalls: calls.map((call) => ({
        callId: call.callId,
        name: call.name,
        arguments: call.arguments,
      })),
    }),
  };
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Non-JSON text parses to nothing; the caller falls back.
    return undefined;
  }
}

export function errorText(validate: CompiledValidator): string {
  return (validate.errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`)
    .join("; ");
}
