import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { PgKnowledgeChunkRepo } from "./chunks-repo";
import { PgKnowledgeDocumentRepo } from "./repo";
import type { ChunkInput, KnowledgeDocument } from "./types";

function doc(over: Partial<KnowledgeDocument> = {}): KnowledgeDocument {
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
  return { chunkIndex: 0, content: "hello", embedding: null, model: null, dim: null, ...over };
}

describe("PgKnowledgeChunkRepo", () => {
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

  it("inserts chunks with and without embeddings, then delete-by-document clears them", async () => {
    const d = doc();
    await docs.insert(d);
    await chunks.insertMany(d._id, [
      chunk({ chunkIndex: 0, content: "a", embedding: [1, 0, 0], model: "m", dim: 3 }),
      chunk({ chunkIndex: 1, content: "b", embedding: null }),
    ]);
    const { rows } = await db.query("SELECT count(*)::int AS n FROM knowledge_chunks");
    expect((rows[0] as { n: number }).n).toBe(2);

    await chunks.deleteByDocument(d._id);
    const after = await db.query("SELECT count(*)::int AS n FROM knowledge_chunks");
    expect((after.rows[0] as { n: number }).n).toBe(0);
  });

  it("ranks vector search by cosine similarity and filters by dim + active doc", async () => {
    const d = doc();
    await docs.insert(d);
    await chunks.insertMany(d._id, [
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

  it("excludes chunks of inactive documents from search", async () => {
    const d = doc({ active: false });
    await docs.insert(d);
    await chunks.insertMany(d._id, [
      chunk({ content: "secret", embedding: [1, 0, 0], model: "m", dim: 3 }),
    ]);
    expect(await chunks.searchVector([1, 0, 0], 3, 10, {})).toHaveLength(0);
    expect(await chunks.searchLexical("secret", 10, {})).toHaveLength(0);
  });

  it("scopes search to one bundle via the bundleId filter (vector + lexical)", async () => {
    const now = new Date();
    const b1 = randomUUID();
    const b2 = randomUUID();
    for (const [id, name] of [
      [b1, "B1"],
      [b2, "B2"],
    ] as const) {
      await db.query(
        "INSERT INTO knowledge_bundles (id, name, description, created_at, updated_at) VALUES ($1,$2,null,$3,$3)",
        [id, name, now]
      );
    }
    const d1 = doc({ bundleId: b1, path: "p1" });
    const d2 = doc({ bundleId: b2, path: "p2" });
    await docs.insert(d1);
    await docs.insert(d2);
    await chunks.insertMany(d1._id, [
      chunk({ content: "the quick brown fox", embedding: [1, 0, 0], model: "m", dim: 3 }),
    ]);
    await chunks.insertMany(d2._id, [
      chunk({ content: "the quick brown fox", embedding: [1, 0, 0], model: "m", dim: 3 }),
    ]);

    // Unscoped lexical sees both; bundleId narrows to one space.
    expect(await chunks.searchLexical("fox", 10, {})).toHaveLength(2);
    const lex = await chunks.searchLexical("fox", 10, { bundleId: b1 });
    expect(lex).toHaveLength(1);
    expect(lex[0].documentId).toBe(d1._id);

    // The vector path inherits the same predicate.
    const vec = await chunks.searchVector([1, 0, 0], 3, 10, { bundleId: b2 });
    expect(vec).toHaveLength(1);
    expect(vec[0].documentId).toBe(d2._id);
  });

  it("lexical search matches via websearch_to_tsquery and honors domain filter", async () => {
    const d = doc({ domain: "ops" });
    await docs.insert(d);
    const other = doc({ domain: "hr" });
    await docs.insert(other);
    await chunks.insertMany(d._id, [chunk({ content: "the quick brown fox" })]);
    await chunks.insertMany(other._id, [chunk({ content: "the quick brown fox" })]);

    const all = await chunks.searchLexical("fox", 10, {});
    expect(all).toHaveLength(2);

    const ops = await chunks.searchLexical("fox", 10, { domain: "ops" });
    expect(ops).toHaveLength(1);
    expect(ops[0].documentId).toBe(d._id);
  });
});
