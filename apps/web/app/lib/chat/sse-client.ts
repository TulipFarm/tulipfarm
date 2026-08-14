/*
 * SSE transport for the chat endpoint. `parseSseFrames` is a pure, incremental frame splitter
 * (unit-tested without a network); `postChat` drives the hijacked SSE stream and projects each
 * Run event onto the typed `ChatEvent`s this app renders; `sendApprovalDecision` posts an
 * approval verdict via the shared write client.
 */

import type { EffortRung } from "@tulipfarm/schema";
import { API_BASE, ApiError, apiWrite, mutationHeaders } from "~/lib/api";
import type {
  Autonomy,
  ChatEvent,
  ChatEventType,
  ChatModelSelector,
  ParsedFrame,
  ToolPreview,
  ToolTier,
} from "~/lib/chat/types";

const TERMINAL_EVENT_TYPES = new Set<ChatEventType>(["finish", "error"]);

function fieldValue(line: string, name: string): string | null {
  const prefix = `${name}:`;
  if (!line.startsWith(prefix)) return null;
  const raw = line.slice(prefix.length);
  return raw.startsWith(" ") ? raw.slice(1) : raw;
}

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
    } catch {}
  }

  return { frames, rest };
}

type RunEventData = {
  text?: string;
  callId?: string;
  name?: string;
  argsDigest?: string;
  argsPreview?: ToolPreview;
  resultPreview?: ToolPreview;
  tier?: ToolTier;
  mutating?: boolean;
  agentId?: string;
  stepId?: string;
  startedAt?: string;
  durationMs?: number;
  status?: string;
  summary?: string;
  errorCode?: string;
  intentId?: string;
  stage?: string;
  reason?: string;
  messageId?: string | null;
  modelId?: string;
  effortPreset?: ChatModelSelector;
  effortApplied?: EffortRung;
  modelCallLatencyMs?: number;
  artifactId?: string;
};

export function modelFailureMessage(reason: string | undefined): string {
  switch (reason) {
    case "model_billing_inactive":
      return "The model provider's API billing is inactive. Activate billing or use another Provider Credential.";
    case "model_authentication_failed":
      return "The Provider Credential was rejected. Update it before trying again.";
    case "model_not_configured":
      return "No model is configured for this business. Add a model chain under Business → Models.";
    case "model_not_found":
      return "The configured model is unavailable. Choose another ModelProfile in Settings.";
    case "model_rate_limited":
      return "The model provider is rate limiting requests. Wait a moment and try again.";
    case "model_provider_unavailable":
      return "The model provider is temporarily unavailable. Try again shortly.";
    default:
      return "The model request failed. Try again.";
  }
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/**
 * Projects the Run event stream onto the timeline's own vocabulary. Stateful by necessity, and
 * only across one turn: a Tool's name arrives with `tool.call` and its result arrives later
 * carrying just the call id, and an approval is settled by whoever decides it rather than
 * announced back on this stream — so the mapper remembers which call is held and releases it
 * when that call finally reports.
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
            data: compact({
              toolCallId: data.callId ?? "",
              toolName: data.name ?? "tool",
              args: { argsDigest: data.argsDigest },
              preview: data.argsPreview,
              meta: compact({
                argsDigest: data.argsDigest,
                tier: data.tier,
                mutating: data.mutating,
                agentId: data.agentId,
                stepId: data.stepId,
                startedAt: data.startedAt,
              }),
            }),
          },
        ];

      case "tool.result": {
        const callId = data.callId ?? "";
        const events: ChatEvent[] = [
          {
            type: "tool-result",
            data: compact({
              toolCallId: callId,
              toolName: "",
              result: compact({
                status: data.status,
                summary: data.summary,
                errorCode: data.errorCode,
              }),
              preview: data.resultPreview,
              meta: compact({
                durationMs: data.durationMs,
                errorCode: data.errorCode,
                summary: data.summary,
              }),
            }),
          },
        ];
        const approvalId = heldByCall.get(callId);
        if (approvalId !== undefined) {
          heldByCall.delete(callId);
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
        const receipt =
          typeof data.modelId === "string" && typeof data.modelCallLatencyMs === "number"
            ? {
                modelId: data.modelId,
                ...(data.effortPreset === undefined ? {} : { effortPreset: data.effortPreset }),
                ...(data.effortApplied === undefined ? {} : { effortApplied: data.effortApplied }),
                modelCallLatencyMs: data.modelCallLatencyMs,
              }
            : undefined;
        if (data.status === "succeeded") {
          return [
            {
              type: "finish",
              data: {
                reason: "stop",
                ...(data.messageId ? { messageId: data.messageId } : {}),
                ...(receipt === undefined ? {} : { receipt }),
              },
            },
          ];
        }
        if (data.status === "cancelled") return [{ type: "finish", data: { reason: "cancelled" } }];
        return [{ type: "error", data: { message: modelFailureMessage(data.reason) } }];
      }

      case "stream.closed":
        return finished ? [] : [{ type: "finish", data: { reason: "closed" } }];

      case "stream.revoked":
        return [{ type: "error", data: { message: "access to this run was revoked" } }];

      case "surface.emitted": {
        if (!data.artifactId) return [];
        return [{ type: "surface", data: { artifactId: data.artifactId } }];
      }

      default:
        return [];
    }
  };
}

export type ChatRequestBody = {
  message: { role: "user"; content: string };
  conversationId?: string;
  model?: ChatModelSelector;
  agentId?: string;
  autonomy?: Autonomy;
  skills?: string[];
  resources?: string[];
  knowledgePages?: string[];
  clientContext?: { route?: string; title?: string };
};

export type ChatStreamMeta = {
  conversationId?: string;
  runId?: string;
  agentId?: string;
};

export type PostChatHandlers = {
  signal?: AbortSignal;
  onEvent: (event: ChatEvent) => void;
  onMeta?: (meta: ChatStreamMeta) => void;
  onConnectionState?: (state: "online" | "reconnecting") => void;
};

async function readChatError(res: Response): Promise<ApiError> {
  let message = res.statusText || `request failed (${res.status})`;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") message = body.error;
  } catch {}
  return new ApiError(res.status, message);
}

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

  const map = createRunEventMapper();
  let outcome = await consumeSse(res, handlers, 0, map);
  if (outcome.terminal || !runId) return;

  for (let attempt = 1; attempt <= 3; attempt++) {
    handlers.onConnectionState?.("reconnecting");
    const headers = mutationHeaders();
    delete headers["Content-Type"];
    headers.Accept = "text/event-stream";
    headers["Last-Event-ID"] = String(outcome.lastSequence);
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

export function stopChatRun(runId: string): Promise<{ status: string }> {
  return apiWrite<{ status: string }>(
    "POST",
    `/api/v1/chat/runs/${encodeURIComponent(runId)}/stop`,
    {}
  );
}

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
