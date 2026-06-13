import { describe, expect, it } from "vitest";
import { messagesToTimeline } from "~/lib/chat/hydrate";
import type { ConversationMessage } from "~/lib/conversations";

function msg(
  over: Partial<ConversationMessage> & Pick<ConversationMessage, "role" | "content">
): ConversationMessage {
  return { _id: crypto.randomUUID(), conversationId: "c1", createdAt: "t", ...over };
}

describe("messagesToTimeline", () => {
  it("maps user + assistant string turns to sealed text messages", () => {
    const out = messagesToTimeline([
      msg({ role: "user", content: "hello" }),
      msg({ role: "assistant", content: "hi there" }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      role: "user",
      sealed: true,
      parts: [{ kind: "text", text: "hello" }],
    });
    expect(out[1]).toMatchObject({
      role: "assistant",
      sealed: true,
      parts: [{ kind: "text", text: "hi there" }],
    });
  });

  it("pairs an assistant tool-call with the following tool-result", () => {
    const out = messagesToTimeline([
      msg({
        role: "assistant",
        content: [
          { type: "text", text: "looking it up" },
          { type: "tool-call", toolCallId: "tc1", toolName: "search", args: { q: "x" } },
        ],
      }),
      msg({
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "tc1", toolName: "search", result: { hits: 2 } },
        ],
      }),
    ]);
    expect(out).toHaveLength(1);
    const toolPart = out[0].parts.find((p) => p.kind === "tool");
    expect(toolPart).toMatchObject({
      kind: "tool",
      toolCallId: "tc1",
      status: "done",
      result: { hits: 2 },
    });
  });

  it("drops system and summary rows", () => {
    const out = messagesToTimeline([
      msg({ role: "system", content: "you are..." }),
      msg({ role: "summary", content: "earlier recap" }),
      msg({ role: "user", content: "go" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("user");
  });

  it("returns an empty timeline for no messages", () => {
    expect(messagesToTimeline([])).toEqual([]);
  });
});
