import type { ServerResponse } from "node:http";

/** One streamed SSE event: a monotonic `seq` (the SSE `id`), a type, and a JSON payload. */
export interface StreamEvent {
  seq: number;
  eventType: string;
  data: unknown;
}

/** SSE response headers for a hijacked raw reply. */
export function writeSseHeaders(raw: ServerResponse, extra?: Record<string, string>): void {
  raw.setHeader("Content-Type", "text/event-stream");
  raw.setHeader("Cache-Control", "no-cache, no-transform");
  raw.setHeader("Connection", "keep-alive");
  raw.setHeader("X-Accel-Buffering", "no");
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      raw.setHeader(key, value);
    }
  }
}

/** Serializes SSE with `id:` for resume and one `data:` line per physical payload line. */
export function formatSseEvent(event: StreamEvent): string {
  return `id: ${event.seq}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event.data)}\n\n`;
}
