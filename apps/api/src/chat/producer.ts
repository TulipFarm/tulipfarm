import type { ServerResponse } from "node:http";
import type { A2uiSurfaceStore } from "../a2ui/surface-store";
import { CITE_SOURCES_TOOL } from "../knowledge/tools";
import { clientActionEvent } from "../platform/frontend-tools";
import type { ToolCallResult } from "../tools/types";
import { a2uiEventsForToolResult } from "./a2ui-surface";
import { writeSseEvent } from "./sse";
import type { StreamEmitter } from "./stream-emitter";
import { isTerminalEvent, type StreamEvent, type StreamHub } from "./stream-hub";
import type { StreamResumeRepo } from "./stream-resume";

interface MappedEvent {
  eventType: string;
  data: unknown;
}

/**
 * Map one AI SDK `fullStream` part to the SSE event we persist + fan out. Returns
 * `null` for internal parts (step boundaries, reasoning, tool-call deltas) the
 * client does not need. `finish`/`error` are the terminal events.
 */
export function mapStreamPart(
  part: unknown,
  fullResultCache?: Map<string, ToolCallResult>
): MappedEvent | null {
  if (typeof part !== "object" || part === null || !("type" in part)) return null;
  const p = part as Record<string, unknown>;
  switch (p.type) {
    case "text-delta":
      return { eventType: "text", data: { delta: p.text } };
    case "tool-call":
      return {
        eventType: "tool-call",
        data: { toolCallId: p.toolCallId, toolName: p.toolName, args: p.input },
      };
    case "tool-result": {
      const toolCallId = p.toolCallId as string;
      const result = fullResultCache?.get(toolCallId) ?? p.output;
      return {
        eventType: "tool-result",
        data: { toolCallId, toolName: p.toolName, result },
      };
    }
    case "agent-handoff":
      // Synthetic part yielded by the turn loop when the active agent switches (transfer/complete),
      // so the client's current-agent indicator follows the live handoff.
      return { eventType: "agent-handoff", data: { from: p.from, to: p.to, reason: p.reason } };
    case "finish":
      return { eventType: "finish", data: { reason: p.finishReason ?? "stop" } };
    case "error":
      return {
        eventType: "error",
        data: { message: p.error instanceof Error ? p.error.message : "stream error" },
      };
    default:
      return null;
  }
}

/**
 * Map a `cite_sources` tool-result to the `sources` SSE payload the web reducer already renders
 * (`SourcesPart`). Returns `null` for any other tool, a failed result, or an empty/malformed list —
 * so only a successful, non-empty citation declaration surfaces a sources footer.
 */
export function sourcesEventForToolResult(
  toolName: string,
  result: ToolCallResult
): { sources: unknown[] } | null {
  if (toolName !== CITE_SOURCES_TOOL || !result.success) return null;
  const data = result.data as { sources?: unknown };
  const sources = data?.sources;
  if (!Array.isArray(sources) || sources.length === 0) return null;
  return { sources };
}

/** Output guard verdict over one buffered text segment (block, or pass-through/transform). */
export type OutputScan =
  | { blocked: true; guard: string; reason: string; message?: string }
  | { blocked: false; text: string };

export interface StreamProducerDeps {
  emitter: StreamEmitter;
  hub: StreamHub;
  log: { error: (obj: unknown, msg?: string) => void };
  fullResultCache?: Map<string, ToolCallResult>;
  // A2UI live surfaces: persisted on render_surface, loaded + diffed on update_surface (per conversation).
  surfaceStore?: A2uiSurfaceStore;
  conversationId?: string;
  // The per-turn abort signal (from the chat stop endpoint). When it fires, the LLM stream is
  // aborted: the producer converts the resulting AbortError / error part into a clean
  // `finish` (reason `stopped`) rather than a terminal `error`, so a deliberate stop reads as a stop.
  abortSignal?: AbortSignal;
  /**
   * Optional output guard. When set, the producer streams `text` progressively but holds back a
   * trailing safety window: it releases each prefix only after scanning the accumulated text (with
   * full forward context) so no sensitive pattern is emitted before it is seen. A `block` drops all
   * unsent text and emits `guardrail_block` + `finish`. A short run (under the window) is scanned
   * once and emitted as a single event, honouring any whole-text transform. When unset, text
   * deltas emit live unchanged.
   */
  scanOutput?: (text: string) => Promise<OutputScan>;
}

/**
 * Detached turn producer: consumes `fullStream` to completion (independent of any
 * client socket), emitting each mapped event through the shared `StreamEmitter`
 * (seq + `stream_resume` persist + hub publish). Always emits a terminal
 * (`finish`|`error`) and finishes the hub so reconnects never hang. Never throws —
 * failures are logged. The same emitter is shared with the approval gate so
 * out-of-band approval events stay on one monotonic seq.
 */
export async function runChatStream(
  streamId: string,
  fullStream: AsyncIterable<unknown>,
  deps: StreamProducerDeps
): Promise<void> {
  let sawTerminal = false;
  // Output-guard streaming state (only used when `deps.scanOutput` is set). We keep the FULL
  // accumulated text of the current run plus an `emitted` offset (rather than draining the buffer),
  // so every scan sees full forward context and we can release a safe prefix while still holding
  // back a trailing window.
  const scanOutput = deps.scanOutput;
  let textBuffer = "";
  let emitted = 0;
  let blocked = false;

  // Hold back at least this many trailing characters before releasing text, so a sensitive pattern
  // (card, SSN, email, typical API key — all shorter than this) is always fully scanned before any
  // of its characters reach the client. The content guard BLOCKS rather than redacts, so a token
  // once emitted can't be retracted; this window is what lets us stream progressively without
  // leaking a pattern. (An unusually long secret could still partially precede the block — the
  // price of streaming a block-style guard; switch the guard to redaction to remove that edge.)
  const SAFE_TAIL = 64;

  // Scan the accumulated run text and release the portion now safe to emit. `final` flushes
  // everything (end of a text run or of the stream); otherwise everything except the trailing
  // SAFE_TAIL. A block drops all unsent text and emits `guardrail_block` + `finish`, suppressing
  // the rest of the turn.
  const drainText = async (
    scan: (text: string) => Promise<OutputScan>,
    final: boolean
  ): Promise<void> => {
    if (blocked) return;
    const releaseTo = final ? textBuffer.length : textBuffer.length - SAFE_TAIL;
    if (releaseTo <= emitted) return;
    const verdict = await scan(textBuffer);
    if (verdict.blocked) {
      await deps.emitter.emit("guardrail_block", {
        stage: "output",
        guard: verdict.guard,
        reason: verdict.reason,
        message: verdict.message,
      });
      await deps.emitter.emit("finish", { reason: "guardrail_block" });
      blocked = true;
      sawTerminal = true;
      return;
    }
    // Single-shot run (nothing emitted yet, flushing the whole thing): emit the scanned text so a
    // whole-text transform is honoured. Progressive chunks are emitted verbatim — the output guards
    // in use only block or pass, never transform a partial slice.
    if (emitted === 0 && final) {
      if (verdict.text.length > 0) await deps.emitter.emit("text", { delta: verdict.text });
      emitted = textBuffer.length;
      return;
    }
    const chunk = textBuffer.slice(emitted, releaseTo);
    if (chunk.length > 0) {
      await deps.emitter.emit("text", { delta: chunk });
      emitted = releaseTo;
    }
  };

  // Reset the run accumulator once a run is fully flushed (e.g. before a tool event).
  const resetText = (): void => {
    textBuffer = "";
    emitted = 0;
  };

  try {
    for await (const part of fullStream) {
      if (blocked) continue;
      const mapped = mapStreamPart(part, deps.fullResultCache);
      if (!mapped) continue;
      // Deliberate stop: the LLM was aborted via the stop endpoint. Aborting can surface as a graceful
      // end (the turn yields its own `finish`), an `error` part, or a throw (handled in the catch).
      // Whichever terminal arrives, rewrite it to one clean `finish` (reason `stopped`) and stop.
      if (deps.abortSignal?.aborted && isTerminalEvent(mapped.eventType)) {
        await deps.emitter.emit("finish", { reason: "stopped" });
        sawTerminal = true;
        break;
      }
      if (scanOutput && mapped.eventType === "text") {
        textBuffer += (mapped.data as { delta: string }).delta;
        await drainText(scanOutput, false);
        continue;
      }
      if (scanOutput) {
        await drainText(scanOutput, true);
        resetText();
        if (blocked) continue;
      }
      await deps.emitter.emit(mapped.eventType, mapped.data);
      // A view/terminal tool (compose_view, present_choices, suggest_agent, render_surface) result
      // also emits a follow-on `a2ui` event carrying the rendered tf-* block / compiled surface; the
      // tool-result stays intact so the model still reads the structured data. Non-view tools → null.
      if (mapped.eventType === "tool-result") {
        const { toolName, result } = mapped.data as { toolName: string; result: ToolCallResult };
        // View/surface tools emit `a2ui` events (createSurface / updateDataModel / legacy html) and
        // keep the surface store current so a later update_surface can diff + swap in place.
        const a2uiEvents = await a2uiEventsForToolResult(toolName, result, {
          store: deps.surfaceStore,
          conversationId: deps.conversationId,
        });
        for (const ev of a2uiEvents) await deps.emitter.emit("a2ui", ev);
        // Frontend-action tools (navigate_to, …) also emit a `client-action` the web shell executes.
        const action = clientActionEvent(toolName, result);
        if (action) await deps.emitter.emit("client-action", action);
        // `cite_sources` emits a `sources` event so the answer's citations render as clickable links.
        const sources = sourcesEventForToolResult(toolName, result);
        if (sources) await deps.emitter.emit("sources", sources);
      }
      if (isTerminalEvent(mapped.eventType)) sawTerminal = true;
    }
    if (scanOutput) await drainText(scanOutput, true);
    if (!sawTerminal && !blocked) {
      await deps.emitter.emit("finish", { reason: deps.abortSignal?.aborted ? "stopped" : "stop" });
    }
  } catch (err) {
    if (!sawTerminal) {
      // A deliberate stop (abort) ends as a clean `finish`, not an `error` — so it is not logged as a
      // failure and the client reads it as a stop rather than a crash.
      if (deps.abortSignal?.aborted || (err instanceof Error && err.name === "AbortError")) {
        await deps.emitter.emit("finish", { reason: "stopped" });
      } else {
        deps.log.error({ err, streamId }, "chat stream producer failed");
        await deps.emitter.emit("error", {
          message: err instanceof Error ? err.message : "stream error",
        });
      }
    }
  } finally {
    deps.hub.finish(streamId);
  }
}

export interface AttachDeps {
  repo: StreamResumeRepo;
  hub: StreamHub;
}

/**
 * Stream a hijacked connection from `afterSeq`. Subscribes to the live tail FIRST
 * (buffering), then replays the durable rows after `afterSeq`, then flushes the
 * buffer (de-duped by seq) and goes live — closing the response on the terminal
 * event. A client disconnect detaches the reader but never stops the producer.
 * Resolves when the connection ends.
 */
export function attachToStream(
  raw: ServerResponse,
  streamId: string,
  afterSeq: number,
  deps: AttachDeps
): Promise<void> {
  return new Promise((resolve) => {
    let closed = false;
    let live = false;
    let lastSeq = afterSeq;
    const buffer: StreamEvent[] = [];
    let unsub: () => void = () => {};

    const detach = (): void => {
      if (closed) return;
      closed = true;
      unsub();
    };
    const close = (): void => {
      if (closed) return;
      detach();
      raw.end();
      resolve();
    };
    const send = (event: StreamEvent): void => {
      if (closed || event.seq <= lastSeq) return;
      writeSseEvent(raw, event);
      lastSeq = event.seq;
      if (isTerminalEvent(event.eventType)) close();
    };

    unsub = deps.hub.subscribe(streamId, (event) => {
      if (live) send(event);
      else buffer.push(event);
    });

    raw.on("close", () => {
      if (!closed) {
        detach();
        resolve();
      }
    });

    deps.repo
      .listAfter(streamId, afterSeq)
      .then((replay) => {
        for (const event of replay) send(event);
        if (closed) return;
        for (const event of buffer) send(event);
        if (closed) return;
        // Nothing live left to produce (finished/expired, or resumed past the end):
        // close now rather than hang waiting for events that will never arrive.
        if (!deps.hub.isLive(streamId)) {
          close();
          return;
        }
        live = true;
      })
      .catch(() => close());
  });
}
