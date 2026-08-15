import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";
import { PgKnowledgeChunkRepo } from "./chunks-repo";
import { PageRetrievalService } from "./page-search-adapter";
import { PgKnowledgePageRepo, PgKnowledgeRevisionRepo } from "./repo";
import { registerKnowledgeRoutes } from "./routes";
import { KnowledgeService } from "./service";
import type { EmbeddingPort } from "./types";

function fakeEmbeddings(available: boolean): EmbeddingPort {
  return {
    isAvailable: () => available,
    embedMany: async (values) => ({ embeddings: values.map(() => [0.5, 0.5, 0.5]), dimension: 3 }),
    getActive: () => (available ? { provider: "f", model: "m", dimension: 3 } : null),
    getDimension: () => (available ? 3 : null),
    consumePendingReindex: () => false,
  };
}

async function buildKnowledgeApp(
  db: PGlite,
  available = true,
  withRetrieval = true
): Promise<FastifyInstance> {
  const service = new KnowledgeService({
    pages: new PgKnowledgePageRepo(db),
    chunks: new PgKnowledgeChunkRepo(db),
    revisions: new PgKnowledgeRevisionRepo(db),
    embeddings: fakeEmbeddings(available),
    retrieval: new PageRetrievalService(db),
  });
  const app = Fastify();
  registerKnowledgeRoutes(
    app,
    service,
    async () => {},
    withRetrieval ? new PageRetrievalService(db) : undefined
  );
  await app.ready();
  return app;
}

const base = "/api/v1/knowledge";

describe("knowledge routes", () => {
  let db: PGlite;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = await makeMigratedPglite();
    app = await buildKnowledgeApp(db);
  });
  afterEach(async () => {
    await app.close();
    await db.close();
  });

  async function createPage(title = "Paris", content = "the capital of france"): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `${base}/pages`,
      payload: { title, content },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string }>().id;
  }

  // Raw-insert a space page (the route's page mode reads via PageRetrievalService's SQL, not the
  // chunk-mode service deps). A title match needs no chunks (title_tsv hit path).
  async function seedSpacePage(
    title: string,
    opts: { path?: string; type?: string } = {}
  ): Promise<{ spaceId: string; pageId: string }> {
    const spaceId = randomUUID();
    const pageId = randomUUID();
    await db.query(
      `INSERT INTO knowledge_spaces (id, name, description, created_at, updated_at)
       VALUES ($1, $2, NULL, now(), now())`,
      [spaceId, `b-${spaceId}`]
    );
    await db.query(
      `INSERT INTO knowledge_pages
         (id, title, content, plain_text, source, source_id, tags, active, always_load_for_agents,
          version, space_id, path, type, frontmatter_extra, created_at, updated_at)
       VALUES ($1,$2,$3,$3,'authored',$4,'{}',true,false,1,$5,$6,$7,'{}'::jsonb,now(),now())`,
      [
        pageId,
        title,
        `${title} body`,
        `okf:${spaceId}:${opts.path ?? "p"}`,
        spaceId,
        opts.path ?? "p",
        opts.type ?? null,
      ]
    );
    return { spaceId, pageId };
  }

  it("page-mode search returns whole-page hits and honors the type facet", async () => {
    const { spaceId, pageId } = await seedSpacePage("Orders Table", { type: "table" });
    await seedSpacePage("Customers", { path: "c" });

    const res = await app.inject({
      method: "POST",
      url: `${base}/search`,
      payload: { query: "orders", granularity: "page" },
    });
    expect(res.statusCode).toBe(200);
    const hit = res
      .json<{ results: Array<Record<string, unknown>> }>()
      .results.find((r) => r.pageId === pageId);
    expect(hit).toMatchObject({ pageId: pageId, title: "Orders Table", spaceId, path: "p" });
    expect(hit).toHaveProperty("snippet");
    expect(hit).toHaveProperty("highlightRanges");
    expect(hit).not.toHaveProperty("chunkId"); // page shape, not chunk

    const typed = await app.inject({
      method: "POST",
      url: `${base}/search`,
      payload: { query: "orders", granularity: "page", type: "table" },
    });
    expect(
      typed.json<{ results: Array<{ pageId: string }> }>().results.map((r) => r.pageId)
    ).toEqual([pageId]);
  });

  it("page-mode blank query returns recent pages", async () => {
    const { pageId } = await seedSpacePage("Recent Page");
    const res = await app.inject({
      method: "POST",
      url: `${base}/search`,
      payload: { query: "", granularity: "page" },
    });
    expect(res.statusCode).toBe(200);
    expect(
      res.json<{ results: Array<{ pageId: string }> }>().results.map((r) => r.pageId)
    ).toContain(pageId);
  });

  it("falls back to chunk results for granularity=page when the retrieval spine is absent", async () => {
    const noRetrieval = await buildKnowledgeApp(db, false, false); // lexical, no spine
    const id = await createPage("Paris", "the capital of france");
    const res = await noRetrieval.inject({
      method: "POST",
      url: `${base}/search`,
      payload: { query: "capital", granularity: "page" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ results: Array<Record<string, unknown>>; warnings: string[] }>();
    // chunk-shaped hits (chunkId present) prove the chunk path ran despite granularity=page.
    expect(body.results.some((r) => r.pageId === id && "chunkId" in r)).toBe(true);
    await noRetrieval.close();
  });

  it("creates, fetches, lists, and 404s pages", async () => {
    const id = await createPage();
    const got = await app.inject({ method: "GET", url: `${base}/pages/${id}` });
    expect(got.statusCode).toBe(200);
    expect(got.json<{ id: string }>().id).toBe(id);

    const list = await app.inject({ method: "GET", url: `${base}/pages` });
    expect(list.json<{ items: unknown[] }>().items).toHaveLength(1);

    const missing = await app.inject({
      method: "GET",
      url: `${base}/pages/00000000-0000-0000-0000-000000000000`,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("updates with If-Match (400 without, 409 wrong, 200 right) and snapshots a revision", async () => {
    const id = await createPage();

    const noMatch = await app.inject({
      method: "PUT",
      url: `${base}/pages/${id}`,
      payload: { content: "x" },
    });
    expect(noMatch.statusCode).toBe(400);

    const wrong = await app.inject({
      method: "PUT",
      url: `${base}/pages/${id}`,
      headers: { "if-match": "99" },
      payload: { content: "x" },
    });
    expect(wrong.statusCode).toBe(409);

    const ok = await app.inject({
      method: "PUT",
      url: `${base}/pages/${id}`,
      headers: { "if-match": "1" },
      payload: { content: "updated" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ version: number }>().version).toBe(2);

    const revs = await app.inject({ method: "GET", url: `${base}/pages/${id}/revisions` });
    expect(revs.json<{ items: unknown[] }>().items).toHaveLength(1);
  });

  it("soft-deletes a page", async () => {
    const id = await createPage();
    const del = await app.inject({ method: "DELETE", url: `${base}/pages/${id}` });
    expect(del.statusCode).toBe(204);
    const got = await app.inject({ method: "GET", url: `${base}/pages/${id}` });
    expect(got.statusCode).toBe(404);
  });

  it("searches and returns ranked hits", async () => {
    await createPage();
    const res = await app.inject({
      method: "POST",
      url: `${base}/search`,
      payload: { query: "france", limit: 5 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ results: unknown[]; warnings: string[] }>();
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.warnings).toEqual([]);
  });

  it("reports indexingStatus=indexed on get + list when embeddings are available", async () => {
    const id = await createPage();
    const got = await app.inject({ method: "GET", url: `${base}/pages/${id}` });
    expect(got.json<{ indexingStatus: string }>().indexingStatus).toBe("indexed");

    const list = await app.inject({ method: "GET", url: `${base}/pages` });
    expect(list.json<{ items: { indexingStatus: string }[] }>().items[0].indexingStatus).toBe(
      "indexed"
    );
  });

  it("reports indexingStatus=pending when a page has no chunks", async () => {
    const id = await createPage();
    await new PgKnowledgeChunkRepo(db).deleteByPage(id);
    const got = await app.inject({ method: "GET", url: `${base}/pages/${id}` });
    expect(got.json<{ indexingStatus: string }>().indexingStatus).toBe("pending");
  });

  // Boots a SECOND PGlite + full migration run inside the test body — well over the 5s
  // default when the suite runs fully parallel, so give it explicit headroom.
  it("reports indexingStatus=lexical-only when no embedding provider is available", {
    timeout: 30_000,
  }, async () => {
    const db2 = await makeMigratedPglite();
    const app2 = await buildKnowledgeApp(db2, false);
    try {
      const res = await app2.inject({
        method: "POST",
        url: `${base}/pages`,
        payload: { title: "x", content: "lexical only body" },
      });
      const id = res.json<{ id: string }>().id;
      const got = await app2.inject({ method: "GET", url: `${base}/pages/${id}` });
      expect(got.json<{ indexingStatus: string }>().indexingStatus).toBe("lexical-only");
    } finally {
      await app2.close();
      await db2.close();
    }
  });
});
