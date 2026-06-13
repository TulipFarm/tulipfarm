import type { ChatMessage, TimelinePart } from "~/lib/chat/types";
import type { ConversationMessage, WireMessagePart } from "~/lib/conversations";

/*
 * Rehydrate a restored conversation's persisted messages into the renderable timeline the chat
 * reducer would have produced live. Text is the fidelity bar (every user/assistant turn round-trips);
 * tool calls are reconstructed best-effort — an assistant `tool-call` part pairs with the result in
 * the following `tool` turn (matched by `toolCallId`). System/summary rows are internal to the prompt
 * and never rendered, so they are dropped. Every message is `sealed` (no further deltas).
 */

function newId(): string {
  return crypto.randomUUID();
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

// Fold a `tool` turn's results into the matching tool parts of the assistant turn it answers.
function mergeToolResults(assistant: ChatMessage, content: WireMessagePart[]): void {
  for (const part of content) {
    if (part.type !== "tool-result") continue;
    for (const p of assistant.parts) {
      if (p.kind === "tool" && p.toolCallId === part.toolCallId) {
        p.result = part.result;
        p.status = "done";
      }
    }
  }
}

export function messagesToTimeline(docs: ConversationMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let lastAssistant: ChatMessage | undefined;
  for (const doc of docs) {
    if (doc.role === "user") {
      const text = typeof doc.content === "string" ? doc.content : "";
      out.push({ id: newId(), role: "user", parts: [{ kind: "text", text }], sealed: true });
      lastAssistant = undefined;
    } else if (doc.role === "assistant") {
      const message: ChatMessage = {
        id: newId(),
        role: "assistant",
        parts: assistantParts(doc.content),
        sealed: true,
      };
      out.push(message);
      lastAssistant = message;
    } else if (doc.role === "tool" && lastAssistant && Array.isArray(doc.content)) {
      mergeToolResults(lastAssistant, doc.content);
    }
    // system / summary / orphan tool rows are not part of the rendered timeline.
  }
  return out;
}
