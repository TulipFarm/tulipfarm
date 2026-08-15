import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { EmbeddingPort, KnowledgePage } from "@tulipfarm/knowledge";
import {
  indexPage,
  PgKnowledgeChunkRepo,
  PgKnowledgePageRepo,
  reindexAll,
} from "@tulipfarm/knowledge";
import { EmbeddingUnavailableError } from "@tulipfarm/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";

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

/** Records the size of every embedMany batch so a test can assert how many chunks were embedded. */
function countingEmbeddings(
  model = "fake-model",
  dim = 3
): { port: EmbeddingPort; batches: number[] } {
  const batches: number[] = [];
  const port: EmbeddingPort = {
    isAvailable: () => true,
    embedMany: async (values) => {
      batches.push(values.length);
      return { embeddings: values.map(() => Array(dim).fill(0.1) as number[]), dimension: dim };
    },
    getActive: () => ({ provider: "fake", model, dimension: dim }),
    getDimension: () => dim,
    consumePendingReindex: () => false,
  };
  return { port, batches };
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
    db = await makeMigratedPglite();
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

  it("re-embeds only the changed chunk on re-index (content-hash dedup)", async () => {
    // 2000 chars → 3 windows (step 700): chunk0 [0,800), chunk1 [700,1500), chunk2 [1400,2000).
    const text = "x".repeat(2000);
    const p = page(text);
    await pages.insert(p);
    const e = countingEmbeddings();

    const first = await indexPage(p, chunks, e.port);
    expect(first.chunkCount).toBe(3);
    expect(e.batches).toEqual([3]); // first index embeds all three chunks

    // Edit one char in chunk0's exclusive region (pos < 700) — keeps length so later windows are
    // byte-identical and reusable.
    const editedText = `y${text.slice(1)}`;
    const edited = { ...p, content: editedText, plainText: editedText };
    const second = await indexPage(edited, chunks, e.port);
    expect(second.chunkCount).toBe(3);
    expect(e.batches).toEqual([3, 1]); // only the changed chunk is re-embedded
    expect(await embeddedCount()).toBe(3); // 2 reused + 1 fresh — all rows still embedded
  });

  it("embeds nothing when re-indexing unchanged content under the same model", async () => {
    const p = page("x".repeat(2000));
    await pages.insert(p);
    const e = countingEmbeddings();
    await indexPage(p, chunks, e.port);
    await indexPage(p, chunks, e.port);
    expect(e.batches).toEqual([3]); // second pass reuses every chunk — no new embed call
  });

  it("re-embeds every chunk when the active model changes", async () => {
    const p = page("x".repeat(2000));
    await pages.insert(p);
    const a = countingEmbeddings("model-a");
    await indexPage(p, chunks, a.port);
    const b = countingEmbeddings("model-b");
    await indexPage(p, chunks, b.port); // same content, different model → no reuse
    expect(b.batches).toEqual([3]);
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
