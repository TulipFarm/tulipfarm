import { describe, expect, it } from "vitest";
import {
  assertValidMessage,
  fromAssistantParts,
  fromAssistantText,
  fromToolResult,
  fromUserText,
  InvalidMessageError,
  type MessageDoc,
  type MessagePart,
  toModelMessage,
} from "./messages";

describe("assertValidMessage — legal cases", () => {
  it("accepts system + string", () => {
    expect(() => assertValidMessage("system", "you are a bot")).not.toThrow();
  });

  it("accepts user + string", () => {
    expect(() => assertValidMessage("user", "hello")).not.toThrow();
  });

  it("accepts assistant + string", () => {
    expect(() => assertValidMessage("assistant", "hi there")).not.toThrow();
  });

  it("accepts assistant + [text part]", () => {
    const content: MessagePart[] = [{ type: "text", text: "thinking" }];
    expect(() => assertValidMessage("assistant", content)).not.toThrow();
  });

  it("accepts assistant + [text, tool-call]", () => {
    const content: MessagePart[] = [
      { type: "text", text: "let me check" },
      { type: "tool-call", toolCallId: "c1", toolName: "search", args: { q: "x" } },
    ];
    expect(() => assertValidMessage("assistant", content)).not.toThrow();
  });

  it("accepts tool + [tool-result]", () => {
    const content: MessagePart[] = [
      { type: "tool-result", toolCallId: "c1", toolName: "search", result: { ok: true } },
    ];
    expect(() => assertValidMessage("tool", content)).not.toThrow();
  });

  it("accepts tool + [tool-result, tool-result]", () => {
    const content: MessagePart[] = [
      { type: "tool-result", toolCallId: "c1", toolName: "search", result: 1 },
      { type: "tool-result", toolCallId: "c2", toolName: "fetch", result: 2 },
    ];
    expect(() => assertValidMessage("tool", content)).not.toThrow();
  });
});

describe("assertValidMessage — illegal cases", () => {
  it("rejects system + [parts]", () => {
    const content: MessagePart[] = [{ type: "text", text: "no" }];
    expect(() => assertValidMessage("system", content)).toThrow(InvalidMessageError);
  });

  it("rejects user + [parts]", () => {
    const content: MessagePart[] = [{ type: "text", text: "no" }];
    expect(() => assertValidMessage("user", content)).toThrow(InvalidMessageError);
  });

  it("rejects assistant + [tool-result]", () => {
    const content: MessagePart[] = [
      { type: "tool-result", toolCallId: "c1", toolName: "search", result: 1 },
    ];
    expect(() => assertValidMessage("assistant", content)).toThrow(InvalidMessageError);
  });

  it("rejects tool + string", () => {
    expect(() => assertValidMessage("tool", "not allowed")).toThrow(InvalidMessageError);
  });

  it("rejects tool + [text]", () => {
    const content: MessagePart[] = [{ type: "text", text: "no" }];
    expect(() => assertValidMessage("tool", content)).toThrow(InvalidMessageError);
  });

  it("rejects tool + [tool-call]", () => {
    const content: MessagePart[] = [
      { type: "tool-call", toolCallId: "c1", toolName: "search", args: {} },
    ];
    expect(() => assertValidMessage("tool", content)).toThrow(InvalidMessageError);
  });

  it("rejects assistant + [] (empty parts array)", () => {
    expect(() => assertValidMessage("assistant", [])).toThrow(InvalidMessageError);
  });

  it("rejects tool + [] (empty parts array)", () => {
    expect(() => assertValidMessage("tool", [])).toThrow(InvalidMessageError);
  });

  it("thrown error is an instance of InvalidMessageError", () => {
    try {
      assertValidMessage("tool", "bad");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidMessageError);
    }
  });
});

describe("toModelMessage", () => {
  const base = { _id: "m1", conversationId: "conv1", createdAt: new Date() };

  it("maps user string → { role, content: string }", () => {
    const doc: MessageDoc = { ...base, role: "user", content: "hi" };
    expect(toModelMessage(doc)).toEqual({ role: "user", content: "hi" });
  });

  it("maps system string → { role, content: string }", () => {
    const doc: MessageDoc = { ...base, role: "system", content: "be nice" };
    expect(toModelMessage(doc)).toEqual({ role: "system", content: "be nice" });
  });

  it("maps assistant string → assistant message", () => {
    const doc: MessageDoc = { ...base, role: "assistant", content: "Hello" };
    expect(toModelMessage(doc)).toEqual({ role: "assistant", content: "Hello" });
  });

  it("maps assistant [text, tool-call] → assistant with matching parts", () => {
    const doc: MessageDoc = {
      ...base,
      role: "assistant",
      content: [
        { type: "text", text: "let me look" },
        { type: "tool-call", toolCallId: "c1", toolName: "search", args: { q: "x" } },
      ],
    };
    expect(toModelMessage(doc)).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "let me look" },
        { type: "tool-call", toolCallId: "c1", toolName: "search", input: { q: "x" } },
      ],
    });
  });

  it("maps tool [tool-result] → tool message with tool-result content", () => {
    const doc: MessageDoc = {
      ...base,
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "c1", toolName: "search", result: { ok: true } },
      ],
    };
    expect(toModelMessage(doc)).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "search",
          output: { type: "json", value: { ok: true } },
        },
      ],
    });
  });
});

describe("fromUserText / fromAssistantText", () => {
  it("fromUserText builds a user MessageDoc", () => {
    const doc = fromUserText("conv1", "hello world");
    expect(doc.role).toBe("user");
    expect(doc.content).toBe("hello world");
    expect(doc.conversationId).toBe("conv1");
    expect(typeof doc._id).toBe("string");
    expect(doc._id.length).toBeGreaterThan(0);
    expect(doc.createdAt).toBeInstanceOf(Date);
  });

  it("fromAssistantText builds an assistant MessageDoc", () => {
    const doc = fromAssistantText("conv2", "the answer");
    expect(doc.role).toBe("assistant");
    expect(doc.content).toBe("the answer");
    expect(doc.conversationId).toBe("conv2");
    expect(typeof doc._id).toBe("string");
    expect(doc._id.length).toBeGreaterThan(0);
    expect(doc.createdAt).toBeInstanceOf(Date);
  });

  it("two calls produce different _ids", () => {
    const a = fromUserText("conv1", "x");
    const b = fromUserText("conv1", "x");
    expect(a._id).not.toBe(b._id);
  });
});

describe("fromAssistantParts / fromToolResult", () => {
  it("fromAssistantParts builds a valid assistant tool-call turn that round-trips", () => {
    const parts: MessagePart[] = [
      { type: "text", text: "saving that" },
      { type: "tool-call", toolCallId: "c1", toolName: "update_memory", args: { key: "plan" } },
    ];
    const doc = fromAssistantParts("conv1", parts);
    expect(doc.role).toBe("assistant");
    expect(doc.content).toEqual(parts);
    expect(() => assertValidMessage(doc.role, doc.content)).not.toThrow();
    expect(toModelMessage(doc)).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "saving that" },
        { type: "tool-call", toolCallId: "c1", toolName: "update_memory", input: { key: "plan" } },
      ],
    });
  });

  it("fromToolResult builds a valid tool turn that round-trips", () => {
    const parts: MessagePart[] = [
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "update_memory",
        result: { success: true },
      },
    ];
    const doc = fromToolResult("conv1", parts);
    expect(doc.role).toBe("tool");
    expect(doc.content).toEqual(parts);
    expect(() => assertValidMessage(doc.role, doc.content)).not.toThrow();
    expect(toModelMessage(doc)).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "update_memory",
          output: { type: "json", value: { success: true } },
        },
      ],
    });
  });
});
