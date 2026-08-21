/*
 * React hook that owns the chat timeline: a `useReducer` wired to the SSE client. `send` pushes
 * the user message, opens the stream, and dispatches each typed event; `approve` posts an
 * approval verdict.
 */

import { type NavigateFunction, useNavigate } from "@remix-run/react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { invokeClientAction, prefillForm } from "~/lib/chat/action-registry";
import {
  appendUserMessage,
  chatReducer,
  initialChatState,
  rewindLastTurn,
} from "~/lib/chat/reducer";
import type { ChatStreamMeta } from "~/lib/chat/sse-client";
import {
  postChat,
  postSurfaceInteraction,
  resumeRun,
  sendApprovalDecision,
  stopChatRun,
} from "~/lib/chat/sse-client";
import type {
  ChatEvent,
  ChatMessage,
  ChatModelSelector,
  ChatState,
  ChatStatus,
  ChatTurnOptions,
  ChatTurnSource,
} from "~/lib/chat/types";
import { type ConversationTurn, getConversation } from "~/lib/conversations";
import { clearFeedback, sendFeedback as postFeedback } from "~/lib/feedback";
import { randomUUID } from "~/lib/uuid";

export type SendOptions = ChatTurnOptions;

export type UseChatStreamOptions = {
  initialConversationId?: string;
  initialMessages?: ChatMessage[];
  initialTurn?: ConversationTurn | null;
  onConversationChange?: (conversationId: string | undefined) => void;
};

function needsRunReplay(opts?: UseChatStreamOptions): boolean {
  const turn = opts?.initialTurn;
  if (!turn) return false;
  return opts?.initialMessages?.at(-1)?.role !== "assistant";
}

export function seedState(opts?: UseChatStreamOptions): ChatState {
  const messages = opts?.initialMessages ?? [];
  const base: ChatState = {
    messages,
    pendingApprovals: {},
    status: "idle",
    ...(opts?.initialConversationId === undefined
      ? {}
      : { conversationId: opts.initialConversationId }),
  };
  if (!needsRunReplay(opts)) return base;
  const turn = opts?.initialTurn;
  if (!turn) return base;
  if (turn.status === "start_failed" || (turn.status === "failed" && turn.runId === null)) {
    return {
      ...base,
      status: "error",
      error: "The response could not be started. Try again.",
    };
  }
  return {
    ...base,
    status: "submitted",
    ...(turn.runId === null ? {} : { runId: turn.runId }),
  };
}

type ChatAction =
  | ChatEvent
  | { type: "user"; text: string; options?: SendOptions }
  | { type: "meta"; meta: ChatStreamMeta }
  | { type: "regenerate" }
  | { type: "surface-submit" }
  | { type: "stopped" }
  | { type: "reset" };

function captureClientContext(): { route: string; title?: string } | undefined {
  if (typeof window === "undefined") return undefined;
  const route = window.location.pathname + window.location.search;
  const title = typeof document !== "undefined" ? document.title : undefined;
  return title ? { route, title } : { route };
}

/** Execute an imperative agent→client action: navigate (internal paths only), prefill, or invoke. */
function handleClientAction(data: unknown, navigate: NavigateFunction): void {
  const a = data as {
    action?: string;
    to?: string;
    values?: Record<string, unknown>;
    name?: string;
    payload?: unknown;
  };
  if (a.action === "navigate") {
    if (typeof a.to === "string" && a.to.startsWith("/") && !a.to.startsWith("//")) navigate(a.to);
  } else if (a.action === "prefill" && a.values && typeof a.values === "object") {
    prefillForm(a.values);
  } else if (a.action === "invoke" && typeof a.name === "string") {
    invokeClientAction(a.name, a.payload);
  }
}

export function isChatBusy(status: ChatStatus): boolean {
  return status === "submitted" || status === "streaming";
}

export function surfaceInteractionAnswer(input: Readonly<Record<string, unknown>>): string {
  if (typeof input.value === "string" && input.value.trim().length > 0) return input.value;
  const entries = Object.entries(input);
  if (entries.length === 0) return "Submitted";
  return entries
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("\n");
}

function reducer(state: ChatState, action: ChatAction): ChatState {
  if (action.type === "user") return appendUserMessage(state, action.text, action.options);
  if (action.type === "surface-submit") return { ...state, status: "submitted", error: undefined };
  if (action.type === "reset") return initialChatState;
  if (action.type === "stopped") return rewindLastTurn(state);
  if (action.type === "regenerate") {
    const messages = state.messages.slice();
    while (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
      messages.pop();
    }
    return { ...state, messages, status: "submitted", error: undefined };
  }
  if (action.type === "meta") {
    return {
      ...state,
      conversationId: action.meta.conversationId ?? state.conversationId,
      runId: action.meta.runId ?? state.runId,
      currentAgent: action.meta.agentId ?? state.currentAgent,
    };
  }
  return chatReducer(state, action);
}

function lastUserSource(messages: ChatMessage[]): ChatTurnSource | undefined {
  return [...messages].reverse().find((message) => message.role === "user")?.sourceTurn;
}

function sourceForMessage(messages: ChatMessage[], messageId: string): ChatTurnSource | undefined {
  return messages.find((message) => message.id === messageId)?.sourceTurn;
}

export function useChatStream(opts?: UseChatStreamOptions) {
  const [state, dispatch] = useReducer(reducer, opts, seedState);
  const [connectionState, setConnectionState] = useState<"online" | "reconnecting">("online");
  const conversationIdRef = useRef<string | undefined>(opts?.initialConversationId);
  const stateRef = useRef(state);
  stateRef.current = state;
  const lastOptsRef = useRef<SendOptions | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const stopRequestedRef = useRef(false);
  const onConversationChangeRef = useRef(opts?.onConversationChange);
  onConversationChangeRef.current = opts?.onConversationChange;
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    []
  );

  const initialConversationId = opts?.initialConversationId;
  const initialTurn = opts?.initialTurn;
  const replayInitialTurn = needsRunReplay(opts);

  useEffect(() => {
    if (!replayInitialTurn || !initialConversationId || !initialTurn) return;
    if (
      initialTurn.status === "start_failed" ||
      (initialTurn.status === "failed" && initialTurn.runId === null)
    ) {
      return;
    }

    const controller = new AbortController();
    const conversationId = initialConversationId;
    const restoredTurn = initialTurn;
    abortRef.current = controller;
    stopRequestedRef.current = false;

    async function restore(): Promise<void> {
      let turn: ConversationTurn = restoredTurn;
      while (turn.runId === null && turn.status === "pending") {
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (controller.signal.aborted) return;
        const conversation = await getConversation(conversationId);
        if (!conversation.latestTurn) {
          throw new Error("The response state could not be restored. Try again.");
        }
        turn = conversation.latestTurn;
      }

      if (turn.status === "start_failed" || turn.runId === null) {
        throw new Error("The response could not be started. Try again.");
      }

      dispatch({ type: "meta", meta: { runId: turn.runId } });
      await resumeRun(turn.runId, {
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "client-action") {
            handleClientAction(event.data, navigateRef.current);
            return;
          }
          dispatch(event);
          if (event.type === "finish") {
            onConversationChangeRef.current?.(conversationIdRef.current);
          }
        },
        onConnectionState: setConnectionState,
      });
    }

    void restore()
      .catch((error) => {
        if (controller.signal.aborted) {
          if (stopRequestedRef.current) dispatch({ type: "stopped" });
          return;
        }
        dispatch({
          type: "error",
          data: { message: error instanceof Error ? error.message : "stream failed" },
        });
      })
      .finally(() => {
        if (abortRef.current === controller) abortRef.current = null;
        stopRequestedRef.current = false;
      });

    return () => {
      controller.abort();
    };
  }, [initialConversationId, initialTurn, replayInitialTurn]);

  const runStream = useCallback(async (text: string, opts?: SendOptions) => {
    const controller = new AbortController();
    abortRef.current = controller;
    stopRequestedRef.current = false;
    const idempotencyKey = randomUUID();
    try {
      await postChat(
        {
          message: {
            role: "user",
            content: text,
            ...(opts?.files?.length ? { fileIds: opts.files.map((file) => file.fileId) } : {}),
          },
          conversationId: conversationIdRef.current,
          model: opts?.model,
          autonomy: opts?.autonomy,
          agentId: opts?.agentId,
          skills: opts?.skills,
          resources: opts?.resources,
          knowledgePages: opts?.knowledgePages,
          clientContext: captureClientContext(),
        },
        {
          signal: controller.signal,
          onMeta: (meta) => {
            if (meta.conversationId) {
              conversationIdRef.current = meta.conversationId;
              onConversationChangeRef.current?.(meta.conversationId);
            }
            dispatch({ type: "meta", meta });
          },
          onEvent: (event) => {
            if (event.type === "client-action") {
              handleClientAction(event.data, navigateRef.current);
              return;
            }
            dispatch(event);
            if (event.type === "finish")
              onConversationChangeRef.current?.(conversationIdRef.current);
          },
          onConnectionState: setConnectionState,
        },
        idempotencyKey
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        dispatch({ type: "stopped" });
      } else {
        dispatch({
          type: "error",
          data: { message: err instanceof Error ? err.message : "stream failed" },
        });
      }
    } finally {
      abortRef.current = null;
      stopRequestedRef.current = false;
    }
  }, []);

  const send = useCallback(
    async (text: string, opts?: SendOptions) => {
      dispatch({ type: "user", text, options: opts });
      lastOptsRef.current = opts;
      await runStream(text, opts);
    },
    [runStream]
  );

  const regenerate = useCallback(async () => {
    const source = lastUserSource(stateRef.current.messages);
    const text = source?.text ?? "";
    if (text.length === 0) return;
    const options = source?.options ?? lastOptsRef.current;
    dispatch({ type: "regenerate" });
    lastOptsRef.current = options;
    await runStream(text, options);
  }, [runStream]);

  const tryHarder = useCallback(
    async (assistantMessageId: string, model: ChatModelSelector) => {
      if (isChatBusy(stateRef.current.status)) return;
      const source = sourceForMessage(stateRef.current.messages, assistantMessageId);
      if (!source || source.text.length === 0) return;
      const options: SendOptions = { ...(source.options ?? {}), model };
      dispatch({ type: "user", text: source.text, options });
      lastOptsRef.current = options;
      await runStream(source.text, options);
    },
    [runStream]
  );

  const stop = useCallback(() => {
    const runId = stateRef.current.runId;
    if (runId) void stopChatRun(runId).catch(() => {});
    stopRequestedRef.current = true;
    abortRef.current?.abort();
  }, []);

  const approve = useCallback(async (approvalId: string, decision: "approve" | "deny") => {
    try {
      await sendApprovalDecision(approvalId, decision);
    } catch {}
  }, []);

  const sendFeedback = useCallback(
    async (messageId: string, rating: "up" | "down" | null, note?: string) => {
      try {
        if (rating === null) await clearFeedback(messageId);
        else await postFeedback(messageId, rating, note);
      } catch {}
    },
    []
  );

  const reset = useCallback(() => {
    conversationIdRef.current = undefined;
    dispatch({ type: "reset" });
  }, []);

  const sendSurfaceInteraction = useCallback(
    (handle: string, input: Readonly<Record<string, unknown>>) => {
      if (isChatBusy(stateRef.current.status)) return;
      dispatch({ type: "surface-submit" });
      void postSurfaceInteraction(handle, { ...input })
        .then(() => send(surfaceInteractionAnswer(input), lastOptsRef.current))
        .catch((error) => {
          dispatch({
            type: "error",
            data: { message: error instanceof Error ? error.message : "interaction failed" },
          });
        });
    },
    [send]
  );

  return {
    messages: state.messages,
    pendingApprovals: state.pendingApprovals,
    status: state.status,
    currentAgent: state.currentAgent,
    conversationId: state.conversationId,
    error: state.error,
    connectionState,
    send,
    stop,
    approve,
    regenerate,
    tryHarder,
    sendFeedback,
    reset,
    sendSurfaceInteraction,
  };
}
