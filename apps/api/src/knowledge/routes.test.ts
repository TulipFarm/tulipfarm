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

async function buildKnowledgeApp(db: PGlite, available = true): Promise<FastifyInstance> {
  const service = new KnowledgeService({
    documents: new PgKnowledgeDocumentRepo(db),
    chunks: new PgKnowledgeChunkRepo(db),
    collections: new PgKnowledgeCollectionRepo(db),
    revisions: new PgKnowledgeRevisionRepo(db),
    embeddings: fakeEmbeddings(available),
  });
  const app = Fastify();
  registerKnowledgeRoutes(app, service, async () => {});
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
