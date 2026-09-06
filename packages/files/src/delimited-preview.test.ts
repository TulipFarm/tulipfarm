import { describe, expect, it } from "vitest";
import { isDelimitedPreviewable, parseDelimited, previewDelimited } from "./delimited-preview.js";
import { MAX_PREVIEW_COLUMNS, MAX_PREVIEW_ROWS } from "./office-preview.js";

describe("isDelimitedPreviewable", () => {
  it("claims the separated-value types and nothing else", () => {
    expect(isDelimitedPreviewable("text/csv")).toBe(true);
    expect(isDelimitedPreviewable("text/tab-separated-values")).toBe(true);
    expect(isDelimitedPreviewable("text/plain")).toBe(false);
    expect(isDelimitedPreviewable("application/json")).toBe(false);
  });
});

describe("parseDelimited", () => {
  it("reads plain rows", () => {
    expect(parseDelimited("a,b\n1,2", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps a quoted separator inside its cell", () => {
    expect(parseDelimited('name,note\n"Vijayvargiya, Muskan",hi', ",")).toEqual([
      ["name", "note"],
      ["Vijayvargiya, Muskan", "hi"],
    ]);
  });

  it("keeps a quoted newline inside its cell rather than starting a row", () => {
    expect(parseDelimited('a,b\n"one\ntwo",3', ",")).toEqual([
      ["a", "b"],
      ["one\ntwo", "3"],
    ]);
  });

  it("reads a doubled quote as one literal quote", () => {
    expect(parseDelimited('a\n"she said ""go"""', ",")).toEqual([["a"], ['she said "go"']]);
  });

  it("treats CRLF as a row break and leaves no carriage return behind", () => {
    expect(parseDelimited("a,b\r\n1,2\r\n", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps empty cells so columns stay aligned", () => {
    expect(parseDelimited("a,b,c\n1,,3", ",")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
    ]);
  });

  it("drops a trailing blank line rather than emitting an empty row", () => {
    expect(parseDelimited("a,b\n1,2\n", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("splits on tabs when asked", () => {
    expect(parseDelimited("a\tb\n1\t2", "\t")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("stops at the row limit so a huge file cannot hang the tab", () => {
    const rows = Array.from({ length: MAX_PREVIEW_ROWS + 50 }, (_, i) => `${i},x`).join("\n");
    expect(parseDelimited(rows, ",")).toHaveLength(MAX_PREVIEW_ROWS);
  });

  it("stops at the column limit", () => {
    const wide = Array.from({ length: MAX_PREVIEW_COLUMNS + 20 }, (_, i) => `c${i}`).join(",");
    expect(parseDelimited(wide, ",")[0]).toHaveLength(MAX_PREVIEW_COLUMNS);
  });
});

describe("previewDelimited", () => {
  it("renders a CSV as one grid rather than as lines of text", () => {
    expect(previewDelimited("a,b\n1,2", "text/csv")).toEqual([
      {
        kind: "table",
        rows: [
          ["a", "b"],
          ["1", "2"],
        ],
      },
    ]);
  });

  it("pads short rows so every row reaches the widest one", () => {
    const [block] = previewDelimited("a,b,c\n1", "text/csv");
    expect(block).toEqual({
      kind: "table",
      rows: [
        ["a", "b", "c"],
        ["1", "", ""],
      ],
    });
  });

  it("returns nothing for an empty file", () => {
    expect(previewDelimited("   \n", "text/csv")).toEqual([]);
  });

  it("splits a .tsv on tabs", () => {
    expect(previewDelimited("a\tb\n1\t2", "text/tab-separated-values")).toEqual([
      {
        kind: "table",
        rows: [
          ["a", "b"],
          ["1", "2"],
        ],
      },
    ]);
  });
});
