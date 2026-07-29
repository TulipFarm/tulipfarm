import { describe, expect, it } from "vitest";
import type { ToolCallResult } from "../tools/types";
import { mapStreamPart, runChatStream, sourcesEventForToolResult } from "./producer";
import { makeStreamEmitter } from "./stream-emitter";
import { StreamHub } from "./stream-hub";
import { MemoryStreamResumeRepo } from "./stream-resume";

async function* stream(parts: unknown[]) {
  for (const part of parts) yield part;
}

describe("mapStreamPart", () => {
  it("maps text, Tool results, and terminal events", () => {
    expect(mapStreamPart({ type: "text-delta", text: "hello" })).toEqual({
      eventType: "text",
      data: { delta: "hello" },
    });
    expect(mapStreamPart({ type: "finish", finishReason: "stop" })).toEqual({
      eventType: "finish",
      data: { reason: "stop" },
    });
  });
});

describe("sourcesEventForToolResult", () => {
  it("emits only successful non-empty citations", () => {
    const result: ToolCallResult = {
      success: true,
      data: { sources: [{ title: "Source" }] },
    };
    expect(sourcesEventForToolResult("cite_sources", result)).toEqual({
      sources: [{ title: "Source" }],
    });
    expect(sourcesEventForToolResult("other", result)).toBeNull();
  });
});

describe("runChatStream", () => {
  it("emits a canonical Surface event after a presentation Tool result", async () => {
    const repo = new MemoryStreamResumeRepo();
    const hub = new StreamHub();
    const emitter = makeStreamEmitter("stream-1", {
      repo,
      hub,
      log: { error: () => undefined },
    });
    const artifact = {
      protocol: "tsp",
      protocolVersion: "1.0",
      id: "status",
      revision: 1,
      component: { name: "Status", version: "1.0" },
      props: { label: "Ready" },
      target: { channel: "web", surface: "chat" },
      catalogRevision: "test",
      audience: ["user:1"],
      classification: "internal",
      lineage: [],
    };
    await runChatStream(
      "stream-1",
      stream([
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "present",
          output: { success: true, data: { artifact } },
        },
        { type: "finish", finishReason: "stop" },
      ]),
      { emitter, hub, log: { error: () => undefined } }
    );
    expect((await repo.listAfter("stream-1", 0)).map((event) => event.eventType)).toEqual([
      "tool-result",
      "surface",
      "finish",
    ]);
  });
});
