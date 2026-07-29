import { describe, expect, it } from "vitest";
import { messagesToTimeline } from "./hydrate";

describe("messagesToTimeline", () => {
  it("restores Surface references and suppresses duplicated Tool prose", () => {
    const timeline = messagesToTimeline([
      {
        _id: "assistant",
        conversationId: "conversation",
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call",
            toolName: "present",
            args: {},
          },
        ],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        _id: "tool",
        conversationId: "conversation",
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call",
            toolName: "present",
            result: { success: true },
          },
          { type: "surface", artifactId: "artifact", revision: 1 },
        ],
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    ]);
    expect(timeline[0]?.parts).toContainEqual({
      kind: "surface",
      artifactId: "artifact",
      revision: 1,
    });
  });

  it("renders unavailable historical presentation parts as a fixed notice", () => {
    const timeline = messagesToTimeline([
      {
        _id: "assistant",
        conversationId: "conversation",
        role: "assistant",
        content: [{ type: "text", text: "old" }],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        _id: "tool",
        conversationId: "conversation",
        role: "tool",
        content: [
          {
            type: "surface-unavailable",
            message: "Legacy presentation unavailable",
          },
        ],
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    ]);
    expect(timeline[0]?.parts).toEqual([
      { kind: "surface-unavailable", message: "Legacy presentation unavailable" },
    ]);
  });
});
