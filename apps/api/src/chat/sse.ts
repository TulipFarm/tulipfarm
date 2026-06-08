import type { ServerResponse } from "node:http";
import type { StreamEvent } from "./stream-hub";

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

/**
 * Serialise one event in the SSE wire format the client `EventSource` parses:
 * `id: <seq>` feeds `Last-Event-ID` on reconnect; `event:` selects the typed
 * handler; `data:` carries the JSON payload. Trailing blank line ends the event.
 */
export function formatSseEvent(event: StreamEvent): string {
  return `id: ${event.seq}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/** Write one event to the raw response. */
export function writeSseEvent(raw: ServerResponse, event: StreamEvent): void {
  raw.write(formatSseEvent(event));
}
