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
