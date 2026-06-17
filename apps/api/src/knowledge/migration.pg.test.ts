import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";

async function seedDoc(
  db: PGlite,
  id: string = randomUUID(),
  sourceId: string = randomUUID()
): Promise<string> {
  await db.query(
    `INSERT INTO knowledge_documents
       (id, title, content, plain_text, source, source_id, created_at, updated_at)
     VALUES ($1, 'T', 'c', 'c', 'authored', $2, now(), now())`,
    [id, sourceId]
  );
  return id;
}

async function seedChunk(
  db: PGlite,
  documentId: string,
  content: string,
  embedding: string | null
): Promise<void> {
  await db.query(
    `INSERT INTO knowledge_chunks (id, document_id, chunk_index, content, embedding, tsv, model, dim, created_at)
     VALUES ($1, $2, 0, $3, ${embedding === null ? "NULL" : "$4::vector"}, to_tsvector('english', $3),
             'm', 3, now())`,
    embedding === null
      ? [randomUUID(), documentId, content]
      : [randomUUID(), documentId, content, embedding]
  );
}

describe("002_knowledge migration on PGlite", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("bumps schema_version to the latest (9)", async () => {
    const { rows } = await db.query("SELECT version FROM schema_version WHERE id = true");
    expect(Number((rows[0] as { version: number }).version)).toBe(9);
  });

  it("creates all five knowledge tables", async () => {
    for (const t of [
      "knowledge_documents",
      "knowledge_chunks",
      "knowledge_collections",
      "knowledge_documents_collections",
      "knowledge_revisions",
    ]) {
      const { rows } = await db.query("SELECT to_regclass($1) AS t", [t]);
      expect((rows[0] as { t: string | null }).t).not.toBeNull();
    }
  });

  it("stores a nullable vector + tsvector and ranks by cosine exact-scan", async () => {
    const docId = await seedDoc(db);
    await seedChunk(db, docId, "alpha", "[1,0,0]");
    await seedChunk(db, docId, "beta", "[0.2,0.9,0]");

    const { rows } = await db.query(
      `SELECT content, (embedding <=> $1::vector) AS dist
       FROM knowledge_chunks WHERE embedding IS NOT NULL ORDER BY embedding <=> $1::vector`,
      ["[1,0,0]"]
    );
    expect(rows.map((r) => (r as { content: string }).content)).toEqual(["alpha", "beta"]);
    expect(Number((rows[0] as { dist: number }).dist)).toBeLessThan(
      Number((rows[1] as { dist: number }).dist)
    );
  });

  it("supports NULL embedding (lexical-only) rows + websearch_to_tsquery on the GIN tsv", async () => {
    const docId = await seedDoc(db);
    await seedChunk(db, docId, "the quick brown fox jumps", null);

    const { rows } = await db.query(
      `SELECT content FROM knowledge_chunks
       WHERE tsv @@ websearch_to_tsquery('english', $1)`,
      ["fox"]
    );
    expect(rows).toHaveLength(1);
    expect((rows[0] as { content: string }).content).toContain("fox");
  });

  it("enforces UNIQUE(source, source_id) on documents", async () => {
    await seedDoc(db, randomUUID(), "dup");
    await expect(seedDoc(db, randomUUID(), "dup")).rejects.toThrow();
  });

  it("cascade-deletes chunks when a document is removed", async () => {
    const docId = await seedDoc(db);
    await seedChunk(db, docId, "x", "[1,0,0]");
    await db.query("DELETE FROM knowledge_documents WHERE id = $1", [docId]);
    const { rows } = await db.query("SELECT count(*)::int AS n FROM knowledge_chunks");
    expect((rows[0] as { n: number }).n).toBe(0);
  });
});
