import type { ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { formatSseEvent, writeSseHeaders } from "./sse";

describe("formatSseEvent", () => {
  it("frames id/event/data with a trailing blank line", () => {
    const out = formatSseEvent({ seq: 7, eventType: "text", data: { delta: "Hi" } });
    expect(out).toBe('id: 7\nevent: text\ndata: {"delta":"Hi"}\n\n');
  });

  it("serialises terminal events", () => {
    expect(formatSseEvent({ seq: 9, eventType: "finish", data: { reason: "stop" } })).toBe(
      'id: 9\nevent: finish\ndata: {"reason":"stop"}\n\n'
    );
  });
});

describe("writeSseHeaders", () => {
  it("sets the event-stream headers plus any extras", () => {
    const setHeader = vi.fn();
    writeSseHeaders({ setHeader, flushHeaders: vi.fn() } as unknown as ServerResponse, {
      "X-Stream-Id": "abc",
    });
    expect(setHeader).toHaveBeenCalledWith("Content-Type", "text/event-stream");
    expect(setHeader).toHaveBeenCalledWith("X-Stream-Id", "abc");
  });

  it("flushes the headers so the origin has answered before the first event", () => {
    // Headers set on the raw reply are not sent until something is written, and the first Run event
    // can be many seconds away. An edge proxy sees a silent origin and answers the client 524.
    const flushHeaders = vi.fn();
    writeSseHeaders({ setHeader: vi.fn(), flushHeaders } as unknown as ServerResponse);
    expect(flushHeaders).toHaveBeenCalledTimes(1);
  });
});
