import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { PgKnowledgeChunkRepo } from "./chunks-repo";
import {
  PgKnowledgeCollectionRepo,
  PgKnowledgeDocumentRepo,
  PgKnowledgeRevisionRepo,
} from "./repo";
import { PageRetrievalService } from "./retrieval-service";
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
    documents: new PgKnowledgeDocumentRepo(db),
    chunks: new PgKnowledgeChunkRepo(db),
    collections: new PgKnowledgeCollectionRepo(db),
    revisions: new PgKnowledgeRevisionRepo(db),
    embeddings: fakeEmbeddings(available),
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
    db = await makePglite();
    await runPgMigrations(db);
    app = await buildKnowledgeApp(db);
  });
  afterEach(async () => {
    await app.close();
    await db.close();
  });

  async function createDoc(title = "Paris", content = "the capital of france"): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `${base}/documents`,
      payload: { title, content },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string }>().id;
  }

  // Raw-insert a bundle page (the route's page mode reads via PageRetrievalService's SQL, not the
  // chunk-mode service deps). A title match needs no chunks (title_tsv hit path).
  async function seedBundlePage(
    title: string,
    opts: { path?: string; type?: string } = {}
  ): Promise<{ bundleId: string; docId: string }> {
    const bundleId = randomUUID();
    const docId = randomUUID();
    await db.query(
      `INSERT INTO knowledge_bundles (id, name, description, created_at, updated_at)
       VALUES ($1, $2, NULL, now(), now())`,
      [bundleId, `b-${bundleId}`]
    );
    await db.query(
      `INSERT INTO knowledge_documents
         (id, title, content, plain_text, source, source_id, tags, active, always_load_for_agents,
          version, bundle_id, path, type, frontmatter_extra, created_at, updated_at)
       VALUES ($1,$2,$3,$3,'authored',$4,'{}',true,false,1,$5,$6,$7,'{}'::jsonb,now(),now())`,
      [
        docId,
        title,
        `${title} body`,
        `okf:${bundleId}:${opts.path ?? "p"}`,
        bundleId,
        opts.path ?? "p",
        opts.type ?? null,
      ]
    );
    return { bundleId, docId };
  }

  it("page-mode search returns whole-page hits and honors the type facet", async () => {
    const { bundleId, docId } = await seedBundlePage("Orders Table", { type: "table" });
    await seedBundlePage("Customers", { path: "c" });

    const res = await app.inject({
      method: "POST",
      url: `${base}/search`,
      payload: { query: "orders", granularity: "page" },
    });
    expect(res.statusCode).toBe(200);
    const hit = res
      .json<{ results: Array<Record<string, unknown>> }>()
      .results.find((r) => r.documentId === docId);
    expect(hit).toMatchObject({ documentId: docId, title: "Orders Table", bundleId, path: "p" });
    expect(hit).toHaveProperty("snippet");
    expect(hit).toHaveProperty("highlightRanges");
    expect(hit).not.toHaveProperty("chunkId"); // page shape, not chunk

    const typed = await app.inject({
      method: "POST",
      url: `${base}/search`,
      payload: { query: "orders", granularity: "page", type: "table" },
    });
    expect(
      typed.json<{ results: Array<{ documentId: string }> }>().results.map((r) => r.documentId)
    ).toEqual([docId]);
  });

  it("page-mode blank query returns recent pages", async () => {
    const { docId } = await seedBundlePage("Recent Page");
    const res = await app.inject({
      method: "POST",
      url: `${base}/search`,
      payload: { query: "", granularity: "page" },
    });
    expect(res.statusCode).toBe(200);
    expect(
      res.json<{ results: Array<{ documentId: string }> }>().results.map((r) => r.documentId)
    ).toContain(docId);
  });

  it("falls back to chunk results for granularity=page when the retrieval spine is absent", async () => {
    const noRetrieval = await buildKnowledgeApp(db, false, false); // lexical, no spine
    const id = await createDoc("Paris", "the capital of france");
    const res = await noRetrieval.inject({
      method: "POST",
      url: `${base}/search`,
      payload: { query: "capital", granularity: "page" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ results: Array<Record<string, unknown>>; warnings: string[] }>();
    // chunk-shaped hits (chunkId present) prove the chunk path ran despite granularity=page.
    expect(body.results.some((r) => r.documentId === id && "chunkId" in r)).toBe(true);
    await noRetrieval.close();
  });

  it("creates, fetches, lists, and 404s documents", async () => {
    const id = await createDoc();
    const got = await app.inject({ method: "GET", url: `${base}/documents/${id}` });
    expect(got.statusCode).toBe(200);
    expect(got.json<{ id: string }>().id).toBe(id);

    const list = await app.inject({ method: "GET", url: `${base}/documents` });
    expect(list.json<{ items: unknown[] }>().items).toHaveLength(1);

    const missing = await app.inject({
      method: "GET",
      url: `${base}/documents/00000000-0000-0000-0000-000000000000`,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("updates with If-Match (400 without, 409 wrong, 200 right) and snapshots a revision", async () => {
    const id = await createDoc();

    const noMatch = await app.inject({
      method: "PUT",
      url: `${base}/documents/${id}`,
      payload: { content: "x" },
    });
    expect(noMatch.statusCode).toBe(400);

    const wrong = await app.inject({
      method: "PUT",
      url: `${base}/documents/${id}`,
      headers: { "if-match": "99" },
      payload: { content: "x" },
    });
    expect(wrong.statusCode).toBe(409);

    const ok = await app.inject({
      method: "PUT",
      url: `${base}/documents/${id}`,
      headers: { "if-match": "1" },
      payload: { content: "updated" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ version: number }>().version).toBe(2);

    const revs = await app.inject({ method: "GET", url: `${base}/documents/${id}/revisions` });
    expect(revs.json<{ items: unknown[] }>().items).toHaveLength(1);
  });

  it("soft-deletes a document", async () => {
    const id = await createDoc();
    const del = await app.inject({ method: "DELETE", url: `${base}/documents/${id}` });
    expect(del.statusCode).toBe(204);
    const got = await app.inject({ method: "GET", url: `${base}/documents/${id}` });
    expect(got.statusCode).toBe(404);
  });

  it("searches and returns ranked hits", async () => {
    await createDoc();
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
    const id = await createDoc();
    const got = await app.inject({ method: "GET", url: `${base}/documents/${id}` });
    expect(got.json<{ indexingStatus: string }>().indexingStatus).toBe("indexed");

    const list = await app.inject({ method: "GET", url: `${base}/documents` });
    expect(list.json<{ items: { indexingStatus: string }[] }>().items[0].indexingStatus).toBe(
      "indexed"
    );
  });

  it("reports indexingStatus=pending when a document has no chunks", async () => {
    const id = await createDoc();
    await new PgKnowledgeChunkRepo(db).deleteByDocument(id);
    const got = await app.inject({ method: "GET", url: `${base}/documents/${id}` });
    expect(got.json<{ indexingStatus: string }>().indexingStatus).toBe("pending");
  });

  it("reports indexingStatus=lexical-only when no embedding provider is available", async () => {
    const db2 = await makePglite();
    await runPgMigrations(db2);
    const app2 = await buildKnowledgeApp(db2, false);
    try {
      const res = await app2.inject({
        method: "POST",
        url: `${base}/documents`,
        payload: { title: "x", content: "lexical only body" },
      });
      const id = res.json<{ id: string }>().id;
      const got = await app2.inject({ method: "GET", url: `${base}/documents/${id}` });
      expect(got.json<{ indexingStatus: string }>().indexingStatus).toBe("lexical-only");
    } finally {
      await app2.close();
      await db2.close();
    }
  });

  it("manages collections and membership", async () => {
    const docId = await createDoc();
    const colRes = await app.inject({
      method: "POST",
      url: `${base}/collections`,
      payload: { name: "kb" },
    });
    expect(colRes.statusCode).toBe(201);
    const colId = colRes.json<{ id: string }>().id;

    const add = await app.inject({
      method: "POST",
      url: `${base}/collections/${colId}/documents`,
      payload: { documentId: docId },
    });
    expect(add.statusCode).toBe(204);

    const ids = await app.inject({
      method: "GET",
      url: `${base}/collections/${colId}/documents`,
    });
    expect(ids.json<{ documentIds: string[] }>().documentIds).toEqual([docId]);

    const remove = await app.inject({
      method: "DELETE",
      url: `${base}/collections/${colId}/documents/${docId}`,
    });
    expect(remove.statusCode).toBe(204);
  });

  it("gets a collection by id and 404s a missing one", async () => {
    const colRes = await app.inject({
      method: "POST",
      url: `${base}/collections`,
      payload: { name: "kb2", description: "desc" },
    });
    const colId = colRes.json<{ id: string }>().id;
    const got = await app.inject({ method: "GET", url: `${base}/collections/${colId}` });
    expect(got.statusCode).toBe(200);
    expect(got.json<{ name: string }>().name).toBe("kb2");
    const missing = await app.inject({
      method: "GET",
      url: `${base}/collections/00000000-0000-0000-0000-000000000000`,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("refuses to add a soft-deleted document to a collection", async () => {
    const docId = await createDoc();
    const colRes = await app.inject({
      method: "POST",
      url: `${base}/collections`,
      payload: { name: "kb3" },
    });
    const colId = colRes.json<{ id: string }>().id;
    await app.inject({ method: "DELETE", url: `${base}/documents/${docId}` });
    const add = await app.inject({
      method: "POST",
      url: `${base}/collections/${colId}/documents`,
      payload: { documentId: docId },
    });
    expect(add.statusCode).toBe(404);
  });

  it("404s adding to a missing collection", async () => {
    const docId = await createDoc();
    const add = await app.inject({
      method: "POST",
      url: `${base}/collections/11111111-1111-1111-1111-111111111111/documents`,
      payload: { documentId: docId },
    });
    expect(add.statusCode).toBe(404);
  });
});
