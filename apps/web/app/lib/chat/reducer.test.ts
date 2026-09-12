import { createSurfaceArtifact } from "@tulipfarm/surface";
import { describe, expect, test } from "vitest";
import { messagesToTimeline } from "./hydrate";
import { appendUserMessage, chatReducer, initialChatState, rewindLastTurn } from "./reducer";
import type { ChatState } from "./types";

test("text deltas merge and finish seals the assistant Turn", () => {
  let state = chatReducer(initialChatState, { type: "text", data: { delta: "Hello" } });
  state = chatReducer(state, { type: "text", data: { delta: " world" } });
  state = chatReducer(state, { type: "finish", data: { reason: "stop" } });
  expect(state.messages[0]?.parts).toEqual([{ kind: "text", text: "Hello world" }]);
  expect(state.messages[0]?.sealed).toBe(true);
  expect(state.messages[0]?.receipt).toBeUndefined();
});

test("finish stores the model receipt when present", () => {
  let state = chatReducer(initialChatState, { type: "text", data: { delta: "Hello" } });
  state = chatReducer(state, {
    type: "finish",
    data: {
      reason: "stop",
      receipt: {
        modelId: "claude-sonnet-5",
        effortPreset: "balanced",
        modelCallLatencyMs: 1234,
      },
    },
  });

  expect(state.messages[0]?.receipt).toEqual({
    modelId: "claude-sonnet-5",
    effortPreset: "balanced",
    modelCallLatencyMs: 1234,
  });
});

test("live and restored Surface revisions remain separate exact presentations", () => {
  const first = createSurfaceArtifact({
    id: "status",
    component: { name: "Status", version: "1.0" },
    props: { label: "Ready" },
    target: { channel: "web", surface: "chat" },
    audience: ["user:1"],
    classification: "internal",
  });
  let state = chatReducer(initialChatState, {
    type: "surface",
    data: { artifactId: first.id, artifact: first },
  });
  const second = { ...first, revision: 2, props: { label: "Done" } };
  state = chatReducer(state, {
    type: "surface",
    data: { artifactId: second.id, revision: 2, artifact: second },
  });
  const liveParts = state.messages[0]?.parts;
  const restoredParts = messagesToTimeline([
    {
      _id: "assistant",
      conversationId: "conversation",
      role: "assistant",
      content: "",
      metadata: {
        surfaces: [
          { artifactId: "status", revision: 1 },
          { artifactId: "status", revision: 2 },
        ],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ])[0]?.parts;

  expect(liveParts).toEqual([
    {
      kind: "surface",
      artifactId: "status",
      revision: 1,
      artifact: first,
    },
    {
      kind: "surface",
      artifactId: "status",
      revision: 2,
      artifact: second,
    },
  ]);
  expect(restoredParts).toEqual(
    liveParts?.flatMap((part) =>
      part.kind === "surface"
        ? [{ kind: part.kind, artifactId: part.artifactId, revision: part.revision }]
        : []
    )
  );
});

test("a retry owns its Surface even when a sealed attempt presented the same revision", () => {
  const historical = {
    id: "attempt-1",
    role: "assistant" as const,
    parts: [{ kind: "surface" as const, artifactId: "status", revision: 1 }],
    sealed: true,
  };
  let state: ChatState = {
    ...initialChatState,
    messages: [
      historical,
      {
        id: "retry-request",
        role: "user",
        parts: [{ kind: "text", text: "try again" }],
        sealed: true,
      },
    ],
  };

  state = chatReducer(state, {
    type: "surface",
    data: { artifactId: "status", revision: 1 },
  });
  state = chatReducer(state, {
    type: "surface",
    data: { artifactId: "status", revision: 1 },
  });

  expect(state.messages[0]).toBe(historical);
  expect(state.messages[0]?.parts).toEqual([
    { kind: "surface", artifactId: "status", revision: 1 },
  ]);
  expect(state.messages.at(-1)?.parts).toEqual([
    { kind: "surface", artifactId: "status", revision: 1 },
  ]);
});

describe("terminal Tool closure", () => {
  function runningToolState(): ChatState {
    return chatReducer(initialChatState, {
      type: "tool-call",
      data: { toolCallId: "call-1", toolName: "record_create", args: {} },
    });
  }

  test("marks an outcome-less Tool interrupted when the server closes the Turn", () => {
    const state = chatReducer(runningToolState(), {
      type: "finish",
      data: { reason: "cancelled" },
    });

    expect(state.messages[0]).toMatchObject({
      sealed: true,
      parts: [{ kind: "tool", toolCallId: "call-1", status: "interrupted" }],
    });
  });

  test("preserves a Tool result when the server closes the Turn", () => {
    let state = runningToolState();
    state = chatReducer(state, {
      type: "tool-result",
      data: {
        toolCallId: "call-1",
        toolName: "record_create",
        result: { status: "ok" },
      },
    });
    state = chatReducer(state, { type: "finish", data: { reason: "stop" } });

    expect(state.messages[0]?.parts).toEqual([
      expect.objectContaining({
        kind: "tool",
        toolCallId: "call-1",
        status: "done",
        result: { status: "ok" },
      }),
    ]);
  });

  test("preserves a known Tool error when the server closes the Turn", () => {
    let state = runningToolState();
    state = chatReducer(state, {
      type: "tool-result",
      data: {
        toolCallId: "call-1",
        toolName: "record_create",
        result: { status: "error" },
        meta: { errorCode: "write_failed" },
      },
    });
    state = chatReducer(state, { type: "finish", data: { reason: "stop" } });

    expect(state.messages[0]?.parts).toEqual([
      expect.objectContaining({
        kind: "tool",
        toolCallId: "call-1",
        status: "done",
        outcome: "error",
      }),
    ]);
  });

  test("interrupts only the active attempt on a terminal server error", () => {
    const historical = {
      id: "attempt-1",
      role: "assistant" as const,
      parts: [
        {
          kind: "tool" as const,
          toolCallId: "old-call",
          toolName: "record_get",
          args: {},
          status: "running" as const,
        },
      ],
      sealed: true,
    };
    const active = runningToolState().messages[0];
    if (active === undefined) throw new Error("active assistant missing");
    const state = chatReducer(
      { ...initialChatState, messages: [historical, active] },
      {
        type: "error",
        data: { message: "The turn stopped.", terminal: true },
      }
    );

    expect(state.messages[0]).toBe(historical);
    expect(state.messages[0]?.parts[0]).toMatchObject({ status: "running" });
    expect(state.messages[1]).toMatchObject({
      sealed: true,
      parts: [{ kind: "tool", toolCallId: "call-1", status: "interrupted" }],
    });
  });

  test("leaves a Tool running after a transient reconnect error", () => {
    const state = chatReducer(runningToolState(), {
      type: "error",
      data: { message: "network connection lost" },
    });

    expect(state.messages[0]).toMatchObject({
      sealed: false,
      parts: [{ kind: "tool", toolCallId: "call-1", status: "running" }],
    });
  });
});

describe("rewindLastTurn", () => {
  test("removes the trailing user and assistant messages", () => {
    let state = appendUserMessage(initialChatState, "hello");
    state = chatReducer(state, { type: "text", data: { delta: "hi" } });
    expect(rewindLastTurn(state).messages).toEqual([]);
  });
});

describe("a declared plan", () => {
  const rounds = [{ calls: [{ tool: "get_memory" }] }, { calls: [{ tool: "routine_forge" }] }];

  test("heads the work it describes, even though it arrives after that work started", () => {
    // `plan_declare` rides in the same dispatch as the first Round, so its result lands after
    // those calls were announced. A plan printed below the steps it forecasts is not a plan.
    let state = chatReducer(initialChatState, {
      type: "tool-call",
      data: { toolCallId: "c1", toolName: "get_memory", args: {} },
    });
    state = chatReducer(state, { type: "plan", data: { revision: 1, rounds } });

    expect(state.messages[0]?.parts.map((part) => part.kind)).toEqual(["plan", "tool"]);
  });

  test("never leaps above prose the reader has already read", () => {
    // A revision declared after the Agent has said something in the transcript must sit with the
    // Round it forecasts, not jump to the top of a Message whose opening the reader has read.
    let state = chatReducer(initialChatState, {
      type: "text",
      data: { delta: "Here is the plan." },
    });
    state = chatReducer(state, {
      type: "tool-call",
      data: { toolCallId: "c1", toolName: "get_memory", args: {} },
    });
    state = chatReducer(state, { type: "plan", data: { revision: 1, rounds } });

    expect(state.messages[0]?.parts.map((part) => part.kind)).toEqual(["text", "plan", "tool"]);
  });

  test("is replaced in place by a revision rather than stacked beneath it", () => {
    const revised = [...rounds, { calls: [{ tool: "update_memory" }] }];
    let state = chatReducer(initialChatState, { type: "plan", data: { revision: 1, rounds } });
    state = chatReducer(state, {
      type: "tool-call",
      data: { toolCallId: "c1", toolName: "get_memory", args: {} },
    });
    state = chatReducer(state, { type: "plan", data: { revision: 2, rounds: revised } });

    expect(state.messages[0]?.parts).toEqual([
      { kind: "plan", revision: 2, rounds: revised },
      expect.objectContaining({ kind: "tool" }),
    ]);
  });
});
