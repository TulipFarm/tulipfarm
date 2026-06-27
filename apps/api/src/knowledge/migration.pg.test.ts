import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { PG_MIGRATIONS } from "../pg-migrations";
import { makePglite } from "../test/pglite";

async function seedPage(
  db: PGlite,
  id: string = randomUUID(),
  sourceId: string = randomUUID()
): Promise<string> {
  await db.query(
    `INSERT INTO knowledge_pages
       (id, title, content, plain_text, source, source_id, created_at, updated_at)
     VALUES ($1, 'T', 'c', 'c', 'authored', $2, now(), now())`,
    [id, sourceId]
  );
  return id;
}

async function seedChunk(
  db: PGlite,
  pageId: string,
  content: string,
  embedding: string | null
): Promise<void> {
  await db.query(
    `INSERT INTO knowledge_chunks (id, page_id, chunk_index, content, embedding, tsv, model, dim, created_at)
     VALUES ($1, $2, 0, $3, ${embedding === null ? "NULL" : "$4::vector"}, to_tsvector('english', $3),
             'm', 3, now())`,
    embedding === null
      ? [randomUUID(), pageId, content]
      : [randomUUID(), pageId, content, embedding]
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

  it("bumps schema_version to the latest (20)", async () => {
    const { rows } = await db.query("SELECT version FROM schema_version WHERE id = true");
    expect(Number((rows[0] as { version: number }).version)).toBe(20);
  });

  it("adds knowledge_chunks.content_hash (019)", async () => {
    const col = await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'knowledge_chunks' AND column_name = 'content_hash'"
    );
    expect((col.rows as { column_name: string }[]).map((r) => r.column_name)).toEqual([
      "content_hash",
    ]);
  });

  it("backfills content_hash with md5(content) for pre-existing chunks (019)", async () => {
    // Simulate a pre-019 row (NULL hash), then replay just the 019 backfill directly — the runner
    // won't re-run an already-applied version, so invoke its `up` to exercise the backfill SQL.
    const pageId = await seedPage(db);
    await seedChunk(db, pageId, "alpha", null);
    await db.query("UPDATE knowledge_chunks SET content_hash = NULL");
    const v019 = PG_MIGRATIONS.find((m) => m.version === 19);
    if (!v019) throw new Error("migration 019 missing");
    await v019.up(db);
    const { rows } = await db.query(
      "SELECT content_hash, md5(content) AS expected FROM knowledge_chunks WHERE content = 'alpha'"
    );
    const row = rows[0] as { content_hash: string; expected: string };
    expect(row.content_hash).toBe(row.expected);
  });

  it("creates the knowledge_connectors sync-state table (020)", async () => {
    const { rows } = await db.query("SELECT to_regclass('knowledge_connectors') AS t");
    expect((rows[0] as { t: string | null }).t).not.toBeNull();
  });

  it("knowledge_connectors defaults enabled=false with a nullable cursor (020)", async () => {
    await db.query(
      "INSERT INTO knowledge_connectors (name, created_at, updated_at) VALUES ('c', now(), now())"
    );
    const { rows } = await db.query(
      "SELECT enabled, cursor, last_run_at, last_error FROM knowledge_connectors WHERE name = 'c'"
    );
    const row = rows[0] as {
      enabled: boolean;
      cursor: string | null;
      last_run_at: Date | null;
      last_error: string | null;
    };
    expect(row.enabled).toBe(false);
    expect(row.cursor).toBeNull();
    expect(row.last_run_at).toBeNull();
    expect(row.last_error).toBeNull();
  });

  it("creates the three knowledge content tables (collections retired by 018)", async () => {
    for (const t of ["knowledge_pages", "knowledge_chunks", "knowledge_revisions"]) {
      const { rows } = await db.query("SELECT to_regclass($1) AS t", [t]);
      expect((rows[0] as { t: string | null }).t).not.toBeNull();
    }
    // The legacy flat-collection grouping is dropped by migration 018.
    for (const t of ["knowledge_collections", "knowledge_documents_collections"]) {
      const { rows } = await db.query("SELECT to_regclass($1) AS t", [t]);
      expect((rows[0] as { t: string | null }).t).toBeNull();
    }
  });

  it("stores a nullable vector + tsvector and ranks by cosine exact-scan", async () => {
    const pageId = await seedPage(db);
    await seedChunk(db, pageId, "alpha", "[1,0,0]");
    await seedChunk(db, pageId, "beta", "[0.2,0.9,0]");

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
    const pageId = await seedPage(db);
    await seedChunk(db, pageId, "the quick brown fox jumps", null);

    const { rows } = await db.query(
      `SELECT content FROM knowledge_chunks
       WHERE tsv @@ websearch_to_tsquery('english', $1)`,
      ["fox"]
    );
    expect(rows).toHaveLength(1);
    expect((rows[0] as { content: string }).content).toContain("fox");
  });

  it("enforces UNIQUE(source, source_id) on pages", async () => {
    await seedPage(db, randomUUID(), "dup");
    await expect(seedPage(db, randomUUID(), "dup")).rejects.toThrow();
  });

  it("cascade-deletes chunks when a page is removed", async () => {
    const pageId = await seedPage(db);
    await seedChunk(db, pageId, "x", "[1,0,0]");
    await db.query("DELETE FROM knowledge_pages WHERE id = $1", [pageId]);
    const { rows } = await db.query("SELECT count(*)::int AS n FROM knowledge_chunks");
    expect((rows[0] as { n: number }).n).toBe(0);
  });

  // --- OKF spaces (011) ---

  async function seedSpace(id: string = randomUUID(), name: string = `b-${id}`): Promise<string> {
    await db.query(
      "INSERT INTO knowledge_spaces (id, name, created_at, updated_at) VALUES ($1, $2, now(), now())",
      [id, name]
    );
    return id;
  }

  it("creates the three OKF tables (011)", async () => {
    for (const t of ["knowledge_spaces", "knowledge_links", "knowledge_space_overrides"]) {
      const { rows } = await db.query("SELECT to_regclass($1) AS t", [t]);
      expect((rows[0] as { t: string | null }).t).not.toBeNull();
    }
  });

  it("adds the OKF columns to knowledge_pages (011; okf_type later dropped by 014)", async () => {
    const { rows } = await db.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'knowledge_pages'
         AND column_name IN ('space_id', 'path', 'okf_type', 'resource', 'frontmatter_extra')
       ORDER BY column_name`
    );
    expect((rows as { column_name: string }[]).map((r) => r.column_name)).toEqual([
      "frontmatter_extra",
      "path",
      "resource",
      "space_id",
    ]);
  });

  it("enforces partial unique (space_id, path) but allows NULL-space legacy duplicates", async () => {
    const spaceId = await seedSpace();
    const mkPage = (path: string) =>
      db.query(
        `INSERT INTO knowledge_pages
           (id, title, content, plain_text, source, source_id, space_id, path, created_at, updated_at)
         VALUES ($1, 'T', 'c', 'c', 'authored', $2, $3, $4, now(), now())`,
        [randomUUID(), randomUUID(), spaceId, path]
      );
    await mkPage("tables/orders");
    await expect(mkPage("tables/orders")).rejects.toThrow();
    // Legacy docs (NULL space_id/path) are unaffected by the partial index.
    await expect(seedPage(db)).resolves.toBeDefined();
    await expect(seedPage(db)).resolves.toBeDefined();
  });

  it("tolerates broken links (target_id NULL) and cascades links with their source (011)", async () => {
    const spaceId = await seedSpace();
    const srcId = randomUUID();
    await db.query(
      `INSERT INTO knowledge_pages
         (id, title, content, plain_text, source, source_id, space_id, path, created_at, updated_at)
       VALUES ($1, 'T', 'c', 'c', 'authored', $2, $3, 'a', now(), now())`,
      [srcId, randomUUID(), spaceId]
    );
    await db.query(
      `INSERT INTO knowledge_links (id, space_id, source_id, target_path, target_id, created_at)
       VALUES ($1, $2, $3, 'not/yet/imported', NULL, now())`,
      [randomUUID(), spaceId, srcId]
    );
    let n = await db.query("SELECT count(*)::int AS n FROM knowledge_links");
    expect((n.rows[0] as { n: number }).n).toBe(1);
    await db.query("DELETE FROM knowledge_pages WHERE id = $1", [srcId]);
    n = await db.query("SELECT count(*)::int AS n FROM knowledge_links");
    expect((n.rows[0] as { n: number }).n).toBe(0);
  });

  it("enforces the space_overrides file CHECK (index.md|log.md only) (011)", async () => {
    const spaceId = await seedSpace();
    await expect(
      db.query(
        `INSERT INTO knowledge_space_overrides (space_id, dir_path, file, content, updated_at)
         VALUES ($1, '', 'readme.md', 'x', now())`,
        [spaceId]
      )
    ).rejects.toThrow();
    await expect(
      db.query(
        `INSERT INTO knowledge_space_overrides (space_id, dir_path, file, content, updated_at)
         VALUES ($1, '', 'index.md', 'x', now())`,
        [spaceId]
      )
    ).resolves.toBeDefined();
  });

  // --- OKF cross-space links (012) ---

  it("adds target_space_id + target_space_name to knowledge_links (012)", async () => {
    const { rows } = await db.query(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_name = 'knowledge_links'
         AND column_name IN ('target_space_id', 'target_space_name')
       ORDER BY column_name`
    );
    expect(rows as { column_name: string; is_nullable: string }[]).toEqual([
      { column_name: "target_space_id", is_nullable: "YES" },
      { column_name: "target_space_name", is_nullable: "YES" },
    ]);
  });

  it("allows same (source, path) into two different target spaces but dedupes same-space (012)", async () => {
    const srcSpace = await seedSpace();
    const srcId = randomUUID();
    await db.query(
      `INSERT INTO knowledge_pages
         (id, title, content, plain_text, source, source_id, space_id, path, created_at, updated_at)
       VALUES ($1, 'T', 'c', 'c', 'authored', $2, $3, 'a', now(), now())`,
      [srcId, randomUUID(), srcSpace]
    );
    const link = (targetSpaceName: string | null) =>
      db.query(
        `INSERT INTO knowledge_links
           (id, space_id, source_id, target_path, target_id, target_space_id, target_space_name, created_at)
         VALUES ($1, $2, $3, 'shared/path', NULL, NULL, $4, now())`,
        [randomUUID(), srcSpace, srcId, targetSpaceName]
      );
    // Two cross-space links to the SAME path but DIFFERENT space names both insert.
    await expect(link("Engineering")).resolves.toBeDefined();
    await expect(link("Sales")).resolves.toBeDefined();
    // A same-space link (NULL space name) collides with another same-space link to the same path.
    await expect(link(null)).resolves.toBeDefined();
    await expect(link(null)).rejects.toThrow();
  });
});
