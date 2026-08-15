import { createHash, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Queryable } from "../db";
import { makeMigratedPglite } from "../test/pglite";
import { PgKnowledgeChunkRepo } from "./chunks-repo";
import { indexPage } from "./index-service";
import { PgKnowledgePageRepo } from "./repo";
import type { ChunkInput, EmbeddingPort, KnowledgePage } from "./types";

function page(over: Partial<KnowledgePage> = {}): KnowledgePage {
  const now = new Date();
  return {
    _id: randomUUID(),
    title: "Doc",
    content: "x",
    plainText: "x",
    source: "authored",
    sourceId: randomUUID(),
    domain: null,
    tags: [],
    active: true,
    alwaysLoadForAgents: false,
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function chunk(over: Partial<ChunkInput> = {}): ChunkInput {
  const content = over.content ?? "hello";
  return {
    chunkIndex: 0,
    content,
    contentHash: createHash("md5").update(content).digest("hex"),
    embedding: null,
    model: null,
    dim: null,
    ...over,
  };
}

function unavailableEmbeddings(): EmbeddingPort {
  return {
    isAvailable: () => false,
    embedMany: async () => ({ embeddings: [], dimension: 0 }),
    getActive: () => null,
    getDimension: () => null,
    consumePendingReindex: () => false,
  };
}

class FailSecondChunkInsert implements Queryable {
  private insertCount = 0;

  constructor(private readonly db: PGlite) {}

  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    return this.queryWith(this.db, text, params);
  }

  transaction<T>(callback: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) =>
      callback({
        query: (text, params) => this.queryWith(tx, text, params),
      })
    );
  }

  private queryWith(
    q: Queryable,
    text: string,
    params?: unknown[]
  ): Promise<{ rows: Record<string, unknown>[] }> {
    if (text.includes("INSERT INTO knowledge_chunks")) {
      this.insertCount += 1;
      if (this.insertCount === 2) throw new Error("injected chunk insert failure");
    }
    return q.query(text, params);
  }
}

describe("PgKnowledgeChunkRepo", () => {
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

  it("inserts chunks with and without embeddings, then delete-by-page clears them", async () => {
    const p = page();
    await pages.insert(p);
    await chunks.insertMany(p._id, [
      chunk({ chunkIndex: 0, content: "a", embedding: [1, 0, 0], model: "m", dim: 3 }),
      chunk({ chunkIndex: 1, content: "b", embedding: null }),
    ]);
    const { rows } = await db.query("SELECT count(*)::int AS n FROM knowledge_chunks");
    expect((rows[0] as { n: number }).n).toBe(2);

    await chunks.deleteByPage(p._id);
    const after = await db.query("SELECT count(*)::int AS n FROM knowledge_chunks");
    expect((after.rows[0] as { n: number }).n).toBe(0);
  });

  it("keeps the previous complete index when replacement insertion fails", async () => {
    const p = page({ content: "x".repeat(1_000), plainText: "x".repeat(1_000) });
    await pages.insert(p);
    await chunks.insertMany(p._id, [chunk({ content: "old index" })]);

    const failingChunks = new PgKnowledgeChunkRepo(new FailSecondChunkInsert(db));
    await expect(indexPage(p, failingChunks, unavailableEmbeddings())).rejects.toThrow(
      "injected chunk insert failure"
    );

    const { rows } = await db.query(
      "SELECT content FROM knowledge_chunks WHERE page_id = $1 ORDER BY chunk_index",
      [p._id]
    );
    expect(rows.map((row) => (row as { content: string }).content)).toEqual(["old index"]);
  });

  it("ranks vector search by cosine similarity and filters by dim + active page", async () => {
    const p = page();
    await pages.insert(p);
    await chunks.insertMany(p._id, [
      chunk({ chunkIndex: 0, content: "near", embedding: [1, 0, 0], model: "m", dim: 3 }),
      chunk({ chunkIndex: 1, content: "far", embedding: [0, 1, 0], model: "m", dim: 3 }),
    ]);

    const hits = await chunks.searchVector([1, 0, 0], 3, 10, {});
    expect(hits.map((h) => h.content)).toEqual(["near", "far"]);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(hits[0].title).toBe("Doc");

    // dim mismatch → no hits
    expect(await chunks.searchVector([1, 0, 0], 999, 10, {})).toHaveLength(0);
  });

  it("excludes chunks of inactive pages from search", async () => {
    const p = page({ active: false });
    await pages.insert(p);
    await chunks.insertMany(p._id, [
      chunk({ content: "secret", embedding: [1, 0, 0], model: "m", dim: 3 }),
    ]);
    expect(await chunks.searchVector([1, 0, 0], 3, 10, {})).toHaveLength(0);
    expect(await chunks.searchLexical("secret", 10, {})).toHaveLength(0);
  });

  it("scopes search to one space via the spaceId filter (vector + lexical)", async () => {
    const now = new Date();
    const b1 = randomUUID();
    const b2 = randomUUID();
    for (const [id, name] of [
      [b1, "B1"],
      [b2, "B2"],
    ] as const) {
      await db.query(
        "INSERT INTO knowledge_spaces (id, name, description, created_at, updated_at) VALUES ($1,$2,null,$3,$3)",
        [id, name, now]
      );
    }
    const d1 = page({ spaceId: b1, path: "p1" });
    const d2 = page({ spaceId: b2, path: "p2" });
    await pages.insert(d1);
    await pages.insert(d2);
    await chunks.insertMany(d1._id, [
      chunk({ content: "the quick brown fox", embedding: [1, 0, 0], model: "m", dim: 3 }),
    ]);
    await chunks.insertMany(d2._id, [
      chunk({ content: "the quick brown fox", embedding: [1, 0, 0], model: "m", dim: 3 }),
    ]);

    // Unscoped lexical sees both; spaceId narrows to one space.
    expect(await chunks.searchLexical("fox", 10, {})).toHaveLength(2);
    const lex = await chunks.searchLexical("fox", 10, { spaceId: b1 });
    expect(lex).toHaveLength(1);
    expect(lex[0].pageId).toBe(d1._id);

    // The vector path inherits the same predicate.
    const vec = await chunks.searchVector([1, 0, 0], 3, 10, { spaceId: b2 });
    expect(vec).toHaveLength(1);
    expect(vec[0].pageId).toBe(d2._id);
  });

  it("lexical search matches via websearch_to_tsquery and honors domain filter", async () => {
    const p = page({ domain: "ops" });
    await pages.insert(p);
    const other = page({ domain: "hr" });
    await pages.insert(other);
    await chunks.insertMany(p._id, [chunk({ content: "the quick brown fox" })]);
    await chunks.insertMany(other._id, [chunk({ content: "the quick brown fox" })]);

    const all = await chunks.searchLexical("fox", 10, {});
    expect(all).toHaveLength(2);

    const ops = await chunks.searchLexical("fox", 10, { domain: "ops" });
    expect(ops).toHaveLength(1);
    expect(ops[0].pageId).toBe(p._id);
  });
});
