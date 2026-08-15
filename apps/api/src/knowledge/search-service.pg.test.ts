import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { EmbeddingPort, KnowledgePage } from "@tulipfarm/knowledge";
import { indexPage, PgKnowledgeChunkRepo, PgKnowledgePageRepo, search } from "@tulipfarm/knowledge";
import { EMBEDDING_UNAVAILABLE_WARNING } from "@tulipfarm/llm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";

function fakeEmbeddings(available: boolean, dim = 3): EmbeddingPort {
  return {
    isAvailable: () => available,
    embedMany: async (values) => ({
      embeddings: values.map(() => Array(dim).fill(0.5) as number[]),
      dimension: dim,
    }),
    getActive: () => (available ? { provider: "fake", model: "m", dimension: dim } : null),
    getDimension: () => (available ? dim : null),
    pendingReindex: () => false,
    clearPendingReindex: () => {},
  };
}

function page(plainText: string): KnowledgePage {
  const now = new Date();
  return {
    _id: randomUUID(),
    title: "Doc",
    content: plainText,
    plainText,
    source: "authored",
    sourceId: randomUUID(),
    domain: null,
    tags: [],
    active: true,
    alwaysLoadForAgents: false,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

describe("knowledge search", () => {
  let db: PGlite;
  let chunks: PgKnowledgeChunkRepo;
  let pages: PgKnowledgePageRepo;

  beforeEach(async () => {
    db = await makeMigratedPglite();
    chunks = new PgKnowledgeChunkRepo(db);
    pages = new PgKnowledgePageRepo(db);
  });
  afterEach(async () => {
    await db.close();
  });

  it("uses vector search with no warnings when embeddings are available", async () => {
    const p = page("the capital of france is paris");
    await pages.insert(p);
    await indexPage(p, chunks, fakeEmbeddings(true));

    const res = await search("france", {}, 10, {
      embeddings: fakeEmbeddings(true),
      chunksRepo: chunks,
    });
    expect(res.warnings).toEqual([]);
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results[0].title).toBe("Doc");
  });

  it("falls back to lexical with a warning when no embedding provider", async () => {
    const p = page("the capital of france is paris");
    await pages.insert(p);
    // index lexical-only (no provider)
    await indexPage(p, chunks, fakeEmbeddings(false));

    const res = await search("paris", {}, 10, {
      embeddings: fakeEmbeddings(false),
      chunksRepo: chunks,
    });
    expect(res.warnings).toEqual([EMBEDDING_UNAVAILABLE_WARNING]);
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results[0].content).toContain("paris");
  });

  it("returns the warning even when embeddings unavailable but lexical has no hit", async () => {
    const res = await search("nothingmatches", {}, 10, {
      embeddings: fakeEmbeddings(false),
      chunksRepo: chunks,
    });
    expect(res.warnings).toEqual([EMBEDDING_UNAVAILABLE_WARNING]);
    expect(res.results).toEqual([]);
  });

  it("uses lexical WITHOUT a warning when an available provider returns no vector", async () => {
    const p = page("paris is the capital of france");
    await pages.insert(p);
    await indexPage(p, chunks, fakeEmbeddings(true));

    const emptyProvider: EmbeddingPort = {
      isAvailable: () => true,
      embedMany: async () => ({ embeddings: [], dimension: 3 }),
      getActive: () => ({ provider: "f", model: "m", dimension: 3 }),
      getDimension: () => 3,
      pendingReindex: () => false,
      clearPendingReindex: () => {},
    };
    const res = await search("france", {}, 10, { embeddings: emptyProvider, chunksRepo: chunks });
    expect(res.warnings).toEqual([]);
    expect(res.results.length).toBeGreaterThan(0);
  });
});
