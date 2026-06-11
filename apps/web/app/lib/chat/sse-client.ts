/*
 * SSE transport for the chat endpoint. `parseSseFrames` is a pure, incremental frame splitter
 * (unit-tested without a network); `postChat` drives the hijacked SSE stream and maps each raw
 * frame to a typed `ChatEvent`; `sendApprovalDecision` posts an approval verdict via the shared
 * write client. Auth mirrors the rest of the app: cookie-first + optional Bearer + CSRF echo,
 * supplied by `mutationHeaders()`.
 */

import { API_BASE, ApiError, apiWrite, mutationHeaders } from "~/lib/api";
import type { Autonomy, ChatEvent, ChatEventType, ParsedFrame } from "~/lib/chat/types";

const KNOWN_EVENT_TYPES = new Set<ChatEventType>([
  "text",
  "reasoning",
  "tool-call",
  "tool-result",
  "approval-request",
  "approval-resolved",
  "plan",
  "task",
  "sources",
  "agent-handoff",
  "a2ui",
  "guardrail_block",
  "finish",
  "error",
]);

// Terminal events end the stream — the reader stops once one is seen.
const TERMINAL_EVENT_TYPES = new Set<ChatEventType>(["finish", "error"]);

// Strip a field's `name:` prefix, tolerating an optional single leading space after the colon
// (the spec emits "id: 1" but we also accept "id:1"). Returns null if the prefix is absent.
function fieldValue(line: string, name: string): string | null {
  const prefix = `${name}:`;
  if (!line.startsWith(prefix)) return null;
  const raw = line.slice(prefix.length);
  return raw.startsWith(" ") ? raw.slice(1) : raw;
}

// Split an SSE buffer on the `\n\n` frame boundary and parse each complete frame's id/event/data
// lines. Frames lacking an event or a data line, or whose data is not valid JSON, are dropped.
// The trailing partial (text after the last boundary) is returned in `rest` for the next chunk.
export function parseSseFrames(buffer: string): { frames: ParsedFrame[]; rest: string } {
  const segments = buffer.split("\n\n");
  const rest = segments.pop() ?? "";
  const frames: ParsedFrame[] = [];

  for (const segment of segments) {
    let seq = 0;
    let type: string | null = null;
    let dataLine: string | null = null;

    for (const line of segment.split("\n")) {
      const id = fieldValue(line, "id");
      if (id !== null) {
        const parsed = Number.parseInt(id, 10);
        if (!Number.isNaN(parsed)) seq = parsed;
        continue;
      }
      const event = fieldValue(line, "event");
      if (event !== null) {
        type = event;
        continue;
      }
      const data = fieldValue(line, "data");
      if (data !== null) dataLine = data;
    }

    if (type === null || dataLine === null) continue;
    try {
      frames.push({ seq, type, data: JSON.parse(dataLine) });
    } catch {
      // unparseable data — drop the frame
    }
  }

  return { frames, rest };
}

// Map a raw frame to a typed `ChatEvent`, or null when the event type is unknown. The `data` is
// trusted as the matching payload — the wire is server-controlled and the parser already JSON-
// validated it; the cast narrows the union without re-checking every field.
function toChatEvent(frame: ParsedFrame): ChatEvent | null {
  if (!KNOWN_EVENT_TYPES.has(frame.type as ChatEventType)) return null;
  return { type: frame.type, data: frame.data } as ChatEvent;
}

export type ChatRequestBody = {
  message: { role: "user"; content: string };
  conversationId?: string;
  model?: string;
  agentId?: string;
  autonomy?: Autonomy;
};

export type ChatStreamMeta = { conversationId?: string; streamId?: string };

export type PostChatHandlers = {
  signal?: AbortSignal;
  onEvent: (event: ChatEvent) => void;
  onMeta?: (meta: ChatStreamMeta) => void;
};

// Best-effort `{ error }` extraction so a failed POST throws the same ApiError shape as the rest of
// the client (status-carrying), without re-exporting api.ts's private readError.
async function readChatError(res: Response): Promise<ApiError> {
  let message = res.statusText || `request failed (${res.status})`;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") message = body.error;
  } catch {
    // non-JSON body — keep the status-text fallback
  }
  return new ApiError(res.status, message);
}

// POST to the chat endpoint and consume the hijacked SSE response. Reports the one-shot
// `X-Conversation-Id`/`X-Stream-Id` headers via `onMeta`, then streams typed events to `onEvent`,
// stopping at the first terminal event (finish/error) or when the reader is exhausted.
export async function postChat(body: ChatRequestBody, handlers: PostChatHandlers): Promise<void> {
  const { signal, onEvent, onMeta } = handlers;
  const res = await fetch(`${API_BASE}/api/v1/chat`, {
    method: "POST",
    credentials: "include",
    headers: mutationHeaders(),
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) throw await readChatError(res);

  onMeta?.({
    conversationId: res.headers.get("X-Conversation-Id") ?? undefined,
    streamId: res.headers.get("X-Stream-Id") ?? undefined,
  });

  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const { frames, rest } = parseSseFrames(buffer);
    buffer = rest;

    for (const frame of frames) {
      const event = toChatEvent(frame);
      if (!event) continue;
      onEvent(event);
      if (TERMINAL_EVENT_TYPES.has(event.type)) {
        await reader.cancel();
        return;
      }
    }
  }
}

// Post an approval verdict for a pending tool call. Reuses the shared write client so it inherits
// cookie/Bearer auth, the CSRF echo header, and ApiError-on-failure.
export function sendApprovalDecision(
  approvalId: string,
  decision: "approve" | "deny"
): Promise<{ status: string }> {
  return apiWrite<{ status: string }>(
    "POST",
    `/api/v1/chat/approvals/${encodeURIComponent(approvalId)}/decide`,
    { decision }
  );
}
