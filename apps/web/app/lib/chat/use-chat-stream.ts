/*
 * React hook that owns the chat timeline: a `useReducer` wired to the SSE client. `send` pushes the
 * user message, opens the stream, and dispatches each typed event; `approve` posts an approval
 * verdict. The local action type unions the wire `ChatEvent`s with a `"user"` action so user turns
 * and assistant events share one dispatch while `chatReducer` stays pure over `ChatEvent`.
 * `conversationId` is mirrored into a ref so `send` reads the latest id without re-subscribing
 * (stale-closure guard). Cross-reload rehydration and reconnect are intentionally out of scope.
 */

import { type NavigateFunction, useNavigate } from "@remix-run/react";
import { useCallback, useReducer, useRef, useState } from "react";
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
  sendApprovalDecision,
  stopChatRun,
} from "~/lib/chat/sse-client";
import type {
  Autonomy,
  ChatEvent,
  ChatMessage,
  ChatState,
  ChatStatus,
  ModelTier,
} from "~/lib/chat/types";
import { clearFeedback, sendFeedback as postFeedback } from "~/lib/feedback";
import { randomUUID } from "~/lib/uuid";

export type SendOptions = {
  model?: ModelTier;
  autonomy?: Autonomy;
  agentId?: string;
  // Per-turn `/skill` + `#resource` tags from the composer (ephemeral, eagerly injected server-side).
  skills?: string[];
  resources?: string[];
  // Per-turn `~knowledge` page pins (pageIds) — full page content injected server-side this turn.
  knowledgePages?: string[];
};

export type UseChatStreamOptions = {
  // Seed a restored conversation (the `/chat/:id` route) so its transcript renders and follow-up
  // turns reuse the same id; absent for a fresh chat.
  initialConversationId?: string;
  initialMessages?: ChatMessage[];
  // Fired when a brand-new conversation id arrives and again on each turn's `finish`, so the sidebar
  // can refresh — picking up the new chat and its async-generated title.
  onConversationChange?: (conversationId: string | undefined) => void;
};

// Build the initial reducer state: a seeded transcript for a restored chat, else the empty timeline.
export function seedState(opts?: UseChatStreamOptions): ChatState {
  if (opts?.initialMessages && opts.initialMessages.length > 0) {
    return {
      messages: opts.initialMessages,
      pendingApprovals: {},
      status: "idle",
      conversationId: opts.initialConversationId,
    };
  }
  return opts?.initialConversationId
    ? { ...initialChatState, conversationId: opts.initialConversationId }
    : initialChatState;
}

// Wire events plus two hook-local actions: a user turn and the one-shot stream metadata. Keeping
// these out of `chatReducer` lets that reducer stay pure over the `ChatEvent` wire contract.
type ChatAction =
  | ChatEvent
  | { type: "user"; text: string }
  | { type: "meta"; meta: ChatStreamMeta }
  | { type: "regenerate" }
  | { type: "surface-submit" }
  | { type: "stopped" }
  | { type: "reset" };

/** Snapshot what the user is viewing, sent with each turn so the agent can `get_client_context`. */
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

/** "emailNotifications" / "email_notifications" → "Email notifications" for a readable submission. */
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
  if (action.type === "user") return appendUserMessage(state, action.text);
  if (action.type === "surface-submit") return { ...state, status: "submitted", error: undefined };
  if (action.type === "reset") return initialChatState;
  // Stop: rewind the in-flight turn (drop the user message + partial reply). The composer restores
  // the original prompt into its editor so it can be fixed and resent.
  if (action.type === "stopped") return rewindLastTurn(state);
  if (action.type === "regenerate") {
    // Drop the trailing assistant turn so the re-streamed events fold onto a fresh one (the prior user
    // message stays — no duplicate bubble). The server still records a new turn: V1 has no true
    // server-side regenerate, but with no history rehydration the local view stays clean.
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
      // Server-authoritative active agent for this turn (the @mentioned/conversation agent), so the
      // header follows direct routing — not only transfer_to_agent handoffs. Kept if absent.
      currentAgent: action.meta.agentId ?? state.currentAgent,
    };
  }
  return chatReducer(state, action);
}

export function useChatStream(opts?: UseChatStreamOptions) {
  const [state, dispatch] = useReducer(reducer, opts, seedState);
  const [connectionState, setConnectionState] = useState<"online" | "reconnecting">("online");
  // Latest conversation id + state + last send options, read inside callbacks without re-subscribing.
  const conversationIdRef = useRef<string | undefined>(opts?.initialConversationId);
  const stateRef = useRef(state);
  stateRef.current = state;
  const lastOptsRef = useRef<SendOptions | undefined>(undefined);
  // The in-flight turn's abort handle, so `stop` can cancel the fetch (and the catch can tell a
  // user-initiated stop from a real transport error).
  const abortRef = useRef<AbortController | null>(null);
  // Mirror the latest refresh callback so the stable `runStream` closure always calls the current one.
  const onConversationChangeRef = useRef(opts?.onConversationChange);
  onConversationChangeRef.current = opts?.onConversationChange;
  // Router for imperative agent→client actions (navigate_to), via a ref so `runStream` stays stable.
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // Open the stream for `text` and fold its events into the timeline. Shared by send + regenerate.
  const runStream = useCallback(async (text: string, opts?: SendOptions) => {
    const controller = new AbortController();
    abortRef.current = controller;
    // Minted once per turn: it is what the server deduplicates a re-sent POST by. A regenerate is a
    // deliberately new turn, so it mints its own key rather than resolving to the previous Run.
    const idempotencyKey = randomUUID();
    try {
      await postChat(
        {
          message: { role: "user", content: text },
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
              // First turn of a fresh chat: surface the new conversation to the sidebar immediately.
              onConversationChangeRef.current?.(meta.conversationId);
            }
            dispatch({ type: "meta", meta });
          },
          onEvent: (event) => {
            // Imperative agent→client actions execute as a side effect; they don't touch the timeline.
            if (event.type === "client-action") {
              handleClientAction(event.data, navigateRef.current);
              return;
            }
            dispatch(event);
            // On completion the async title has usually landed — refresh so the sidebar shows it.
            if (event.type === "finish")
              onConversationChangeRef.current?.(conversationIdRef.current);
          },
          onConnectionState: setConnectionState,
        },
        idempotencyKey
      );
    } catch (err) {
      // A user-initiated stop aborts the fetch (AbortError): rewind the turn instead of showing an
      // error. Any other failure (auth, 5xx, network) surfaces so the composer leaves its busy state.
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
    }
  }, []);

  const send = useCallback(
    async (text: string, opts?: SendOptions) => {
      dispatch({ type: "user", text });
      lastOptsRef.current = opts;
      await runStream(text, opts);
    },
    [runStream]
  );

  // Re-run the most recent user turn with the same options. Only meaningful on the last assistant msg.
  const regenerate = useCallback(async () => {
    const lastUser = [...stateRef.current.messages].reverse().find((m) => m.role === "user");
    const text = lastUser?.parts.map((p) => (p.kind === "text" ? p.text : "")).join("") ?? "";
    if (!text) return;
    dispatch({ type: "regenerate" });
    await runStream(text, lastOptsRef.current);
  }, [runStream]);

  // Stop the in-flight turn: cancel its Run (the executing process halts the turn), then abandon the
  // local stream — the catch dispatches `stopped`, rewinding the timeline. The runId arrives via the
  // X-Run-Id header (onMeta) almost immediately; a stop in the brief window before it lands still
  // detaches locally, and the Run then finishes on the server. Cancellation is eventually consistent:
  // the turn stops once the executor observes it, not the instant this returns.
  const stop = useCallback(() => {
    const runId = stateRef.current.runId;
    if (runId) void stopChatRun(runId).catch(() => {});
    abortRef.current?.abort();
  }, []);

  const approve = useCallback(async (approvalId: string, decision: "approve" | "deny") => {
    try {
      await sendApprovalDecision(approvalId, decision);
    } catch {
      // The approval-resolved SSE event is the source of truth for the card state; a failed decide
      // (e.g. a 404 race with the auto-deny timeout) needs no separate UI handling in V1.
    }
  }, []);

  // Persist a thumbs vote on an assistant reply (fire-and-forget, like `approve`): `rating` null
  // clears the vote. Optimistic UI lives in the component; a failed write needs no V1 surfacing.
  const sendFeedback = useCallback(
    async (messageId: string, rating: "up" | "down" | null, note?: string) => {
      try {
        if (rating === null) await clearFeedback(messageId);
        else await postFeedback(messageId, rating, note);
      } catch {
        // Non-blocking: the local thumb state is the source of truth in-session.
      }
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
    sendFeedback,
    reset,
    sendSurfaceInteraction,
  };
}
