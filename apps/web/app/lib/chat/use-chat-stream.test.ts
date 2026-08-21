import { describe, expect, it } from "vitest";
import { isChatBusy, seedState, surfaceInteractionAnswer } from "./use-chat-stream";

describe("isChatBusy", () => {
  it("recognizes in-flight states", () => {
    expect(isChatBusy("submitted")).toBe(true);
    expect(isChatBusy("streaming")).toBe(true);
    expect(isChatBusy("idle")).toBe(false);
  });
});

describe("surfaceInteractionAnswer", () => {
  it("uses a selected value to resume a pending request_input Turn", () => {
    expect(surfaceInteractionAnswer({ value: "rollback" })).toBe("rollback");
  });

  it("serializes typed form input into a readable continuation", () => {
    expect(surfaceInteractionAnswer({ owner: "Sam", priority: 2 })).toBe("owner: Sam\npriority: 2");
  });
});

describe("seedState", () => {
  it("keeps a restored Conversation id", () => {
    expect(seedState({ initialConversationId: "conversation" }).conversationId).toBe(
      "conversation"
    );
  });

  it("restores an active Turn as submitted with its Run", () => {
    expect(
      seedState({
        initialConversationId: "conversation",
        initialTurn: { id: "turn-1", runId: "run-1", status: "running" },
      })
    ).toMatchObject({ status: "submitted", runId: "run-1" });
  });

  it("surfaces a Turn that failed before a Run was created", () => {
    expect(
      seedState({
        initialConversationId: "conversation",
        initialTurn: { id: "turn-1", runId: null, status: "start_failed" },
      })
    ).toMatchObject({ status: "error", error: "The response could not be started. Try again." });
  });

  it("does not replay stale active metadata over a persisted assistant reply", () => {
    const state = seedState({
      initialConversationId: "conversation",
      initialMessages: [{ id: "reply", role: "assistant", parts: [], sealed: true }],
      initialTurn: { id: "turn-1", runId: "run-1", status: "running" },
    });

    expect(state.status).toBe("idle");
    expect(state).not.toHaveProperty("runId");
  });
});
