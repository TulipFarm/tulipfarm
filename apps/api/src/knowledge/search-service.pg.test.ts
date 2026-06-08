import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { EMBEDDING_UNAVAILABLE_WARNING } from "@tulipfarm/llm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { PgKnowledgeChunkRepo } from "./chunks-repo";
import { indexDocument } from "./index-service";
import { PgKnowledgeDocumentRepo } from "./repo";
import { search } from "./search-service";
import type { EmbeddingPort, KnowledgeDocument } from "./types";

function fakeEmbeddings(available: boolean, dim = 3): EmbeddingPort {
  return {
    isAvailable: () => available,
    embedMany: async (values) => ({
      embeddings: values.map(() => Array(dim).fill(0.5) as number[]),
      dimension: dim,
    }),
    getActive: () => (available ? { provider: "fake", model: "m", dimension: dim } : null),
    getDimension: () => (available ? dim : null),
    consumePendingReindex: () => false,
  };
}

function doc(plainText: string): KnowledgeDocument {
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
  let docs: PgKnowledgeDocumentRepo;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    chunks = new PgKnowledgeChunkRepo(db);
    docs = new PgKnowledgeDocumentRepo(db);
  });
  afterEach(async () => {
    await db.close();
  });

  it("uses vector search with no warnings when embeddings are available", async () => {
    const d = doc("the capital of france is paris");
    await docs.insert(d);
    await indexDocument(d, chunks, fakeEmbeddings(true));

    const res = await search("france", {}, 10, {
      embeddings: fakeEmbeddings(true),
      chunksRepo: chunks,
    });
    expect(res.warnings).toEqual([]);
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results[0].title).toBe("Doc");
  });

  it("falls back to lexical with a warning when no embedding provider", async () => {
    const d = doc("the capital of france is paris");
    await docs.insert(d);
    // index lexical-only (no provider)
    await indexDocument(d, chunks, fakeEmbeddings(false));

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
    const d = doc("paris is the capital of france");
    await docs.insert(d);
    await indexDocument(d, chunks, fakeEmbeddings(true));

    const emptyProvider: EmbeddingPort = {
      isAvailable: () => true,
      embedMany: async () => ({ embeddings: [], dimension: 3 }),
      getActive: () => ({ provider: "f", model: "m", dimension: 3 }),
      getDimension: () => 3,
      consumePendingReindex: () => false,
    };
    const res = await search("france", {}, 10, { embeddings: emptyProvider, chunksRepo: chunks });
    expect(res.warnings).toEqual([]);
    expect(res.results.length).toBeGreaterThan(0);
  });
});
