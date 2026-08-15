import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";
import { PgKnowledgeChunkRepo } from "./chunks-repo";
import { PageRetrievalService } from "./page-search-adapter";
import { PgKnowledgePageRepo, PgKnowledgeRevisionRepo } from "./repo";
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
    pages: new PgKnowledgePageRepo(db),
    chunks: new PgKnowledgeChunkRepo(db),
    revisions: new PgKnowledgeRevisionRepo(db),
    embeddings,
    retrieval: new PageRetrievalService(db),
  });
}

describe("KnowledgeService", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await makeMigratedPglite();
  });
  afterEach(async () => {
    await db.close();
  });

  it("creates a page, indexes it inline, and makes it searchable", async () => {
    const svc = makeService(db, fakeEmbeddings(true));
    const page = await svc.createPage({ title: "Paris", content: "the capital of france" });
    expect(page.source).toBe("authored");

    const res = await svc.search("france", {}, 10);
    expect(res.warnings).toEqual([]);
    expect(res.results[0]?.pageId).toBe(page._id);
  });

  it("updates with optimistic version, snapshots a revision, and re-indexes on content change", async () => {
    const svc = makeService(db, fakeEmbeddings(true));
    const page = await svc.createPage({ title: "T", content: "original body" });

    const conflict = await svc.updatePage(page._id, { content: "x" }, 99);
    expect(conflict).toEqual({ ok: false, reason: "conflict" });

    const ok = await svc.updatePage(page._id, { content: "updated body" }, 1);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.version).toBe(2);

    const revs = await svc.listRevisions(page._id);
    expect(revs).toHaveLength(1);
    expect(revs[0].content).toBe("original body");

    const missing = await svc.updatePage("00000000-0000-0000-0000-000000000000", {}, 1);
    expect(missing).toEqual({ ok: false, reason: "not_found" });
  });

  it("soft-deletes a page and drops it from search", async () => {
    const svc = makeService(db, fakeEmbeddings(true));
    const page = await svc.createPage({ title: "Secret", content: "hidden france content" });
    expect(await svc.deletePage(page._id)).toBe(true);
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
    const list = await svc.listPages({ limit: 10 });
    expect(list.items).toHaveLength(1);
    expect(list.items[0].title).toBe("v2");
  });

  it("returns governance pages and runs a pending re-index", async () => {
    const embeddings = fakeEmbeddings(true, true);
    const svc = makeService(db, embeddings);
    await svc.createPage({ title: "Gov", content: "policy", alwaysLoadForAgents: true });
    await svc.createPage({ title: "Plain", content: "normal" });

    expect(await svc.governancePages()).toHaveLength(1);

    expect(await svc.runReindexIfPending()).toBe(true);
    expect(await svc.runReindexIfPending()).toBe(false); // flag consumed
  });

  async function embeddedCount(): Promise<number> {
    const { rows } = await db.query(
      "SELECT count(*)::int AS n FROM knowledge_chunks WHERE embedding IS NOT NULL"
    );
    return (rows[0] as { n: number }).n;
  }

  it("reindexTargeted re-indexes one page, a whole reindex on no args, and 0 for a missing page", async () => {
    const svc = makeService(db, fakeEmbeddings(true));
    const a = await svc.createPage({ title: "A", content: "alpha body" });
    await svc.createPage({ title: "B", content: "beta body" });
    expect(await svc.reindexTargeted({ pageId: a._id })).toBe(1);
    expect(await svc.reindexTargeted({})).toBe(2);
    expect(await svc.reindexTargeted({ pageId: "00000000-0000-0000-0000-000000000000" })).toBe(0);
  });

  it("backfillMissing embeds pages authored before a provider existed, idempotently", async () => {
    // Author a page with no provider → chunk stored lexical-only (NULL embedding).
    const offline = makeService(db, fakeEmbeddings(false));
    await offline.createPage({ title: "T", content: "france content here" });
    expect(await embeddedCount()).toBe(0);

    // Provider now available → backfill embeds the stale page.
    const online = makeService(db, fakeEmbeddings(true));
    expect(await online.backfillMissing()).toBe(1);
    expect(await embeddedCount()).toBeGreaterThan(0);
    // Nothing left to backfill.
    expect(await online.backfillMissing()).toBe(0);
  });

  it("backfillMissing is a no-op when no provider is available", async () => {
    const offline = makeService(db, fakeEmbeddings(false));
    await offline.createPage({ title: "T", content: "body text" });
    expect(await offline.backfillMissing()).toBe(0);
  });

  it("indexStatus reports DB-derived counts and a null queue when unwired", async () => {
    const svc = makeService(db, fakeEmbeddings(true));
    await svc.createPage({ title: "A", content: "alpha body" });
    const status = await svc.indexStatus();
    expect(status.activePages).toBe(1);
    expect(status.chunks.total).toBeGreaterThan(0);
    expect(status.chunks.embedded).toBe(status.chunks.total);
    expect(status.chunks.lexicalOnly).toBe(0);
    expect(status.queue).toBeNull();
  });

  it("indexStatus surfaces pg-boss queue stats when wired", async () => {
    const failedAt = new Date();
    const svc = new KnowledgeService({
      pages: new PgKnowledgePageRepo(db),
      chunks: new PgKnowledgeChunkRepo(db),
      revisions: new PgKnowledgeRevisionRepo(db),
      embeddings: fakeEmbeddings(true),
      retrieval: new PageRetrievalService(db),
      indexQueueStats: async () => ({ pending: 3, lastError: { message: "boom", failedAt } }),
    });
    const status = await svc.indexStatus();
    expect(status.queue?.pending).toBe(3);
    expect(status.queue?.lastError?.message).toBe("boom");
  });
});
