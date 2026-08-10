import { describe, expect, it } from "vitest";
import { messagesToTimeline } from "./hydrate";

describe("messagesToTimeline", () => {
  it("restores persisted Tool metadata before the assistant text", () => {
    const timeline = messagesToTimeline([
      {
        _id: "assistant",
        conversationId: "conversation",
        role: "assistant",
        content: "done",
        metadata: {
          toolCalls: [
            {
              callId: "call",
              name: "record_create",
              argsDigest: "sha256:args",
              argsPreview: { json: '{"title":"x"}', bytes: 13 },
              resultPreview: { json: '{"ok":true}', bytes: 11 },
              durationMs: 25,
              outcome: "ok",
            },
          ],
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    expect(timeline[0]?.parts).toEqual([
      {
        kind: "tool",
        toolCallId: "call",
        toolName: "record_create",
        args: { argsDigest: "sha256:args" },
        status: "done",
        argsPreview: { json: '{"title":"x"}', bytes: 13 },
        resultPreview: { json: '{"ok":true}', bytes: 11 },
        meta: { argsDigest: "sha256:args", durationMs: 25 },
        outcome: "ok",
        result: { status: "ok" },
      },
      { kind: "text", text: "done" },
    ]);
  });

  it("ignores unknown Tool metadata shapes instead of failing restore", () => {
    const timeline = messagesToTimeline([
      {
        _id: "assistant",
        conversationId: "conversation",
        role: "assistant",
        content: "legacy",
        metadata: { toolCalls: [{ callId: "missing-name" }, "not-an-object"] },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    expect(timeline[0]?.parts).toEqual([{ kind: "text", text: "legacy" }]);
  });

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
