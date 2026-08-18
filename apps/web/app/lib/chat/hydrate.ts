import type { ChatMessage, SourceRef, TimelinePart, ToolPreview } from "~/lib/chat/types";
import type { ConversationMessage, WireMessagePart } from "~/lib/conversations";
import { randomUUID } from "~/lib/uuid";

/* Drop system/summary rows; restored messages are sealed and tool calls are best-effort. */

function newId(): string {
  return randomUUID();
}

// Map a persisted assistant `content` (string or parts) to renderable timeline parts.
function assistantParts(content: string | WireMessagePart[]): TimelinePart[] {
  if (typeof content === "string") return [{ kind: "text", text: content }];
  const parts: TimelinePart[] = [];
  for (const part of content) {
    if (part.type === "text") {
      parts.push({ kind: "text", text: part.text });
    } else if (part.type === "tool-call") {
      parts.push({
        kind: "tool",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        args: part.args,
        status: "done",
      });
    }
  }
  return parts;
}

type PersistedToolCall = {
  callId: string;
  name: string;
  argsDigest?: string;
  argsPreview?: ToolPreview;
  resultPreview?: ToolPreview;
  durationMs?: number;
  outcome?: "ok" | "error";
  errorCode?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function previewFrom(value: unknown): ToolPreview | undefined {
  if (!isRecord(value) || typeof value.json !== "string") return undefined;
  return {
    json: value.json,
    ...(Array.isArray(value.redactedPaths)
      ? { redactedPaths: value.redactedPaths.filter((path) => typeof path === "string") }
      : {}),
    ...(typeof value.truncated === "boolean" ? { truncated: value.truncated } : {}),
    ...(typeof value.bytes === "number" ? { bytes: value.bytes } : {}),
  };
}

function persistedToolCallFrom(value: unknown): PersistedToolCall | undefined {
  if (!isRecord(value) || typeof value.callId !== "string" || typeof value.name !== "string") {
    return undefined;
  }
  const argsPreview = previewFrom(value.argsPreview);
  const resultPreview = previewFrom(value.resultPreview);
  return {
    callId: value.callId,
    name: value.name,
    ...(typeof value.argsDigest === "string" ? { argsDigest: value.argsDigest } : {}),
    ...(argsPreview === undefined ? {} : { argsPreview }),
    ...(resultPreview === undefined ? {} : { resultPreview }),
    ...(typeof value.durationMs === "number" ? { durationMs: value.durationMs } : {}),
    ...(value.outcome === "ok" || value.outcome === "error" ? { outcome: value.outcome } : {}),
    ...(typeof value.errorCode === "string" ? { errorCode: value.errorCode } : {}),
  };
}

function toolPartsFromMetadata(metadata: Record<string, unknown> | undefined): TimelinePart[] {
  const rawToolCalls = metadata?.toolCalls;
  if (!Array.isArray(rawToolCalls)) return [];
  return rawToolCalls.flatMap((raw): TimelinePart[] => {
    const tool = persistedToolCallFrom(raw);
    if (tool === undefined) return [];
    const meta = {
      ...(tool.argsDigest === undefined ? {} : { argsDigest: tool.argsDigest }),
      ...(tool.durationMs === undefined ? {} : { durationMs: tool.durationMs }),
      ...(tool.errorCode === undefined ? {} : { errorCode: tool.errorCode }),
    };
    return [
      {
        kind: "tool",
        toolCallId: tool.callId,
        toolName: tool.name,
        args: tool.argsDigest === undefined ? {} : { argsDigest: tool.argsDigest },
        status: "done",
        ...(tool.argsPreview === undefined ? {} : { argsPreview: tool.argsPreview }),
        ...(tool.resultPreview === undefined ? {} : { resultPreview: tool.resultPreview }),
        ...(Object.keys(meta).length === 0 ? {} : { meta }),
        ...(tool.outcome === undefined ? {} : { outcome: tool.outcome }),
        ...(tool.outcome === undefined
          ? {}
          : {
              result: {
                status: tool.outcome,
                ...(tool.errorCode === undefined ? {} : { errorCode: tool.errorCode }),
              },
            }),
      },
    ];
  });
}

// Pull the SourceRef[] out of a persisted cite_sources tool-result (`{ data: { sources } }`), so a
// restored transcript can rebuild its citation chips. Defensive — unknown/legacy shapes yield [].
function sourcesFromResult(result: unknown): SourceRef[] {
  const sources = (result as { data?: { sources?: unknown } })?.data?.sources;
  return Array.isArray(sources) ? (sources as SourceRef[]) : [];
}

// Fold a `tool` turn's results into the matching tool parts of the assistant turn it answers. A
// cite_sources result also reconstructs the `sources` part the live reducer would have appended, so
// citations (and inline [n] links) survive a page refresh.
function mergeToolResults(assistant: ChatMessage, content: WireMessagePart[]): void {
  for (const part of content) {
    if (part.type === "surface") {
      assistant.parts = [
        ...assistant.parts.filter((existing) => existing.kind !== "text"),
        {
          kind: "surface",
          artifactId: part.artifactId,
          revision: part.revision,
        },
      ];
      continue;
    }
    if (part.type === "surface-unavailable") {
      assistant.parts = [
        ...assistant.parts.filter((existing) => existing.kind !== "text"),
        { kind: "surface-unavailable", message: part.message },
      ];
      continue;
    }
    if (part.type !== "tool-result") continue;
    for (const p of assistant.parts) {
      if (p.kind === "tool" && p.toolCallId === part.toolCallId) {
        p.result = part.result;
        p.status = "done";
        if (p.toolName === "cite_sources") {
          const sources = sourcesFromResult(part.result);
          if (sources.length > 0) assistant.parts.push({ kind: "sources", sources });
        }
      }
    }
  }
}

// `votes` (the caller's persisted thumbs, keyed by message id) seeds each assistant reply's
// `feedback` so a restored transcript shows prior votes. The assistant's persisted id is kept as
// `serverId` (the React-key `id` stays a fresh uuid) so feedback can target the persisted row; user
// turns carry no `serverId` since only assistant replies are rateable.
/**
 * A user Message is a string only when it is text alone; anything with an attachment arrives as
 * parts. Dropping the non-string form — which this did before Files existed — silently rendered
 * every message carrying an image as blank.
 */
function userParts(content: ConversationMessage["content"]): TimelinePart[] {
  if (typeof content === "string") return [{ kind: "text", text: content }];
  const parts: TimelinePart[] = [];
  for (const part of content) {
    if (part.type === "text") {
      if (part.text.length > 0) parts.push({ kind: "text", text: part.text });
    } else if (part.type === "file") {
      parts.push({
        kind: "file",
        fileId: part.fileId,
        mediaType: part.mediaType,
        name: part.name,
      });
    }
  }
  return parts.length > 0 ? parts : [{ kind: "text", text: "" }];
}

export function messagesToTimeline(
  docs: ConversationMessage[],
  votes?: Map<string, "up" | "down">
): ChatMessage[] {
  const out: ChatMessage[] = [];
  let lastAssistant: ChatMessage | undefined;
  let surfaceOnly = false;
  for (const doc of docs) {
    if (doc.role === "user") {
      out.push({ id: newId(), role: "user", parts: userParts(doc.content), sealed: true });
      lastAssistant = undefined;
      surfaceOnly = false;
    } else if (doc.role === "assistant") {
      if (surfaceOnly) continue;
      const message: ChatMessage = {
        id: newId(),
        serverId: doc._id,
        role: "assistant",
        parts: [...toolPartsFromMetadata(doc.metadata), ...assistantParts(doc.content)],
        sealed: true,
        feedback: votes?.get(doc._id),
      };
      out.push(message);
      lastAssistant = message;
    } else if (doc.role === "tool" && lastAssistant && Array.isArray(doc.content)) {
      mergeToolResults(lastAssistant, doc.content);
      surfaceOnly = doc.content.some(
        (part) => part.type === "surface" || part.type === "surface-unavailable"
      );
    }
    // system / summary / orphan tool rows are not part of the rendered timeline.
  }
  return out;
}
