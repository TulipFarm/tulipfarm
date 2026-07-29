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
});
