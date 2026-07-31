import type { ChatMessage, SourceRef, TimelinePart } from "~/lib/chat/types";
import type { ConversationMessage, WireMessagePart } from "~/lib/conversations";
import { randomUUID } from "~/lib/uuid";

/*
 * Rehydrate a restored conversation's persisted messages into the renderable timeline the chat
 * reducer would have produced live. Text is the fidelity bar (every user/assistant turn round-trips);
 * tool calls are reconstructed best-effort — an assistant `tool-call` part pairs with the result in
 * the following `tool` turn (matched by `toolCallId`). System/summary rows are internal to the prompt
 * and never rendered, so they are dropped. Every message is `sealed` (no further deltas).
 */

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
export function messagesToTimeline(
  docs: ConversationMessage[],
  votes?: Map<string, "up" | "down">
): ChatMessage[] {
  const out: ChatMessage[] = [];
  let lastAssistant: ChatMessage | undefined;
  let surfaceOnly = false;
  for (const doc of docs) {
    if (doc.role === "user") {
      const text = typeof doc.content === "string" ? doc.content : "";
      out.push({ id: newId(), role: "user", parts: [{ kind: "text", text }], sealed: true });
      lastAssistant = undefined;
      surfaceOnly = false;
    } else if (doc.role === "assistant") {
      if (surfaceOnly) continue;
      const message: ChatMessage = {
        id: newId(),
        serverId: doc._id,
        role: "assistant",
        parts: assistantParts(doc.content),
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
