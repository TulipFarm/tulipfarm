import { isRecord } from "@tulipfarm/schema/guards";
import type { ChatMessage, SourceRef, TimelinePart, ToolPreview } from "~/lib/chat/types";
import type { ConversationMessage, WireMessagePart } from "~/lib/conversations";
import { randomUUID } from "~/lib/uuid";

/* Drop system/summary rows; restored messages are sealed and tool calls are best-effort. */

function newId(): string {
  return randomUUID();
}

// Map a persisted assistant `content` (string or parts) to renderable timeline parts.
// A reply that only ran Tools or only asked a question persists with empty text — the Message
// exists to carry `metadata.toolCalls` and its Surface link. Emitting a text part for it would
// restore a blank paragraph above the run that was never there live.
function assistantParts(content: string | WireMessagePart[]): TimelinePart[] {
  if (typeof content === "string") return content ? [{ kind: "text", text: content }] : [];
  const parts: TimelinePart[] = [];
  for (const part of content) {
    if (part.type === "text") {
      if (!part.text) continue;
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
  batchId?: string;
};

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
    ...(typeof value.batchId === "string" ? { batchId: value.batchId } : {}),
  };
}

function toolPartsFromMetadata(
  metadata: Record<string, unknown> | undefined,
  turnAttempt: ChatMessage["turnAttempt"]
): TimelinePart[] {
  const rawToolCalls = metadata?.toolCalls;
  if (!Array.isArray(rawToolCalls)) return [];
  return rawToolCalls.flatMap((raw): TimelinePart[] => {
    const tool = persistedToolCallFrom(raw);
    if (tool === undefined) return [];
    const meta = {
      ...(tool.argsDigest === undefined ? {} : { argsDigest: tool.argsDigest }),
      ...(tool.durationMs === undefined ? {} : { durationMs: tool.durationMs }),
      ...(tool.errorCode === undefined ? {} : { errorCode: tool.errorCode }),
      ...(tool.batchId === undefined ? {} : { batchId: tool.batchId }),
    };
    const interrupted =
      tool.outcome === undefined &&
      turnAttempt?.complete === true &&
      (turnAttempt.outcome === "failed" || turnAttempt.outcome === "cancelled");
    return [
      {
        kind: "tool",
        toolCallId: tool.callId,
        toolName: tool.name,
        args: tool.argsDigest === undefined ? {} : { argsDigest: tool.argsDigest },
        status: interrupted ? "interrupted" : "done",
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

function surfacePartsFromMetadata(metadata: Record<string, unknown> | undefined): TimelinePart[] {
  const rawSurfaces = metadata?.surfaces;
  if (!Array.isArray(rawSurfaces)) return [];
  return rawSurfaces.flatMap((raw): TimelinePart[] => {
    if (
      !isRecord(raw) ||
      typeof raw.artifactId !== "string" ||
      typeof raw.revision !== "number" ||
      !Number.isInteger(raw.revision) ||
      raw.revision < 1
    ) {
      return [];
    }
    return [{ kind: "surface", artifactId: raw.artifactId, revision: raw.revision }];
  });
}

function turnAttemptFrom(
  metadata: Record<string, unknown> | undefined
): ChatMessage["turnAttempt"] {
  const value = metadata?.turnAttempt;
  if (
    !isRecord(value) ||
    typeof value.runId !== "string" ||
    typeof value.attempt !== "number" ||
    typeof value.cursor !== "number" ||
    typeof value.complete !== "boolean" ||
    !(
      value.outcome === "active" ||
      value.outcome === "waiting" ||
      value.outcome === "succeeded" ||
      value.outcome === "failed" ||
      value.outcome === "cancelled"
    )
  ) {
    return undefined;
  }
  const wait = isRecord(value.wait) ? value.wait : undefined;
  const parsedWait =
    wait?.kind === "approval" &&
    typeof wait.waitId === "string" &&
    typeof wait.approvalId === "string" &&
    typeof wait.callId === "string"
      ? {
          kind: "approval" as const,
          waitId: wait.waitId,
          approvalId: wait.approvalId,
          callId: wait.callId,
        }
      : wait?.kind === "child" &&
          typeof wait.waitId === "string" &&
          typeof wait.childRunId === "string" &&
          typeof wait.callId === "string"
        ? {
            kind: "child" as const,
            waitId: wait.waitId,
            childRunId: wait.childRunId,
            callId: wait.callId,
          }
        : undefined;
  return {
    runId: value.runId,
    attempt: value.attempt,
    cursor: value.cursor,
    outcome: value.outcome,
    complete: value.complete,
    ...(parsedWait === undefined ? {} : { wait: parsedWait }),
  };
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
      if (
        !assistant.parts.some(
          (existing) =>
            existing.kind === "surface" &&
            existing.artifactId === part.artifactId &&
            existing.revision === part.revision
        )
      ) {
        assistant.parts.push({
          kind: "surface",
          artifactId: part.artifactId,
          revision: part.revision,
        });
      }
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
    } else if (part.type === "file-unavailable") {
      parts.push({ kind: "file-unavailable", fileId: part.fileId, name: part.name });
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
  for (const doc of docs) {
    if (doc.role === "user") {
      out.push({ id: newId(), role: "user", parts: userParts(doc.content), sealed: true });
      lastAssistant = undefined;
    } else if (doc.role === "assistant") {
      const turnAttempt = turnAttemptFrom(doc.metadata);
      const message: ChatMessage = {
        id: newId(),
        serverId: doc._id,
        role: "assistant",
        // Tools first, then text: a persisted reply stores its text as one string and its calls as
        // a flat `metadata.toolCalls` with no positions, so where the text sat between the calls is
        // not on the wire. A restored transcript therefore groups the whole run as one block even
        // when the live one split it around a preamble. Accepted — restoring the interleaving means
        // persisting ordered parts instead of a string, which the LLM history rebuild also reads.
        parts: [
          ...toolPartsFromMetadata(doc.metadata, turnAttempt),
          ...assistantParts(doc.content),
          ...surfacePartsFromMetadata(doc.metadata),
        ],
        sealed: turnAttempt?.complete ?? true,
        feedback: votes?.get(doc._id),
        ...(turnAttempt === undefined ? {} : { turnAttempt }),
      };
      if (turnAttempt !== undefined && !turnAttempt.complete) {
        for (const part of message.parts) {
          if (part.kind === "tool" && part.outcome === undefined) part.status = "running";
        }
      }
      const pendingApproval = turnAttempt?.wait?.kind === "approval" ? turnAttempt.wait : undefined;
      if (pendingApproval !== undefined) {
        const tool = message.parts.find(
          (part) => part.kind === "tool" && part.toolCallId === pendingApproval.callId
        );
        if (tool?.kind === "tool") {
          tool.status = "running";
          tool.approval = { approvalId: pendingApproval.approvalId, status: "pending" };
        }
      }
      out.push(message);
      lastAssistant = message;
    } else if (doc.role === "tool" && lastAssistant && Array.isArray(doc.content)) {
      mergeToolResults(lastAssistant, doc.content);
    }
    // system / summary / orphan tool rows are not part of the rendered timeline.
  }
  return out;
}
