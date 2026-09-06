import type {
  ModelInvocationRequest,
  ModelOutput,
  ResolvedAttachment,
} from "@tulipfarm/agent-runtime";
import type { PromptCacheDecision } from "@tulipfarm/llm";
import {
  contentFiles,
  contentText,
  type MessageContent,
  modalityForMediaType,
} from "@tulipfarm/schema";
import {
  type FilePart,
  type ImagePart,
  jsonSchema,
  type ModelMessage as SdkMessage,
  type SystemModelMessage,
  type streamText,
  type TextPart,
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

/**
 * Convert loop transcript to SDK prompt; tool results stay attributed to their tool calls.
 *
 * A user message whose parts name a File the caller resolved becomes a multipart message carrying
 * that File's bytes. A file part with no resolved bytes contributes nothing — that is how a File
 * reaches only the Turn it was attached to, rather than every Turn after it.
 */
export function splitPrompt(
  transcript: readonly { role: string; content: MessageContent }[],
  attachments: readonly ResolvedAttachment[] = []
): {
  instructions: SystemModelMessage[];
  messages: SdkMessage[];
  /**
   * The Files whose bytes this prompt actually carries.
   *
   * Reported from the same traversal that emits them, so a caller checking what the model was
   * given cannot drift from what it was given — a second implementation of "which Files count"
   * would be free to disagree, and the interesting cases are exactly the ones where it would.
   */
  attached: string[];
} {
  const instructions: SystemModelMessage[] = [];
  const messages: SdkMessage[] = [];
  const attached: string[] = [];
  const toolNamesByCallId = new Map<string, string>();
  const resolved = new Map(attachments.map((file) => [file.fileId, file]));
  let pendingResults: ToolResultPart[] = [];

  const flushResults = () => {
    if (pendingResults.length > 0) {
      messages.push({ role: "tool", content: pendingResults });
      pendingResults = [];
    }
  };

  for (const message of transcript) {
    const content = contentText(message.content);
    if (message.role === "system") {
      flushResults();
      instructions.push({ role: "system", content });
      continue;
    }

    if (message.role === "assistant") {
      const calls = parseToolCalls(content);
      if (calls === undefined) {
        flushResults();
        messages.push({ role: "assistant", content });
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
      const result = parseToolResult(content);
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
    const parts = userParts(message.content, content, resolved, attached);
    messages.push(
      parts === undefined ? { role: "user", content } : { role: "user", content: parts }
    );
  }
  flushResults();
  return { instructions, messages, attached };
}

/**
 * The multipart body of a user message, or `undefined` when plain text says the same thing.
 *
 * Falling back to a string rather than a one-element part array keeps every text-only prompt byte
 * identical to what it was before Files existed, so nothing about prompt caching or provider
 * behaviour shifts for the messages that carry no File.
 */
function userParts(
  content: MessageContent,
  text: string,
  resolved: ReadonlyMap<string, ResolvedAttachment>,
  attached: string[]
): (TextPart | ImagePart | FilePart)[] | undefined {
  const files = contentFiles(content).flatMap((part) => {
    const file = resolved.get(part.fileId);
    return file === undefined ? [] : [file];
  });
  if (files.length === 0) return undefined;

  const parts: (TextPart | ImagePart | FilePart)[] = [];
  if (text.length > 0) parts.push({ type: "text", text });
  for (const file of files) {
    attached.push(file.fileId);
    parts.push(filePartFor(file));
  }
  return parts;
}

/**
 * The provider block one attached File becomes.
 *
 * Routed by what a provider can actually read, not by the File's modality. Images and PDFs are
 * accepted as binary; every other media type is refused as a file part, so a document that has
 * text is sent as text and only a document with none is left to try its luck as a file.
 */
function filePartFor(file: ResolvedAttachment): TextPart | ImagePart | FilePart {
  if (modalityForMediaType(file.mediaType) === "image") {
    return { type: "image", image: file.data, mediaType: file.mediaType };
  }
  if (file.mediaType !== "application/pdf" && file.text !== undefined && file.text.length > 0) {
    return { type: "text", text: `${file.name}:\n\n${file.text}` };
  }
  return { type: "file", data: file.data, mediaType: file.mediaType, filename: file.name };
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
