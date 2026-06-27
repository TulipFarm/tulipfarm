import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import {
  PgKnowledgeCollectionRepo,
  PgKnowledgeDocumentRepo,
  PgKnowledgeRevisionRepo,
} from "./repo";
import type { KnowledgeCollection, KnowledgeDocument } from "./types";

function doc(over: Partial<KnowledgeDocument> = {}): KnowledgeDocument {
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

function collection(over: Partial<KnowledgeCollection> = {}): KnowledgeCollection {
  const now = new Date();
  return {
    _id: randomUUID(),
    name: `c-${randomUUID()}`,
    description: null,
    domain: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe("PgKnowledgeDocumentRepo", () => {
  let db: PGlite;
  let repo: PgKnowledgeDocumentRepo;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    repo = new PgKnowledgeDocumentRepo(db);
  });
  afterEach(async () => {
    await db.close();
  });

  it("round-trips a document including tags array and null domain", async () => {
    const d = doc({ domain: "support", tags: ["a", "b"] });
    await repo.insert(d);
    const found = await repo.getById(d._id);
    expect(found?.title).toBe("T");
    expect(found?.tags).toEqual(["a", "b"]);
    expect(found?.domain).toBe("support");
    expect(found?.active).toBe(true);
    expect(await repo.getById(randomUUID())).toBeNull();
  });

  it("upsertBySource is idempotent on (source, source_id) and bumps version", async () => {
    const first = doc({ source: "resource", sourceId: "r1", title: "v1" });
    const a = await repo.upsertBySource(first);
    expect(a.version).toBe(1);

    const second = doc({ source: "resource", sourceId: "r1", title: "v2" });
    const b = await repo.upsertBySource(second);
    expect(b._id).toBe(a._id); // same canonical row
    expect(b.version).toBe(2);

    const found = await repo.getById(a._id);
    expect(found?.title).toBe("v2");
  });

  it("round-trips the OKF type column through insert and upsert (null tolerated)", async () => {
    const withType = doc({ type: "playbook" });
    await repo.insert(withType);
    expect((await repo.getById(withType._id))?.type).toBe("playbook");

    const u = doc({ source: "resource", sourceId: "rt-type", type: "guide" });
    const a = await repo.upsertBySource(u);
    expect((await repo.getById(a._id))?.type).toBe("guide");
    await repo.upsertBySource(doc({ source: "resource", sourceId: "rt-type", type: "metric" }));
    expect((await repo.getById(a._id))?.type).toBe("metric"); // upsert overwrites type

    const noType = doc();
    await repo.insert(noType);
    expect((await repo.getById(noType._id))?.type).toBeNull();
  });

  it("the v016 backfill populates type from frontmatter_extra for legacy rows", async () => {
    const id = randomUUID();
    // A legacy row: type NULL, but `type` still present in frontmatter_extra (the pre-v016 shape).
    await db.query(
      `INSERT INTO knowledge_documents
         (id, title, content, plain_text, source, source_id, frontmatter_extra, type, created_at, updated_at)
       VALUES ($1, 'L', 'c', 'c', 'authored', $2, '{"type":"legacy-type"}'::jsonb, NULL, now(), now())`,
      [id, randomUUID()]
    );
    await db.query(
      "UPDATE knowledge_documents SET type = frontmatter_extra->>'type' WHERE type IS NULL AND frontmatter_extra ? 'type'"
    );
    expect((await repo.getById(id))?.type).toBe("legacy-type");
  });

  it("lists with filters + keyset, excluding inactive by default", async () => {
    const base = Date.now();
    await repo.insert(doc({ domain: "a", tags: ["x"], createdAt: new Date(base) }));
    await repo.insert(doc({ domain: "b", createdAt: new Date(base + 1000) }));
    await repo.insert(doc({ domain: "a", active: false, createdAt: new Date(base + 2000) }));

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
    const d = doc();
    await repo.insert(d);
    expect(await repo.replaceOne(d._id, 99, { ...d, version: 100 })).toBe(false);
    expect(await repo.replaceOne(d._id, 1, { ...d, version: 2, title: "updated" })).toBe(true);
    expect((await repo.getById(d._id))?.title).toBe("updated");
  });

  it("softDelete deactivates once and removes from listings/governance", async () => {
    const d = doc({ alwaysLoadForAgents: true });
    await repo.insert(d);
    expect(await repo.governanceDocuments()).toHaveLength(1);
    expect(await repo.softDelete(d._id)).toBe(true);
    expect(await repo.softDelete(d._id)).toBe(false); // already inactive
    expect(await repo.listActive()).toHaveLength(0);
    expect(await repo.governanceDocuments()).toHaveLength(0);
  });

  it("governanceDocuments returns only active + alwaysLoadForAgents", async () => {
    await repo.insert(doc({ alwaysLoadForAgents: true }));
    await repo.insert(doc({ alwaysLoadForAgents: false }));
    const gov = await repo.governanceDocuments();
    expect(gov).toHaveLength(1);
    expect(gov[0].alwaysLoadForAgents).toBe(true);
  });
});

describe("PgKnowledgeCollectionRepo", () => {
  let db: PGlite;
  let repo: PgKnowledgeCollectionRepo;
  let docRepo: PgKnowledgeDocumentRepo;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    repo = new PgKnowledgeCollectionRepo(db);
    docRepo = new PgKnowledgeDocumentRepo(db);
  });
  afterEach(async () => {
    await db.close();
  });

  it("CRUD + getByName + optimistic replace + delete", async () => {
    const c = collection({ name: "kb", description: "d" });
    await repo.insert(c);
    expect((await repo.getById(c._id))?.name).toBe("kb");
    expect((await repo.getByName("kb"))?._id).toBe(c._id);

    expect(await repo.replaceOne(c._id, 99, { ...c, version: 100 })).toBe(false);
    expect(await repo.replaceOne(c._id, 1, { ...c, version: 2, name: "kb2" })).toBe(true);
    expect((await repo.getById(c._id))?.name).toBe("kb2");

    expect(await repo.delete(c._id)).toBe(true);
    expect(await repo.getById(c._id)).toBeNull();
  });

  it("manages document membership (add idempotent, remove, list)", async () => {
    const c = collection();
    await repo.insert(c);
    const d = doc();
    await docRepo.insert(d);

    await repo.addDocument(c._id, d._id);
    await repo.addDocument(c._id, d._id); // idempotent
    expect(await repo.listDocumentIds(c._id)).toEqual([d._id]);

    expect(await repo.removeDocument(c._id, d._id)).toBe(true);
    expect(await repo.removeDocument(c._id, d._id)).toBe(false);
    expect(await repo.listDocumentIds(c._id)).toEqual([]);
  });
});

describe("PgKnowledgeRevisionRepo", () => {
  let db: PGlite;
  let repo: PgKnowledgeRevisionRepo;
  let docRepo: PgKnowledgeDocumentRepo;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    repo = new PgKnowledgeRevisionRepo(db);
    docRepo = new PgKnowledgeDocumentRepo(db);
  });
  afterEach(async () => {
    await db.close();
  });

  it("appends with auto-incrementing revision numbers and lists newest-first", async () => {
    const d = doc();
    await docRepo.insert(d);
    expect(await repo.append(randomUUID(), d._id, "c1", "p1", "first")).toBe(1);
    expect(await repo.append(randomUUID(), d._id, "c2", "p2", null)).toBe(2);

    const revs = await repo.list(d._id);
    expect(revs.map((r) => r.revisionNumber)).toEqual([2, 1]);
    expect(revs[1].reason).toBe("first");
  });
});
