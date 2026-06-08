import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { PgKnowledgeChunkRepo } from "./chunks-repo";
import {
  PgKnowledgeCollectionRepo,
  PgKnowledgeDocumentRepo,
  PgKnowledgeRevisionRepo,
} from "./repo";
import { KnowledgeService } from "./service";
import type { EmbeddingPort } from "./types";

function fakeEmbeddings(available: boolean, pending = false): EmbeddingPort {
  let pendingReindex = pending;
  return {
    isAvailable: () => available,
    embedMany: async (values) => ({
      embeddings: values.map(() => [0.5, 0.5, 0.5]),
      dimension: 3,
    }),
    getActive: () => (available ? { provider: "fake", model: "m", dimension: 3 } : null),
    getDimension: () => (available ? 3 : null),
    consumePendingReindex: () => {
      const p = pendingReindex;
      pendingReindex = false;
      return p;
    },
  };
}

function makeService(db: PGlite, embeddings: EmbeddingPort): KnowledgeService {
  return new KnowledgeService({
    documents: new PgKnowledgeDocumentRepo(db),
    chunks: new PgKnowledgeChunkRepo(db),
    collections: new PgKnowledgeCollectionRepo(db),
    revisions: new PgKnowledgeRevisionRepo(db),
    embeddings,
  });
}

describe("KnowledgeService", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
  });
  afterEach(async () => {
    await db.close();
  });

  it("creates a document, indexes it inline, and makes it searchable", async () => {
    const svc = makeService(db, fakeEmbeddings(true));
    const doc = await svc.createDocument({ title: "Paris", content: "the capital of france" });
    expect(doc.source).toBe("authored");

    const res = await svc.search("france", {}, 10);
    expect(res.warnings).toEqual([]);
    expect(res.results[0]?.documentId).toBe(doc._id);
  });

  it("updates with optimistic version, snapshots a revision, and re-indexes on content change", async () => {
    const svc = makeService(db, fakeEmbeddings(true));
    const doc = await svc.createDocument({ title: "T", content: "original body" });

    const conflict = await svc.updateDocument(doc._id, { content: "x" }, 99);
    expect(conflict).toEqual({ ok: false, reason: "conflict" });

    const ok = await svc.updateDocument(doc._id, { content: "updated body" }, 1);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.version).toBe(2);

    const revs = await svc.listRevisions(doc._id);
    expect(revs).toHaveLength(1);
    expect(revs[0].content).toBe("original body");

    const missing = await svc.updateDocument("00000000-0000-0000-0000-000000000000", {}, 1);
    expect(missing).toEqual({ ok: false, reason: "not_found" });
  });

  it("soft-deletes a document and drops it from search", async () => {
    const svc = makeService(db, fakeEmbeddings(true));
    const doc = await svc.createDocument({ title: "Secret", content: "hidden france content" });
    expect(await svc.deleteDocument(doc._id)).toBe(true);
    const res = await svc.search("france", {}, 10);
    expect(res.results).toHaveLength(0);
  });

  it("ingestSource upserts idempotently by (source, sourceId) and indexes", async () => {
    const svc = makeService(db, fakeEmbeddings(true));
    const a = await svc.ingestSource({
      source: "resource",
      sourceId: "ticket-1",
      title: "v1",
      content: "france content one",
    });
    const b = await svc.ingestSource({
      source: "resource",
      sourceId: "ticket-1",
      title: "v2",
      content: "france content two",
    });
    expect(b?._id).toBe(a?._id);
    const list = await svc.listDocuments({ limit: 10 });
    expect(list.items).toHaveLength(1);
    expect(list.items[0].title).toBe("v2");
  });

  it("manages collections + membership with not-found signaling", async () => {
    const svc = makeService(db, fakeEmbeddings(false));
    const col = await svc.createCollection({ name: "kb" });
    const doc = await svc.createDocument({ title: "D", content: "body" });

    expect(await svc.addToCollection(col._id, doc._id)).toBe("ok");
    expect(await svc.addToCollection("11111111-1111-1111-1111-111111111111", doc._id)).toBe(
      "collection_not_found"
    );
    expect(await svc.addToCollection(col._id, "00000000-0000-0000-0000-000000000000")).toBe(
      "document_not_found"
    );
    expect(await svc.listCollectionDocumentIds(col._id)).toEqual([doc._id]);
    expect(await svc.removeFromCollection(col._id, doc._id)).toBe(true);
  });

  it("returns governance docs and runs a pending re-index", async () => {
    const embeddings = fakeEmbeddings(true, true);
    const svc = makeService(db, embeddings);
    await svc.createDocument({ title: "Gov", content: "policy", alwaysLoadForAgents: true });
    await svc.createDocument({ title: "Plain", content: "normal" });

    expect(await svc.governanceDocuments()).toHaveLength(1);

    expect(await svc.runReindexIfPending()).toBe(true);
    expect(await svc.runReindexIfPending()).toBe(false); // flag consumed
  });
});
