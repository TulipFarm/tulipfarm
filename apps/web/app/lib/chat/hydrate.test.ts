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

  it("retains exact Surfaces, safe prose, and both retry attempts", () => {
    const timeline = messagesToTimeline([
      {
        _id: "attempt-1",
        conversationId: "conversation",
        role: "assistant",
        content: "Safe progress from attempt one.",
        metadata: {
          surfaces: [{ artifactId: "artifact", revision: 4 }],
          turnAttempt: {
            runId: "run-1",
            attempt: 1,
            cursor: 8,
            outcome: "failed",
            complete: true,
          },
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        _id: "surface-link",
        conversationId: "conversation",
        role: "tool",
        content: [{ type: "surface", artifactId: "artifact", revision: 4 }],
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        _id: "attempt-2",
        conversationId: "conversation",
        role: "assistant",
        content: "The retry finished.",
        metadata: {
          turnAttempt: {
            runId: "run-2",
            attempt: 2,
            cursor: 3,
            outcome: "succeeded",
            complete: true,
          },
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    ]);

    expect(timeline).toHaveLength(2);
    expect(timeline[0]).toMatchObject({
      sealed: true,
      turnAttempt: { runId: "run-1", attempt: 1, cursor: 8, complete: true },
      parts: [
        { kind: "text", text: "Safe progress from attempt one." },
        { kind: "surface", artifactId: "artifact", revision: 4 },
      ],
    });
    expect(timeline[1]?.parts).toEqual([{ kind: "text", text: "The retry finished." }]);
  });

  it("leaves an incomplete attempt open for live events to continue", () => {
    const timeline = messagesToTimeline([
      {
        _id: "attempt",
        conversationId: "conversation",
        role: "assistant",
        content: "Already saved. ",
        metadata: {
          toolCalls: [{ callId: "call-1", name: "record_create", argsDigest: "sha256:args" }],
          turnAttempt: {
            runId: "run-1",
            attempt: 1,
            cursor: 6,
            outcome: "waiting",
            complete: false,
            wait: {
              kind: "approval",
              waitId: "wait-1",
              approvalId: "approval-1",
              callId: "call-1",
            },
          },
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    expect(timeline[0]).toMatchObject({
      sealed: false,
      turnAttempt: { runId: "run-1", cursor: 6, complete: false },
      parts: [
        {
          kind: "tool",
          toolCallId: "call-1",
          status: "running",
          approval: { approvalId: "approval-1", status: "pending" },
        },
        { kind: "text", text: "Already saved. " },
      ],
    });
  });

  it.each(["failed", "cancelled"] as const)(
    "marks an outcome-less Tool from a completed %s attempt as interrupted",
    (outcome) => {
      const timeline = messagesToTimeline([
        {
          _id: "attempt",
          conversationId: "conversation",
          role: "assistant",
          content: "",
          metadata: {
            toolCalls: [{ callId: "call-1", name: "record_create" }],
            turnAttempt: {
              runId: "run-1",
              attempt: 1,
              cursor: 6,
              outcome,
              complete: true,
            },
          },
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ]);

      expect(timeline[0]?.parts).toEqual([
        expect.objectContaining({
          kind: "tool",
          toolCallId: "call-1",
          status: "interrupted",
        }),
      ]);
    }
  );

  it("keeps a Tool with a recorded successful result done after terminal reconciliation", () => {
    const timeline = messagesToTimeline([
      {
        _id: "attempt",
        conversationId: "conversation",
        role: "assistant",
        content: "",
        metadata: {
          toolCalls: [{ callId: "call-1", name: "record_create", outcome: "ok" }],
          turnAttempt: {
            runId: "run-1",
            attempt: 1,
            cursor: 7,
            outcome: "failed",
            complete: true,
          },
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    expect(timeline[0]?.parts).toEqual([
      expect.objectContaining({
        kind: "tool",
        toolCallId: "call-1",
        status: "done",
        outcome: "ok",
      }),
    ]);
  });
});

describe("messagesToTimeline and user attachments", () => {
  const userMessage = (content: unknown) => ({
    _id: "user",
    conversationId: "conversation",
    role: "user" as const,
    content: content as string,
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  it("restores an attached File so a reloaded transcript still shows the image", () => {
    const timeline = messagesToTimeline([
      userMessage([
        { type: "text", text: "what is this?" },
        { type: "file", fileId: "f1", mediaType: "image/png", name: "shot.png" },
      ]),
    ]);

    expect(timeline[0]?.parts).toEqual([
      { kind: "text", text: "what is this?" },
      { kind: "file", fileId: "f1", mediaType: "image/png", name: "shot.png" },
    ]);
  });

  it("restores a message that is an attachment and nothing else", () => {
    const timeline = messagesToTimeline([
      userMessage([{ type: "file", fileId: "f1", mediaType: "image/png", name: "shot.png" }]),
    ]);

    expect(timeline[0]?.parts).toEqual([
      { kind: "file", fileId: "f1", mediaType: "image/png", name: "shot.png" },
    ]);
  });

  it("keeps a removed attachment in the transcript instead of dropping the reference", () => {
    const timeline = messagesToTimeline([
      userMessage([
        { type: "text", text: "what is this?" },
        { type: "file-unavailable", fileId: "f1", name: "shot.png" },
      ]),
    ]);

    expect(timeline[0]?.parts).toEqual([
      { kind: "text", text: "what is this?" },
      { kind: "file-unavailable", fileId: "f1", name: "shot.png" },
    ]);
  });

  it("still restores a plain text message, which is stored as a bare string", () => {
    const timeline = messagesToTimeline([userMessage("just words")]);
    expect(timeline[0]?.parts).toEqual([{ kind: "text", text: "just words" }]);
  });
});
