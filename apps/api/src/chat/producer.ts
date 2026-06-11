import type { ServerResponse } from "node:http";
import type { ToolCallResult } from "../tools/types";
import { writeSseEvent } from "./sse";
import type { StreamEmitter } from "./stream-emitter";
import { type StreamEvent, type StreamHub, isTerminalEvent } from "./stream-hub";
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

export interface StreamProducerDeps {
  emitter: StreamEmitter;
  hub: StreamHub;
  log: { error: (obj: unknown, msg?: string) => void };
  fullResultCache?: Map<string, ToolCallResult>;
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

  try {
    for await (const part of fullStream) {
      const mapped = mapStreamPart(part, deps.fullResultCache);
      if (!mapped) continue;
      await deps.emitter.emit(mapped.eventType, mapped.data);
      if (isTerminalEvent(mapped.eventType)) sawTerminal = true;
    }
    if (!sawTerminal) await deps.emitter.emit("finish", { reason: "stop" });
  } catch (err) {
    deps.log.error({ err, streamId }, "chat stream producer failed");
    if (!sawTerminal) {
      await deps.emitter.emit("error", {
        message: err instanceof Error ? err.message : "stream error",
      });
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
