import { createSurfaceArtifact } from "@tulipfarm/surface";
import { describe, expect, test } from "vitest";
import { appendUserMessage, chatReducer, initialChatState, rewindLastTurn } from "./reducer";

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

test("Surface revisions replace the matching Artifact in place", () => {
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
    data: { artifactId: second.id, artifact: second },
  });
  expect(state.messages[0]?.parts).toEqual([
    {
      kind: "surface",
      artifactId: "status",
      revision: 2,
      artifact: second,
    },
  ]);
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
