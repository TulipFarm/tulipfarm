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

  it("bumps schema_version to the latest (17)", async () => {
    const { rows } = await db.query("SELECT version FROM schema_version WHERE id = true");
    expect(Number((rows[0] as { version: number }).version)).toBe(17);
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

  // --- OKF bundles (011) ---

  async function seedBundle(id: string = randomUUID(), name: string = `b-${id}`): Promise<string> {
    await db.query(
      "INSERT INTO knowledge_bundles (id, name, created_at, updated_at) VALUES ($1, $2, now(), now())",
      [id, name]
    );
    return id;
  }

  it("creates the three OKF tables (011)", async () => {
    for (const t of ["knowledge_bundles", "knowledge_links", "knowledge_bundle_overrides"]) {
      const { rows } = await db.query("SELECT to_regclass($1) AS t", [t]);
      expect((rows[0] as { t: string | null }).t).not.toBeNull();
    }
  });

  it("adds the OKF columns to knowledge_documents (011; okf_type later dropped by 014)", async () => {
    const { rows } = await db.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'knowledge_documents'
         AND column_name IN ('bundle_id', 'path', 'okf_type', 'resource', 'frontmatter_extra')
       ORDER BY column_name`
    );
    expect((rows as { column_name: string }[]).map((r) => r.column_name)).toEqual([
      "bundle_id",
      "frontmatter_extra",
      "path",
      "resource",
    ]);
  });

  it("enforces partial unique (bundle_id, path) but allows NULL-bundle legacy duplicates", async () => {
    const bundleId = await seedBundle();
    const mkConcept = (path: string) =>
      db.query(
        `INSERT INTO knowledge_documents
           (id, title, content, plain_text, source, source_id, bundle_id, path, created_at, updated_at)
         VALUES ($1, 'T', 'c', 'c', 'authored', $2, $3, $4, now(), now())`,
        [randomUUID(), randomUUID(), bundleId, path]
      );
    await mkConcept("tables/orders");
    await expect(mkConcept("tables/orders")).rejects.toThrow();
    // Legacy docs (NULL bundle_id/path) are unaffected by the partial index.
    await expect(seedDoc(db)).resolves.toBeDefined();
    await expect(seedDoc(db)).resolves.toBeDefined();
  });

  it("tolerates broken links (target_id NULL) and cascades links with their source (011)", async () => {
    const bundleId = await seedBundle();
    const srcId = randomUUID();
    await db.query(
      `INSERT INTO knowledge_documents
         (id, title, content, plain_text, source, source_id, bundle_id, path, created_at, updated_at)
       VALUES ($1, 'T', 'c', 'c', 'authored', $2, $3, 'a', now(), now())`,
      [srcId, randomUUID(), bundleId]
    );
    await db.query(
      `INSERT INTO knowledge_links (id, bundle_id, source_id, target_path, target_id, created_at)
       VALUES ($1, $2, $3, 'not/yet/imported', NULL, now())`,
      [randomUUID(), bundleId, srcId]
    );
    let n = await db.query("SELECT count(*)::int AS n FROM knowledge_links");
    expect((n.rows[0] as { n: number }).n).toBe(1);
    await db.query("DELETE FROM knowledge_documents WHERE id = $1", [srcId]);
    n = await db.query("SELECT count(*)::int AS n FROM knowledge_links");
    expect((n.rows[0] as { n: number }).n).toBe(0);
  });

  it("enforces the bundle_overrides file CHECK (index.md|log.md only) (011)", async () => {
    const bundleId = await seedBundle();
    await expect(
      db.query(
        `INSERT INTO knowledge_bundle_overrides (bundle_id, dir_path, file, content, updated_at)
         VALUES ($1, '', 'readme.md', 'x', now())`,
        [bundleId]
      )
    ).rejects.toThrow();
    await expect(
      db.query(
        `INSERT INTO knowledge_bundle_overrides (bundle_id, dir_path, file, content, updated_at)
         VALUES ($1, '', 'index.md', 'x', now())`,
        [bundleId]
      )
    ).resolves.toBeDefined();
  });

  // --- OKF cross-space links (012) ---

  it("adds target_bundle_id + target_bundle_name to knowledge_links (012)", async () => {
    const { rows } = await db.query(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_name = 'knowledge_links'
         AND column_name IN ('target_bundle_id', 'target_bundle_name')
       ORDER BY column_name`
    );
    expect(rows as { column_name: string; is_nullable: string }[]).toEqual([
      { column_name: "target_bundle_id", is_nullable: "YES" },
      { column_name: "target_bundle_name", is_nullable: "YES" },
    ]);
  });

  it("allows same (source, path) into two different target bundles but dedupes same-space (012)", async () => {
    const srcBundle = await seedBundle();
    const srcId = randomUUID();
    await db.query(
      `INSERT INTO knowledge_documents
         (id, title, content, plain_text, source, source_id, bundle_id, path, created_at, updated_at)
       VALUES ($1, 'T', 'c', 'c', 'authored', $2, $3, 'a', now(), now())`,
      [srcId, randomUUID(), srcBundle]
    );
    const link = (targetBundleName: string | null) =>
      db.query(
        `INSERT INTO knowledge_links
           (id, bundle_id, source_id, target_path, target_id, target_bundle_id, target_bundle_name, created_at)
         VALUES ($1, $2, $3, 'shared/path', NULL, NULL, $4, now())`,
        [randomUUID(), srcBundle, srcId, targetBundleName]
      );
    // Two cross-space links to the SAME path but DIFFERENT bundle names both insert.
    await expect(link("Engineering")).resolves.toBeDefined();
    await expect(link("Sales")).resolves.toBeDefined();
    // A same-space link (NULL bundle name) collides with another same-space link to the same path.
    await expect(link(null)).resolves.toBeDefined();
    await expect(link(null)).rejects.toThrow();
  });
});
