/*
 * React hook that owns the chat timeline: a `useReducer` wired to the SSE client. `send` pushes the
 * user message, opens the stream, and dispatches each typed event; `approve` posts an approval
 * verdict. The local action type unions the wire `ChatEvent`s with a `"user"` action so user turns
 * and assistant events share one dispatch while `chatReducer` stays pure over `ChatEvent`.
 * `conversationId` is mirrored into a ref so `send` reads the latest id without re-subscribing
 * (stale-closure guard). Cross-reload rehydration and reconnect are intentionally out of scope.
 */

import { type NavigateFunction, useNavigate } from "@remix-run/react";
import { useCallback, useReducer, useRef } from "react";
import { invokeClientAction, prefillForm } from "~/lib/chat/action-registry";
import {
  appendUserMessage,
  chatReducer,
  initialChatState,
  rewindLastTurn,
} from "~/lib/chat/reducer";
import type { ChatStreamMeta } from "~/lib/chat/sse-client";
import { postChat, sendApprovalDecision, stopChatStream } from "~/lib/chat/sse-client";
import type { Autonomy, ChatEvent, ChatMessage, ChatState, ModelTier } from "~/lib/chat/types";
import { clearFeedback, sendFeedback as postFeedback } from "~/lib/feedback";

export type SendOptions = {
  model?: ModelTier;
  autonomy?: Autonomy;
  agentId?: string;
  // Per-turn `/skill` + `#resource` tags from the composer (ephemeral, eagerly injected server-side).
  skills?: string[];
  resources?: string[];
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
  | { type: "editResend"; messageId: string; text: string }
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
function humanizeKey(key: string): string {
  const s = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : key;
}

function formatFieldValue(v: unknown): string {
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (v === null || v === undefined || v === "") return "—";
  return String(v);
}

/**
 * Map an A2UI bridge `agent` payload (posted by a tf-* control click via the iframe runtime) into a
 * follow-up user turn. `choice` submits the chosen label (falling back to its value); `suggest_agent`
 * submits a prompt and switches the active agent; `a2ui-form` (HITL submit) renders the gathered field
 * values as a readable markdown list (the server injects it as the open `ask_user` tool-result and
 * resumes the run); `a2ui-action` submits a button's event (+ payload). Unknown payloads are ignored.
 */
export function a2uiAgentToSend(payload: unknown): { text: string; opts?: SendOptions } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (p.kind === "choice") {
    const text = typeof p.label === "string" ? p.label : typeof p.value === "string" ? p.value : "";
    return text ? { text } : null;
  }
  if (p.kind === "suggest_agent") {
    const text = typeof p.label === "string" ? p.label : "";
    const agentId = typeof p.agentId === "string" ? p.agentId : undefined;
    return text ? { text, opts: agentId ? { agentId } : undefined } : null;
  }
  if (p.kind === "a2ui-form") {
    const data =
      typeof p.data === "object" && p.data !== null ? (p.data as Record<string, unknown>) : {};
    const lines = Object.entries(data).map(
      ([k, v]) => `- **${humanizeKey(k)}:** ${formatFieldValue(v)}`
    );
    return { text: lines.length > 0 ? lines.join("\n") : "(submitted)" };
  }
  if (p.kind === "a2ui-action") {
    const event = typeof p.event === "string" ? p.event : "";
    if (!event) return null;
    const hasPayload = typeof p.payload === "object" && p.payload !== null;
    return { text: hasPayload ? `${event} ${JSON.stringify(p.payload)}` : event };
  }
  return null;
}

function reducer(state: ChatState, action: ChatAction): ChatState {
  if (action.type === "user") return appendUserMessage(state, action.text);
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
  if (action.type === "editResend") {
    // Branch from a prior user turn: drop that message and everything after it, then re-append the
    // edited text as a fresh turn. Local-only (the server keeps its full history) — the same V1
    // trade-off as "regenerate", which likewise has no server-side counterpart.
    const idx = state.messages.findIndex((m) => m.id === action.messageId);
    if (idx === -1) return state;
    return appendUserMessage({ ...state, messages: state.messages.slice(0, idx) }, action.text);
  }
  if (action.type === "meta") {
    return {
      ...state,
      conversationId: action.meta.conversationId ?? state.conversationId,
      streamId: action.meta.streamId ?? state.streamId,
      // Server-authoritative active agent for this turn (the @mentioned/conversation agent), so the
      // header follows direct routing — not only transfer_to_agent handoffs. Kept if absent.
      currentAgent: action.meta.agentId ?? state.currentAgent,
      // The reply's persisted id arrives once per turn, before any text; the `finish` case stamps it
      // onto the sealed assistant message as `serverId`. Set it directly (NOT `?? state.pendingServerId`)
      // so a turn whose header is absent clears it rather than inheriting the previous turn's id.
      pendingServerId: action.meta.messageId,
    };
  }
  return chatReducer(state, action);
}

export function useChatStream(opts?: UseChatStreamOptions) {
  const [state, dispatch] = useReducer(reducer, opts, seedState);
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
        }
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

  // Edit an earlier user turn and re-run from it, dropping every later turn (a local branch — the
  // server keeps its history, mirroring regenerate). Reuses the last turn's model/agent options.
  const editResend = useCallback(
    async (messageId: string, text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      dispatch({ type: "editResend", messageId, text: trimmed });
      await runStream(trimmed, lastOptsRef.current);
    },
    [runStream]
  );

  // Stop the in-flight turn: best-effort halt the server's LLM (so token burn stops), then abort the
  // local fetch — the catch dispatches `stopped`, rewinding the turn. The streamId arrives via the
  // X-Stream-Id header (onMeta) almost immediately; a stop in the brief window before it lands still
  // aborts locally (the server then runs that one turn to completion).
  const stop = useCallback(() => {
    const sid = stateRef.current.streamId;
    if (sid) void stopChatStream(sid).catch(() => {});
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

  // Bridge postback from an A2UI tf-* control: turn the `agent` payload into a follow-up user turn.
  const sendA2uiAgent = useCallback(
    (payload: unknown) => {
      const mapped = a2uiAgentToSend(payload);
      if (mapped) void send(mapped.text, mapped.opts);
    },
    [send]
  );

  return {
    messages: state.messages,
    pendingApprovals: state.pendingApprovals,
    status: state.status,
    currentAgent: state.currentAgent,
    error: state.error,
    send,
    stop,
    approve,
    regenerate,
    editResend,
    sendFeedback,
    reset,
    sendA2uiAgent,
  };
}
