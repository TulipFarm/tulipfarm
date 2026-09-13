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
        content: [{ type: "surface", artifactId: "artifact", revision: 5 }],
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
        { kind: "surface", artifactId: "artifact", revision: 5 },
      ],
    });

    expect(timeline[1]?.parts).toEqual([{ kind: "text", text: "The retry finished." }]);
  });

  it("restores only the latest Surface revision within one attempt", () => {
    const timeline = messagesToTimeline([
      {
        _id: "attempt",
        conversationId: "conversation",
        role: "assistant",
        content: "",
        metadata: {
          surfaces: [
            { artifactId: "artifact", revision: 2 },
            { artifactId: "artifact", revision: 4 },
            { artifactId: "artifact", revision: 3 },
          ],
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    expect(timeline[0]?.parts).toEqual([{ kind: "surface", artifactId: "artifact", revision: 4 }]);
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

      expect(timeline[0]?.parts).toContainEqual(
        expect.objectContaining({
          kind: "tool",
          toolCallId: "call-1",
          status: "interrupted",
        })
      );
    }
  );

  it("does not restore pending approval controls on a completed cancelled attempt", () => {
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
            outcome: "cancelled",
            complete: true,
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

    expect(timeline[0]?.parts).toEqual([
      expect.objectContaining({
        kind: "tool",
        toolCallId: "call-1",
        status: "interrupted",
      }),
      { kind: "turn-status", status: "cancelled" },
    ]);
    expect(timeline[0]?.parts[0]).not.toHaveProperty("approval");
  });

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

  it("restores an orphan rejection with its real identity and no invented arguments", () => {
    const timeline = messagesToTimeline([
      {
        _id: "attempt",
        conversationId: "conversation",
        role: "assistant",
        content: "",
        metadata: {
          toolCalls: [
            {
              callId: "rejected-1",
              name: "unknown_tool",
              outcome: "error",
              errorCode: "tool_not_available",
              participantActivity: "visible",
            },
          ],
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    expect(timeline[0]?.parts).toEqual([
      expect.objectContaining({
        kind: "tool",
        toolCallId: "rejected-1",
        toolName: "unknown_tool",
        args: undefined,
        outcome: "error",
      }),
    ]);
  });

  it("restores the original request options and attachment-only input for retry", () => {
    const timeline = messagesToTimeline([
      {
        _id: "user",
        conversationId: "conversation",
        role: "user",
        content: [{ type: "file", fileId: "file-1", mediaType: "image/png", name: "chart.png" }],
        metadata: {
          turnRequest: {
            model: "thorough",
            autonomy: "supervised",
            agentId: "analyst",
            skills: ["forecast"],
            resources: ["customer"],
            knowledgePages: ["page-1"],
          },
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    expect(timeline[0]?.sourceTurn).toEqual({
      text: "",
      options: {
        model: "thorough",
        autonomy: "supervised",
        agentId: "analyst",
        skills: ["forecast"],
        resources: ["customer"],
        knowledgePages: ["page-1"],
        files: [{ fileId: "file-1", mediaType: "image/png", name: "chart.png" }],
      },
    });
  });

  it("restores only safe citation links and hides the represented Tool row", () => {
    const timeline = messagesToTimeline([
      {
        _id: "assistant",
        conversationId: "conversation",
        role: "assistant",
        content: "See [1] and [2].",
        metadata: {
          toolCalls: [
            {
              callId: "cite-1",
              name: "knowledge_citation",
              participantActivity: "represented",
              outcome: "ok",
              resultPreview: {
                json: JSON.stringify({
                  data: {
                    sources: [
                      { ref: 1, title: "Runbook", url: "https://example.com/runbook" },
                      { ref: 2, title: "Unsafe", url: "data:text/html,bad" },
                      { ref: 3, id: "flat-1", title: "Flat page" },
                    ],
                  },
                }),
              },
            },
          ],
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    expect(timeline[0]?.parts).toContainEqual({
      kind: "sources",
      sources: [
        { ref: 1, title: "Runbook", url: "https://example.com/runbook" },
        { ref: 2, title: "Unsafe" },
        { ref: 3, id: "flat-1", title: "Flat page" },
      ],
    });
  });

  it("marks a restored cancelled attempt visibly", () => {
    const timeline = messagesToTimeline([
      {
        _id: "assistant",
        conversationId: "conversation",
        role: "assistant",
        content: "Partial",
        metadata: {
          turnAttempt: {
            runId: "run-1",
            attempt: 1,
            cursor: 3,
            outcome: "cancelled",
            complete: true,
          },
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    expect(timeline[0]?.parts).toContainEqual({ kind: "turn-status", status: "cancelled" });
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
