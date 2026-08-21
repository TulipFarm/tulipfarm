/*
 * Pure, immutable reducer that folds the wire `ChatEvent` stream into the renderable timeline.
 * Every event lands on the LAST assistant message (one is created when a stream starts / the
 * first non-user event arrives).
 */

import type {
  ApprovalState,
  ChatEvent,
  ChatMessage,
  ChatState,
  ChatTurnOptions,
  ChatTurnSource,
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

function cloneOptions(options: ChatTurnOptions | undefined): ChatTurnOptions | undefined {
  if (options === undefined) return undefined;
  return {
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.autonomy === undefined ? {} : { autonomy: options.autonomy }),
    ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
    ...(options.skills === undefined ? {} : { skills: [...options.skills] }),
    ...(options.resources === undefined ? {} : { resources: [...options.resources] }),
    ...(options.knowledgePages === undefined
      ? {}
      : { knowledgePages: [...options.knowledgePages] }),
    ...(options.files === undefined ? {} : { files: [...options.files] }),
  };
}

function sourceTurn(text: string, options?: ChatTurnOptions): ChatTurnSource {
  const cloned = cloneOptions(options);
  return cloned === undefined ? { text } : { text, options: cloned };
}

export function appendUserMessage(
  state: ChatState,
  text: string,
  options?: ChatTurnOptions
): ChatState {
  const message: ChatMessage = {
    id: newId(),
    role: "user",
    // Files first, so the optimistic bubble matches the one hydrate builds on reload.
    parts: [
      ...(options?.files ?? []).map((file) => ({ kind: "file" as const, ...file })),
      ...(text.length > 0 ? [{ kind: "text" as const, text }] : []),
    ],
    sealed: true,
    sourceTurn: sourceTurn(text, options),
  };
  return {
    ...state,
    messages: [...state.messages, message],
    status: "submitted",
    error: undefined,
    errorDetails: undefined,
  };
}

export function rewindLastTurn(state: ChatState): ChatState {
  const messages = state.messages.slice();
  while (messages.length > 0 && messages[messages.length - 1].role === "assistant") messages.pop();
  if (messages.length > 0 && messages[messages.length - 1].role === "user") messages.pop();
  return { ...state, messages, status: "idle", error: undefined, errorDetails: undefined };
}

function ensureAssistant(messages: ChatMessage[]): {
  messages: ChatMessage[];
  target: ChatMessage;
} {
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant" && !last.sealed) {
    return { messages, target: last };
  }
  const source = last?.role === "user" ? last.sourceTurn : undefined;
  const target: ChatMessage = {
    id: newId(),
    role: "assistant",
    parts: [],
    sealed: false,
    ...(source === undefined ? {} : { sourceTurn: source }),
  };
  return { messages: [...messages, target], target };
}

function withParts(
  messages: ChatMessage[],
  target: ChatMessage,
  parts: TimelinePart[]
): ChatMessage[] {
  const updated: ChatMessage = { ...target, parts };
  return messages.map((m) => (m.id === target.id ? updated : m));
}

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
        ...(event.data.preview === undefined ? {} : { argsPreview: event.data.preview }),
        ...(event.data.meta === undefined ? {} : { meta: event.data.meta }),
      };
      return {
        ...state,
        status: "streaming",
        messages: withParts(messages, target, [...target.parts, part]),
      };
    }

    case "tool-result": {
      const { messages, target } = ensureAssistant(state.messages);
      const resultMeta = event.data.meta;
      const parts = mapTool(target.parts, event.data.toolCallId, (p) => ({
        ...p,
        result: event.data.result,
        status: "done",
        ...(event.data.preview === undefined ? {} : { resultPreview: event.data.preview }),
        ...(resultMeta === undefined ? {} : { meta: { ...p.meta, ...resultMeta } }),
        ...(resultMeta?.errorCode === undefined ? {} : { outcome: "error" as const }),
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
        currentAgent: event.data.to,
        messages: withParts(messages, target, [...target.parts, part]),
      };
    }

    case "surface": {
      const { artifactId, artifact } = event.data;
      if (hasSurface(state.messages, artifactId)) {
        return {
          ...state,
          status: "streaming",
          messages: mapSurface(state.messages, artifactId, () => ({
            kind: "surface",
            artifactId,
            revision: artifact?.revision,
            artifact,
            actionHandles: event.data.actionHandles,
            resolvedView: event.data.resolvedView,
          })),
        };
      }
      const { messages, target } = ensureAssistant(state.messages);
      const part: TimelinePart = {
        kind: "surface",
        artifactId,
        revision: artifact?.revision,
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
      const sealed = withParts(messages, target, target.parts).map((m) =>
        m.id === target.id
          ? {
              ...m,
              sealed: true,
              serverId: event.data.messageId ?? m.serverId,
              receipt: event.data.receipt ?? m.receipt,
            }
          : m
      );
      return { ...state, status: "idle", messages: sealed };
    }

    case "error":
      return {
        ...state,
        status: "error",
        error: event.data.message,
        errorDetails: event.data.details,
      };

    case "client-action":
      return state;
  }
}
