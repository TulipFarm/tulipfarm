import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { EmbeddingUnavailableError } from "@tulipfarm/llm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { PgKnowledgeChunkRepo } from "./chunks-repo";
import { indexPage, reindexAll } from "./index-service";
import { PgKnowledgePageRepo } from "./repo";
import type { EmbeddingPort, KnowledgePage } from "./types";

function fakeEmbeddings(opts: {
  available: boolean;
  dim?: number;
  throwOnEmbed?: boolean;
}): EmbeddingPort {
  const dim = opts.dim ?? 3;
  return {
    isAvailable: () => opts.available,
    embedMany: async (values) => {
      if (opts.throwOnEmbed) throw new EmbeddingUnavailableError();
      return { embeddings: values.map(() => Array(dim).fill(0.1) as number[]), dimension: dim };
    },
    getActive: () =>
      opts.available ? { provider: "fake", model: "fake-model", dimension: dim } : null,
    getDimension: () => (opts.available ? dim : null),
    consumePendingReindex: () => false,
  };
}

function page(plainText: string): KnowledgePage {
  const now = new Date();
  return {
    _id: randomUUID(),
    title: "T",
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

describe("indexPage", () => {
  let db: PGlite;
  let chunks: PgKnowledgeChunkRepo;
  let pages: PgKnowledgePageRepo;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    chunks = new PgKnowledgeChunkRepo(db);
    pages = new PgKnowledgePageRepo(db);
  });
  afterEach(async () => {
    await db.close();
  });

  async function embeddedCount(): Promise<number> {
    const { rows } = await db.query(
      "SELECT count(*)::int AS n FROM knowledge_chunks WHERE embedding IS NOT NULL"
    );
    return (rows[0] as { n: number }).n;
  }

  it("embeds chunks when a provider is available, storing model + dim", async () => {
    const p = page("the quick brown fox jumps over the lazy dog");
    await pages.insert(p);
    const res = await indexPage(p, chunks, fakeEmbeddings({ available: true, dim: 3 }));
    expect(res.embedded).toBe(true);
    expect(res.chunkCount).toBeGreaterThan(0);
    expect(await embeddedCount()).toBe(res.chunkCount);

    const { rows } = await db.query("SELECT model, dim FROM knowledge_chunks LIMIT 1");
    expect((rows[0] as { model: string }).model).toBe("fake-model");
    expect(Number((rows[0] as { dim: number }).dim)).toBe(3);
  });

  it("stores lexical-only chunks (NULL embedding) when no provider", async () => {
    const p = page("hello world content here");
    await pages.insert(p);
    const res = await indexPage(p, chunks, fakeEmbeddings({ available: false }));
    expect(res.embedded).toBe(false);
    expect(res.chunkCount).toBeGreaterThan(0);
    expect(await embeddedCount()).toBe(0);
  });

  it("falls back to lexical-only when embedMany throws EmbeddingUnavailable mid-flight", async () => {
    const p = page("content that should still be chunked");
    await pages.insert(p);
    const res = await indexPage(p, chunks, fakeEmbeddings({ available: true, throwOnEmbed: true }));
    expect(res.embedded).toBe(false);
    expect(await embeddedCount()).toBe(0);
  });

  it("is idempotent — re-indexing replaces chunks rather than duplicating", async () => {
    const p = page("alpha beta gamma delta epsilon");
    await pages.insert(p);
    const first = await indexPage(p, chunks, fakeEmbeddings({ available: true }));
    await indexPage(p, chunks, fakeEmbeddings({ available: true }));
    const { rows } = await db.query("SELECT count(*)::int AS n FROM knowledge_chunks");
    expect((rows[0] as { n: number }).n).toBe(first.chunkCount);
  });

  it("produces no chunks for whitespace-only text", async () => {
    const p = page("   \n  ");
    await pages.insert(p);
    const res = await indexPage(p, chunks, fakeEmbeddings({ available: true }));
    expect(res.chunkCount).toBe(0);
  });

  it("reindexAll re-embeds every active page", async () => {
    const a = page("first page body");
    const b = page("second page body");
    await pages.insert(a);
    await pages.insert(b);
    const n = await reindexAll(pages, chunks, fakeEmbeddings({ available: true }));
    expect(n).toBe(2);
    expect(await embeddedCount()).toBeGreaterThanOrEqual(2);
  });
});
