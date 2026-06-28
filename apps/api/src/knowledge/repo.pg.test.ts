import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { PgKnowledgePageRepo, PgKnowledgeRevisionRepo } from "./repo";
import type { KnowledgePage } from "./types";

function page(over: Partial<KnowledgePage> = {}): KnowledgePage {
  const now = new Date();
  return {
    _id: randomUUID(),
    title: "T",
    content: "# md",
    plainText: "plain text body",
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

describe("PgKnowledgePageRepo", () => {
  let db: PGlite;
  let repo: PgKnowledgePageRepo;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    repo = new PgKnowledgePageRepo(db);
  });
  afterEach(async () => {
    await db.close();
  });

  it("round-trips a page including tags array and null domain", async () => {
    const d = page({ domain: "support", tags: ["a", "b"] });
    await repo.insert(d);
    const found = await repo.getById(d._id);
    expect(found?.title).toBe("T");
    expect(found?.tags).toEqual(["a", "b"]);
    expect(found?.domain).toBe("support");
    expect(found?.active).toBe(true);
    expect(await repo.getById(randomUUID())).toBeNull();
  });

  it("upsertBySource is idempotent on (source, source_id) and bumps version", async () => {
    const first = page({ source: "resource", sourceId: "r1", title: "v1" });
    const a = await repo.upsertBySource(first);
    expect(a.version).toBe(1);

    const second = page({ source: "resource", sourceId: "r1", title: "v2" });
    const b = await repo.upsertBySource(second);
    expect(b._id).toBe(a._id); // same canonical row
    expect(b.version).toBe(2);

    const found = await repo.getById(a._id);
    expect(found?.title).toBe("v2");
  });

  it("round-trips the OKF type column through insert and upsert (null tolerated)", async () => {
    const withType = page({ type: "playbook" });
    await repo.insert(withType);
    expect((await repo.getById(withType._id))?.type).toBe("playbook");

    const u = page({ source: "resource", sourceId: "rt-type", type: "guide" });
    const a = await repo.upsertBySource(u);
    expect((await repo.getById(a._id))?.type).toBe("guide");
    await repo.upsertBySource(page({ source: "resource", sourceId: "rt-type", type: "metric" }));
    expect((await repo.getById(a._id))?.type).toBe("metric"); // upsert overwrites type

    const noType = page();
    await repo.insert(noType);
    expect((await repo.getById(noType._id))?.type).toBeNull();
  });

  it("the v016 backfill populates type from frontmatter_extra for legacy rows", async () => {
    const id = randomUUID();
    // A legacy row: type NULL, but `type` still present in frontmatter_extra (the pre-v016 shape).
    await db.query(
      `INSERT INTO knowledge_pages
         (id, title, content, plain_text, source, source_id, frontmatter_extra, type, created_at, updated_at)
       VALUES ($1, 'L', 'c', 'c', 'authored', $2, '{"type":"legacy-type"}'::jsonb, NULL, now(), now())`,
      [id, randomUUID()]
    );
    await db.query(
      "UPDATE knowledge_pages SET type = frontmatter_extra->>'type' WHERE type IS NULL AND frontmatter_extra ? 'type'"
    );
    expect((await repo.getById(id))?.type).toBe("legacy-type");
  });

  it("lists with filters + keyset, excluding inactive by default", async () => {
    const base = Date.now();
    await repo.insert(page({ domain: "a", tags: ["x"], createdAt: new Date(base) }));
    await repo.insert(page({ domain: "b", createdAt: new Date(base + 1000) }));
    await repo.insert(page({ domain: "a", active: false, createdAt: new Date(base + 2000) }));

    const all = await repo.list({ limit: 10 });
    expect(all.items).toHaveLength(2); // inactive excluded

    const onlyA = await repo.list({ limit: 10, domain: "a" });
    expect(onlyA.items).toHaveLength(1);

    const tagged = await repo.list({ limit: 10, tags: ["x"] });
    expect(tagged.items).toHaveLength(1);

    const page1 = await repo.list({ limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();
  });

  it("replaceOne enforces optimistic version", async () => {
    const d = page();
    await repo.insert(d);
    expect(await repo.replaceOne(d._id, 99, { ...d, version: 100 })).toBe(false);
    expect(await repo.replaceOne(d._id, 1, { ...d, version: 2, title: "updated" })).toBe(true);
    expect((await repo.getById(d._id))?.title).toBe("updated");
  });

  it("softDelete deactivates once and removes from listings/governance", async () => {
    const d = page({ alwaysLoadForAgents: true });
    await repo.insert(d);
    expect(await repo.governancePages()).toHaveLength(1);
    expect(await repo.softDelete(d._id)).toBe(true);
    expect(await repo.softDelete(d._id)).toBe(false); // already inactive
    expect(await repo.listActive()).toHaveLength(0);
    expect(await repo.governancePages()).toHaveLength(0);
  });

  it("hasAnyActive flips with the presence of an active page", async () => {
    expect(await repo.hasAnyActive()).toBe(false);
    const d = page();
    await repo.insert(d);
    expect(await repo.hasAnyActive()).toBe(true);
    await repo.softDelete(d._id);
    expect(await repo.hasAnyActive()).toBe(false); // soft-deleted no longer counts
  });

  it("governancePages returns only active + alwaysLoadForAgents", async () => {
    await repo.insert(page({ alwaysLoadForAgents: true }));
    await repo.insert(page({ alwaysLoadForAgents: false }));
    const gov = await repo.governancePages();
    expect(gov).toHaveLength(1);
    expect(gov[0].alwaysLoadForAgents).toBe(true);
  });
});

describe("PgKnowledgeRevisionRepo", () => {
  let db: PGlite;
  let repo: PgKnowledgeRevisionRepo;
  let pageRepo: PgKnowledgePageRepo;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    repo = new PgKnowledgeRevisionRepo(db);
    pageRepo = new PgKnowledgePageRepo(db);
  });
  afterEach(async () => {
    await db.close();
  });

  it("appends with auto-incrementing revision numbers and lists newest-first", async () => {
    const d = page();
    await pageRepo.insert(d);
    expect(await repo.append(randomUUID(), d._id, "c1", "p1", "first")).toBe(1);
    expect(await repo.append(randomUUID(), d._id, "c2", "p2", null)).toBe(2);

    const revs = await repo.list(d._id);
    expect(revs.map((r) => r.revisionNumber)).toEqual([2, 1]);
    expect(revs[1].reason).toBe("first");
  });
});
