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
    writeSseHeaders({ setHeader } as unknown as ServerResponse, { "X-Stream-Id": "abc" });
    expect(setHeader).toHaveBeenCalledWith("Content-Type", "text/event-stream");
    expect(setHeader).toHaveBeenCalledWith("X-Stream-Id", "abc");
  });
});
