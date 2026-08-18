import { describe, expect, it } from "vitest";
import {
  collapseToText,
  contentFiles,
  contentText,
  type MessageContent,
  normalizeMessageContent,
  textContent,
} from "./message-content";

describe("textContent / contentText", () => {
  it("round-trips a plain string unchanged", () => {
    expect(contentText(textContent("analyse this"))).toBe("analyse this");
  });

  it("round-trips a string that is empty or only whitespace", () => {
    expect(contentText(textContent(""))).toBe("");
    expect(contentText(textContent("  \n "))).toBe("  \n ");
  });

  it("omits file parts, so a placeholder is never mistaken for the bytes", () => {
    const content: MessageContent = [
      { type: "text", text: "what is in this?" },
      { type: "file", fileId: "f1", mediaType: "application/pdf", name: "q3.pdf" },
    ];

    expect(contentText(content)).toBe("what is in this?");
  });
});

describe("contentFiles", () => {
  it("returns file parts in order", () => {
    const content: MessageContent = [
      { type: "file", fileId: "f1", mediaType: "image/png", name: "a.png" },
      { type: "text", text: "and" },
      { type: "file", fileId: "f2", mediaType: "image/png", name: "b.png" },
    ];

    expect(contentFiles(content).map((part) => part.fileId)).toEqual(["f1", "f2"]);
  });
});

describe("normalizeMessageContent", () => {
  it("reads a legacy string row as a single text part", () => {
    expect(normalizeMessageContent("hello")).toEqual([{ type: "text", text: "hello" }]);
  });

  it("reads a part array back unchanged", () => {
    const content = [
      { type: "text", text: "hi" },
      { type: "file", fileId: "f1", mediaType: "image/png", name: "a.png" },
    ];

    expect(normalizeMessageContent(content)).toEqual(content);
  });

  it("drops parts it does not recognise rather than failing the whole message", () => {
    expect(
      normalizeMessageContent([{ type: "text", text: "kept" }, { type: "wat" }, null, 7])
    ).toEqual([{ type: "text", text: "kept" }]);
  });

  it("normalises a shape it cannot read at all to empty content", () => {
    expect(normalizeMessageContent(null)).toEqual([]);
    expect(normalizeMessageContent(42)).toEqual([]);
  });
});

describe("collapseToText", () => {
  it("projects a text-only array back to the bare string a pre-parts reader expects", () => {
    expect(collapseToText([{ type: "text", text: "analyse this" }])).toBe("analyse this");
  });

  it("joins several text parts the way contentText does", () => {
    expect(
      collapseToText([
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ])
    ).toBe("one\ntwo");
  });

  it("refuses to collapse content carrying a File, because a string cannot hold it", () => {
    expect(
      collapseToText([
        { type: "text", text: "analyse this" },
        { type: "file", fileId: "f1", mediaType: "image/png" },
      ])
    ).toBeNull();
  });

  it("refuses to collapse parts it does not recognise, rather than dropping them", () => {
    expect(collapseToText([{ type: "tool-call", toolCallId: "c1" }])).toBeNull();
  });

  it("refuses to collapse empty content, so the caller keeps the row it read", () => {
    expect(collapseToText([])).toBeNull();
  });
});
