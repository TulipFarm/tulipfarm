import { describe, expect, it } from "vitest";
import { NotImplementedError } from "./connectors/types";
import { NotImplementedRerank, noopRerank, resolveRerank } from "./rerank";
import type { QueryKnowledgeHit } from "./types";

function hit(over: Partial<QueryKnowledgeHit>): QueryKnowledgeHit {
  return {
    pageId: "p1",
    title: "Page",
    snippet: "body",
    source: "authored",
    origin: "okf",
    score: 1,
    ...over,
  };
}

const pages: QueryKnowledgeHit[] = [
  hit({ pageId: "a", title: "A", score: 0.9 }),
  hit({ pageId: "b", title: "B", score: 0.8 }),
  hit({ pageId: "c", title: "C", score: 0.7 }),
];

describe("noopRerank", () => {
  it("returns the same pages, same order, same length (pure identity)", async () => {
    const out = await noopRerank.rerank("q", pages, 3);
    expect(out).toBe(pages);
    expect(out).toEqual(pages);
    expect(out).toHaveLength(3);
  });

  it("ignores topK and returns the full list even when topK < length", async () => {
    const out = await noopRerank.rerank("q", pages, 1);
    expect(out).toBe(pages);
    expect(out).toHaveLength(3);
  });
});

describe("NotImplementedRerank", () => {
  it("throws a NotImplementedError when invoked", () => {
    const stage = new NotImplementedRerank();
    // `rerank` throws synchronously inside the async-typed method, so the sync assertion is the
    // honest match. (The async path is covered below for the RerankStage contract.)
    expect(() => stage.rerank("q", pages, 3)).toThrow(NotImplementedError);
  });

  it("rejects with a NotImplementedError via the async contract", async () => {
    const stage = new NotImplementedRerank();
    await expect(async () => stage.rerank("q", pages, 3)).rejects.toThrow(NotImplementedError);
  });
});

describe("resolveRerank", () => {
  it("returns noopRerank when the flag is unset", () => {
    expect(resolveRerank({})).toBe(noopRerank);
  });

  it.each(["1", "true", "on"])("returns NotImplementedRerank when KNOWLEDGE_RERANK=%s", (v) => {
    expect(resolveRerank({ KNOWLEDGE_RERANK: v })).toBeInstanceOf(NotImplementedRerank);
  });

  it.each(["off", "0"])("returns noopRerank when KNOWLEDGE_RERANK=%s", (v) => {
    expect(resolveRerank({ KNOWLEDGE_RERANK: v })).toBe(noopRerank);
  });
});
