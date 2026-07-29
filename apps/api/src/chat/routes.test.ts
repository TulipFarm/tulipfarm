import { describe, expect, it } from "vitest";
import { buildTurnLog, parseLastEventId } from "./turn-helpers";

describe("Chat route helpers", () => {
  it("prefers the SSE header cursor", () => {
    expect(parseLastEventId("12", 4)).toBe(12);
    expect(parseLastEventId(undefined, 4)).toBe(4);
  });

  it("records a per-Turn model override", () => {
    expect(
      buildTurnLog({
        conversationId: "conversation-1",
        userId: "user-1",
        requestedModel: "quick",
        resolvedModelId: "model-1",
        isNewConversation: true,
      })
    ).toMatchObject({ overrideApplied: true, requestedModel: "quick" });
  });
});
