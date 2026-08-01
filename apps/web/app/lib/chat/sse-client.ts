/*
 * SSE transport for the chat endpoint. `parseSseFrames` is a pure, incremental frame splitter
 * (unit-tested without a network); `postChat` drives the hijacked SSE stream and projects each Run
 * event onto the typed `ChatEvent`s this app renders; `sendApprovalDecision` posts an approval
 * verdict via the shared write client. Auth mirrors the rest of the app: cookie-first + optional
 * Bearer + CSRF echo, supplied by `mutationHeaders()`.
 *
 * The wire is the durable Run event vocabulary — the same frames `GET /api/v1/runs/:id/events`
 * replays and a Slack or Telegram reader consumes — so this file is the one place the web's own
 * vocabulary is derived from it. Nothing here is the source of truth for a turn: the Run is, which
 * is why a lost connection reconnects by cursor instead of resending the question.
 */

import { API_BASE, ApiError, apiWrite, mutationHeaders } from "~/lib/api";
import type { Autonomy, ChatEvent, ChatEventType, ParsedFrame } from "~/lib/chat/types";

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

// The Run event payloads this client reads. Trusted as the matching shape: the wire is
// server-controlled, the payload was validated against its published schema before it was
// persisted, and the parser already checked it is JSON.
type RunEventData = {
  text?: string;
  callId?: string;
  name?: string;
  argsDigest?: string;
  status?: string;
  summary?: string;
  errorCode?: string;
  intentId?: string;
  stage?: string;
  reason?: string;
  messageId?: string | null;
};

/**
 * Projects the Run event stream onto the timeline's own vocabulary.
 *
 * Stateful by necessity, and only across one turn: a Tool's name arrives with `tool.call` and its
 * result arrives later carrying just the call id, and an approval is settled by whoever decides it
 * rather than announced back on this stream — so the mapper remembers which call is held and
 * releases it when that call finally reports. One run event can therefore produce zero, one, or two
 * timeline events.
 *
 * Two things the durable stream deliberately withholds are withheld here too: Tool arguments (a
 * digest stands in) and the identity of a guard that refused. Neither is a rendering gap to be
 * filled in later — they are the reason a participant's stream is safe to show.
 */
export function createRunEventMapper(): (frame: ParsedFrame) => ChatEvent[] {
  const heldByCall = new Map<string, string>();
  let finished = false;

  return (frame: ParsedFrame): ChatEvent[] => {
    const data = (frame.data ?? {}) as RunEventData;

    switch (frame.type) {
      case "text.delta":
        return [{ type: "text", data: { delta: data.text ?? "" } }];

      case "tool.call":
        return [
          {
            type: "tool-call",
            data: {
              toolCallId: data.callId ?? "",
              toolName: data.name ?? "tool",
              // The arguments themselves never reach a participant; the digest is what the stream
              // carries, and showing it is honest about that.
              args: { argsDigest: data.argsDigest },
            },
          },
        ];

      case "tool.result": {
        const callId = data.callId ?? "";
        const events: ChatEvent[] = [
          {
            type: "tool-result",
            data: {
              toolCallId: callId,
              toolName: "",
              result: {
                status: data.status,
                ...(data.summary === undefined ? {} : { summary: data.summary }),
                ...(data.errorCode === undefined ? {} : { errorCode: data.errorCode }),
              },
            },
          },
        ];
        const approvalId = heldByCall.get(callId);
        if (approvalId !== undefined) {
          heldByCall.delete(callId);
          // A held call that reports at all has been decided; a call refused at the approval is the
          // one that comes back denied. Nothing else can move a call out of `awaiting_approval`.
          events.push({
            type: "approval-resolved",
            data: {
              approvalId,
              toolCallId: callId,
              outcome: data.errorCode === "denied" ? "denied" : "approved",
            },
          });
        }
        return events;
      }

      case "approval.requested": {
        // Without the call it holds, an approval has nothing to render against; the operational
        // inbox is where such a decision is made instead.
        if (!data.callId || !data.intentId) return [];
        heldByCall.set(data.callId, data.intentId);
        return [
          {
            type: "approval-request",
            data: { approvalId: data.intentId, toolCallId: data.callId },
          },
        ];
      }

      case "guardrail.blocked": {
        // The tool-call stage is not shown: that block refuses one Tool, and the turn still answers.
        if (data.stage !== "input" && data.stage !== "output") return [];
        return [
          {
            type: "guardrail_block",
            data: { stage: data.stage, reason: data.reason ?? "blocked by policy" },
          },
        ];
      }

      case "turn.finished": {
        finished = true;
        if (data.status === "succeeded") {
          return [
            {
              type: "finish",
              data: { reason: "stop", ...(data.messageId ? { messageId: data.messageId } : {}) },
            },
          ];
        }
        if (data.status === "cancelled") return [{ type: "finish", data: { reason: "cancelled" } }];
        return [{ type: "error", data: { message: data.reason ?? "the turn failed" } }];
      }

      // The Run reached a terminal status. Normally `turn.finished` already said so; when it did
      // not, the turn ended without announcing itself and the timeline still has to be released.
      case "stream.closed":
        return finished ? [] : [{ type: "finish", data: { reason: "closed" } }];

      case "stream.revoked":
        return [{ type: "error", data: { message: "access to this run was revoked" } }];

      // `turn.started`, `surface.emitted`, and every operator-audience event have no timeline
      // counterpart. Surfaces are not rendered from this stream: the event names an Artifact id,
      // not the Artifact, and inventing one would show the participant something no Run produced.
      default:
        return [];
    }
  };
}

export type ChatRequestBody = {
  message: { role: "user"; content: string };
  conversationId?: string;
  model?: string;
  agentId?: string;
  autonomy?: Autonomy;
  // Per-turn `/skill` + `#resource` tags from the composer, eagerly injected into the agent's
  // context for this turn only (ephemeral, like `model`). Names resolve server-side.
  skills?: string[];
  resources?: string[];
  // Per-turn `~knowledge` page pins (pageIds) — their content is injected server-side this turn.
  knowledgePages?: string[];
  // What the user is viewing this turn — the agent reads it via the `get_client_context` tool (P3).
  clientContext?: { route?: string; title?: string };
};

export type ChatStreamMeta = {
  conversationId?: string;
  // The Run answering this turn (X-Run-Id): what a reconnect resumes and what a stop cancels.
  runId?: string;
  // The agent handling this turn (X-Agent-Id) so the header reflects the routed/@mentioned agent.
  agentId?: string;
};

export type PostChatHandlers = {
  signal?: AbortSignal;
  onEvent: (event: ChatEvent) => void;
  onMeta?: (meta: ChatStreamMeta) => void;
  onConnectionState?: (state: "online" | "reconnecting") => void;
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
// `X-Conversation-Id`/`X-Run-Id` headers via `onMeta`, then streams typed events to `onEvent`,
// stopping at the first terminal event (finish/error) or when the reader is exhausted.
export async function postChat(
  body: ChatRequestBody,
  handlers: PostChatHandlers,
  idempotencyKey?: string
): Promise<void> {
  return postTurnStream("/api/v1/chat", body, handlers, idempotencyKey);
}

export async function postSurfaceInteraction(
  handle: string,
  input: Record<string, unknown>
): Promise<unknown> {
  return apiWrite("POST", "/api/v1/surfaces/interactions", { handle, input });
}

async function postTurnStream(
  path: string,
  body: unknown,
  handlers: PostChatHandlers,
  idempotencyKey?: string
): Promise<void> {
  const { signal, onMeta } = handlers;
  const headers = mutationHeaders();
  // One key per turn, so re-sending this POST resolves to the Turn and Run the first attempt already
  // created instead of asking the agent the same question twice. Without it the server falls back to
  // the request id, which makes every delivery a separate Turn.
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) throw await readChatError(res);

  const runId = res.headers.get("X-Run-Id") ?? undefined;
  onMeta?.({
    conversationId: res.headers.get("X-Conversation-Id") ?? undefined,
    runId,
    agentId: res.headers.get("X-Agent-Id") ?? undefined,
  });

  // One mapper for the whole turn, reconnects included: it carries which Tool call is held on an
  // approval, and a reconnect that started a fresh one would forget it mid-turn.
  const map = createRunEventMapper();
  let outcome = await consumeSse(res, handlers, 0, map);
  if (outcome.terminal || !runId) return;

  for (let attempt = 1; attempt <= 3; attempt++) {
    handlers.onConnectionState?.("reconnecting");
    const headers = mutationHeaders();
    delete headers["Content-Type"];
    headers.Accept = "text/event-stream";
    headers["Last-Event-ID"] = String(outcome.lastSequence);
    // The Run's own stream, resumed strictly after the last event this client saw — the turn kept
    // running while the connection was gone, so nothing is replayed and nothing is missed.
    const resumed = await fetch(
      `${API_BASE}/api/v1/runs/${encodeURIComponent(runId)}/events?after=${outcome.lastSequence}`,
      {
        method: "GET",
        credentials: "include",
        headers,
        signal,
      }
    );
    if (!resumed.ok) throw await readChatError(resumed);
    outcome = await consumeSse(resumed, handlers, outcome.lastSequence, map);
    if (outcome.terminal) {
      handlers.onConnectionState?.("online");
      return;
    }
  }
  throw new ApiError(503, "The stream could not be recovered from its persisted cursor.");
}

async function consumeSse(
  response: Response,
  handlers: PostChatHandlers,
  afterSequence: number,
  map: (frame: ParsedFrame) => ChatEvent[]
): Promise<{ terminal: boolean; lastSequence: number }> {
  if (!response.body) return { terminal: false, lastSequence: afterSequence };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastSequence = afterSequence;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const { frames, rest } = parseSseFrames(buffer);
    buffer = rest;

    for (const frame of frames) {
      if (frame.seq <= lastSequence) continue;
      lastSequence = frame.seq;
      for (const event of map(frame)) {
        handlers.onEvent(event);
        if (TERMINAL_EVENT_TYPES.has(event.type)) {
          await reader.cancel();
          return { terminal: true, lastSequence };
        }
      }
    }
  }
  return { terminal: false, lastSequence };
}

// Stop the turn by cancelling its Run: whichever process is executing it observes the cancellation
// and halts, so a turn no longer has to be stopped by the connection that started it. Reuses the
// shared write client (cookie/Bearer auth + CSRF echo). 404s once the Run has finished — callers
// fire-and-forget, since the client also abandons its own stream.
export function stopChatRun(runId: string): Promise<{ status: string }> {
  return apiWrite<{ status: string }>(
    "POST",
    `/api/v1/chat/runs/${encodeURIComponent(runId)}/stop`,
    {}
  );
}

// Post an approval verdict for a pending tool call. Reuses the shared write client so it inherits
// cookie/Bearer auth, the CSRF echo header, and ApiError-on-failure.
export function sendApprovalDecision(
  approvalId: string,
  decision: "approve" | "deny"
): Promise<{ status: string }> {
  return apiWrite<{ status: string }>(
    "POST",
    `/api/v1/approvals/${encodeURIComponent(approvalId)}/decide`,
    { decision }
  );
}
