/*
 * Pure, immutable reducer that folds the wire `ChatEvent` stream into the renderable timeline.
 * Every event lands on the LAST assistant message (one is created when a stream starts / the first
 * non-user event arrives). Tool calls and results are paired strictly by `toolCallId`, and parts
 * preserve first-seen order. Nothing here touches the network — `use-chat-stream` wires it to the
 * SSE client. Approvals are tracked both on the tool part (`approval.status`) and in a flat
 * `pendingApprovals` index so a resolution can locate its part in O(1).
 */

import type {
  ApprovalState,
  ChatEvent,
  ChatMessage,
  ChatState,
  TimelinePart,
} from "~/lib/chat/types";
import { randomUUID } from "~/lib/uuid";

export const initialChatState: ChatState = {
  messages: [],
  pendingApprovals: {},
  status: "idle",
};

function newId(): string {
  return randomUUID();
}

// Push a user message and mark the turn submitted. Used by the hook before opening the stream.
export function appendUserMessage(state: ChatState, text: string): ChatState {
  const message: ChatMessage = {
    id: newId(),
    role: "user",
    parts: [{ kind: "text", text }],
    sealed: true,
  };
  return { ...state, messages: [...state.messages, message], status: "submitted" };
}

// Stop / un-send: drop the trailing assistant turn(s) AND the last user message, returning the
// timeline to a clean pre-send state. The composer restores the original prompt into its editor; this
// only rewinds the transcript. Local-only — the server keeps its full history, the same V1 trade-off
// as `regenerate`.
export function rewindLastTurn(state: ChatState): ChatState {
  const messages = state.messages.slice();
  while (messages.length > 0 && messages[messages.length - 1].role === "assistant") messages.pop();
  if (messages.length > 0 && messages[messages.length - 1].role === "user") messages.pop();
  return { ...state, messages, status: "idle", error: undefined, pendingServerId: undefined };
}

// The assistant message events fold into: the last one if it is still open, else a fresh one.
function ensureAssistant(messages: ChatMessage[]): {
  messages: ChatMessage[];
  target: ChatMessage;
} {
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant" && !last.sealed) {
    return { messages, target: last };
  }
  const target: ChatMessage = { id: newId(), role: "assistant", parts: [], sealed: false };
  return { messages: [...messages, target], target };
}

// Replace `target` in the message list with a new message carrying `parts` (immutable update).
function withParts(
  messages: ChatMessage[],
  target: ChatMessage,
  parts: TimelinePart[]
): ChatMessage[] {
  const updated: ChatMessage = { ...target, parts };
  return messages.map((m) => (m.id === target.id ? updated : m));
}

// Append text to a trailing part of `kind`, or start a new one if the last part is something else.
function appendText(
  parts: TimelinePart[],
  kind: "text" | "reasoning",
  delta: string
): TimelinePart[] {
  const last = parts[parts.length - 1];
  if (last && last.kind === kind) {
    const merged: TimelinePart = { kind, text: last.text + delta };
    return [...parts.slice(0, -1), merged];
  }
  return [...parts, { kind, text: delta }];
}

function hasSurface(messages: ChatMessage[], artifactId: string): boolean {
  return messages.some((message) =>
    message.parts.some((part) => part.kind === "surface" && part.artifactId === artifactId)
  );
}

function mapSurface(
  messages: ChatMessage[],
  artifactId: string,
  fn: (part: Extract<TimelinePart, { kind: "surface" }>) => TimelinePart
): ChatMessage[] {
  return messages.map((message) =>
    message.parts.some((part) => part.kind === "surface" && part.artifactId === artifactId)
      ? {
          ...message,
          parts: message.parts.map((part) =>
            part.kind === "surface" && part.artifactId === artifactId ? fn(part) : part
          ),
        }
      : message
  );
}

// Map over tool parts, applying `fn` to the one matching `toolCallId` (others pass through).
function mapTool(
  parts: TimelinePart[],
  toolCallId: string,
  fn: (part: Extract<TimelinePart, { kind: "tool" }>) => TimelinePart
): TimelinePart[] {
  return parts.map((p) => (p.kind === "tool" && p.toolCallId === toolCallId ? fn(p) : p));
}

export function chatReducer(state: ChatState, event: ChatEvent): ChatState {
  switch (event.type) {
    case "text":
    case "reasoning": {
      const { messages, target } = ensureAssistant(state.messages);
      const parts = appendText(target.parts, event.type, event.data.delta);
      return { ...state, status: "streaming", messages: withParts(messages, target, parts) };
    }

    case "tool-call": {
      const { messages, target } = ensureAssistant(state.messages);
      const part: TimelinePart = {
        kind: "tool",
        toolCallId: event.data.toolCallId,
        toolName: event.data.toolName,
        args: event.data.args,
        status: "running",
      };
      return {
        ...state,
        status: "streaming",
        messages: withParts(messages, target, [...target.parts, part]),
      };
    }

    case "tool-result": {
      const { messages, target } = ensureAssistant(state.messages);
      const parts = mapTool(target.parts, event.data.toolCallId, (p) => ({
        ...p,
        result: event.data.result,
        status: "done",
      }));
      return { ...state, status: "streaming", messages: withParts(messages, target, parts) };
    }

    case "approval-request": {
      const { messages, target } = ensureAssistant(state.messages);
      const approval: ApprovalState = {
        approvalId: event.data.approvalId,
        status: "pending",
        expiresAt: event.data.expiresAt,
      };
      const parts = mapTool(target.parts, event.data.toolCallId, (p) => ({ ...p, approval }));
      return {
        ...state,
        status: "streaming",
        messages: withParts(messages, target, parts),
        pendingApprovals: {
          ...state.pendingApprovals,
          [event.data.approvalId]: { toolCallId: event.data.toolCallId, messageId: target.id },
        },
      };
    }

    case "approval-resolved": {
      const pending = state.pendingApprovals[event.data.approvalId];
      const toolCallId = pending?.toolCallId ?? event.data.toolCallId;
      const setOutcome = (p: Extract<TimelinePart, { kind: "tool" }>): TimelinePart =>
        p.approval
          ? { ...p, approval: { ...p.approval, status: event.data.outcome } }
          : { ...p, approval: { approvalId: event.data.approvalId, status: event.data.outcome } };
      const { [event.data.approvalId]: _removed, ...pendingApprovals } = state.pendingApprovals;
      // Update the exact message holding the tool-call — located via the pendingApprovals index in
      // case a later `finish` already sealed it — rather than assuming it is the open assistant.
      const byId = pending && state.messages.find((m) => m.id === pending.messageId);
      const { messages, target } = byId
        ? { messages: state.messages, target: byId }
        : ensureAssistant(state.messages);
      return {
        ...state,
        status: "streaming",
        messages: withParts(messages, target, mapTool(target.parts, toolCallId, setOutcome)),
        pendingApprovals,
      };
    }

    case "plan": {
      const { messages, target } = ensureAssistant(state.messages);
      const existing = target.parts.some(
        (p) => p.kind === "plan" && p.planId === event.data.planId
      );
      const next: TimelinePart = {
        kind: "plan",
        planId: event.data.planId,
        title: event.data.title,
        steps: event.data.steps,
      };
      const parts = existing
        ? target.parts.map((p) => (p.kind === "plan" && p.planId === event.data.planId ? next : p))
        : [...target.parts, next];
      return { ...state, status: "streaming", messages: withParts(messages, target, parts) };
    }

    case "task": {
      const { messages, target } = ensureAssistant(state.messages);
      const existing = target.parts.some(
        (p) => p.kind === "task" && p.taskId === event.data.taskId
      );
      const next: TimelinePart = {
        kind: "task",
        taskId: event.data.taskId,
        label: event.data.label,
        status: event.data.status,
      };
      const parts = existing
        ? target.parts.map((p) => (p.kind === "task" && p.taskId === event.data.taskId ? next : p))
        : [...target.parts, next];
      return { ...state, status: "streaming", messages: withParts(messages, target, parts) };
    }

    case "sources": {
      const { messages, target } = ensureAssistant(state.messages);
      const part: TimelinePart = { kind: "sources", sources: event.data.sources };
      return {
        ...state,
        status: "streaming",
        messages: withParts(messages, target, [...target.parts, part]),
      };
    }

    case "agent-handoff": {
      const { messages, target } = ensureAssistant(state.messages);
      const part: TimelinePart = {
        kind: "agent-handoff",
        to: event.data.to,
        from: event.data.from,
        reason: event.data.reason,
      };
      return {
        ...state,
        status: "streaming",
        // Track the new agent so the header indicator follows the handoff, not just the transcript.
        currentAgent: event.data.to,
        messages: withParts(messages, target, [...target.parts, part]),
      };
    }

    case "surface": {
      const artifact = event.data.artifact;
      if (hasSurface(state.messages, artifact.id)) {
        return {
          ...state,
          status: "streaming",
          messages: mapSurface(state.messages, artifact.id, () => ({
            kind: "surface",
            artifactId: artifact.id,
            revision: artifact.revision,
            artifact,
            actionHandles: event.data.actionHandles,
            resolvedView: event.data.resolvedView,
          })),
        };
      }
      const { messages, target } = ensureAssistant(state.messages);
      const part: TimelinePart = {
        kind: "surface",
        artifactId: artifact.id,
        revision: artifact.revision,
        artifact,
        actionHandles: event.data.actionHandles,
        resolvedView: event.data.resolvedView,
      };
      return {
        ...state,
        status: "streaming",
        messages: withParts(messages, target, [...target.parts, part]),
      };
    }

    case "guardrail_block": {
      const { messages, target } = ensureAssistant(state.messages);
      const part: TimelinePart = {
        kind: "guardrail",
        stage: event.data.stage,
        guard: event.data.guard,
        reason: event.data.reason,
        message: event.data.message,
      };
      return {
        ...state,
        status: "streaming",
        messages: withParts(messages, target, [...target.parts, part]),
      };
    }

    case "finish": {
      const { messages, target } = ensureAssistant(state.messages);
      // Stamp the server's reply id (from the X-Message-Id meta) onto the sealed message so feedback
      // can target it. `id` (the React key) stays the client uuid — swapping it would remount.
      const sealed = withParts(messages, target, target.parts).map((m) =>
        m.id === target.id
          ? { ...m, sealed: true, serverId: state.pendingServerId ?? m.serverId }
          : m
      );
      // Consume pendingServerId so it can never leak onto a later turn's reply.
      return { ...state, status: "idle", messages: sealed, pendingServerId: undefined };
    }

    case "error":
      return { ...state, status: "error", error: event.data.message, pendingServerId: undefined };

    // Imperative agent→client action — executed by the chat hook (navigate, …), no timeline change.
    case "client-action":
      return state;
  }
}
