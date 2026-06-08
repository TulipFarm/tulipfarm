import { describe, expect, it } from "vitest";
import { chunkText } from "./chunk";

describe("chunkText", () => {
  it("returns no chunks for empty or whitespace-only text", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\t  ")).toEqual([]);
  });

  it("returns a single trimmed chunk when text fits one window", () => {
    expect(chunkText("  hello world  ", { size: 100 })).toEqual([
      { index: 0, content: "hello world" },
    ]);
  });

  it("splits long text into overlapping, sequentially-indexed windows", () => {
    const text = "abcdefghij".repeat(30); // 300 chars
    const chunks = chunkText(text, { size: 100, overlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(100);

    // Consecutive chunks overlap by `overlap` chars (step = size - overlap = 80).
    const c0 = chunks[0].content;
    const c1 = chunks[1].content;
    expect(c1.startsWith(c0.slice(80))).toBe(true);
  });

  it("covers the entire input across chunks", () => {
    const text = "x".repeat(250);
    const chunks = chunkText(text, { size: 100, overlap: 10 });
    // step 90 → starts 0,90,180,240(short). Last chunk reaches the end.
    const last = chunks[chunks.length - 1];
    expect(text.endsWith(last.content)).toBe(true);
  });

  it("never loops forever when overlap >= size (clamped)", () => {
    const chunks = chunkText("a".repeat(50), { size: 10, overlap: 999 });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThan(100);
  });
});
