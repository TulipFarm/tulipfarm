import type { ServerResponse } from "node:http";

/** One streamed SSE event: a monotonic `seq` (the SSE `id`), a type, and a JSON payload. */
export interface StreamEvent {
  seq: number;
  eventType: string;
  data: unknown;
}

/**
 * How often an idle SSE stream writes a comment. Comfortably inside the 100s an edge proxy waits
 * for the origin before answering the client 524 on its behalf.
 */
export const SSE_KEEPALIVE_MS = 15_000;

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
  // The first Run event can be seconds away; without this the origin has sent nothing at all and
  // an edge proxy is entitled to call the request timed out.
  raw.flushHeaders();
}

/** Serializes SSE with `id:` for resume and one `data:` line per physical payload line. */
export function formatSseEvent(event: StreamEvent): string {
  return `id: ${event.seq}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event.data)}\n\n`;
}
