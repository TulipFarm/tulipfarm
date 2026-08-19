import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { EmbeddingPort } from "@tulipfarm/knowledge";
import {
  KnowledgeService,
  PageRetrievalService,
  PgKnowledgeChunkRepo,
  PgKnowledgePageRepo,
  PgKnowledgeRevisionRepo,
} from "@tulipfarm/knowledge";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeRequireAuthorization } from "../authz/route-gate";
import { allowAllPages } from "../test/page-gate";
import { makeMigratedPglite } from "../test/pglite";
import { registerKnowledgeRoutes } from "./routes";

function fakeEmbeddings(): EmbeddingPort {
  return {
    isAvailable: () => true,
    embedMany: async (values) => ({ embeddings: values.map(() => [0.1, 0.1, 0.1]), dimension: 3 }),
    getActive: () => ({ provider: "fake", model: "m", dimension: 3 }),
    getDimension: () => 3,
    pendingReindex: () => false,
    clearPendingReindex: () => {},
  };
}

const base = "/api/v1/knowledge";

describe("knowledge admin routes (reindex / backfill / index-status)", () => {
  let db: PGlite;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = await makeMigratedPglite();
    const service = new KnowledgeService({
      pages: new PgKnowledgePageRepo(db),
      chunks: new PgKnowledgeChunkRepo(db),
      revisions: new PgKnowledgeRevisionRepo(db),
      embeddings: fakeEmbeddings(),
      retrieval: new PageRetrievalService(db),
    });
    app = Fastify();
    // Stub auth: set the principal from the x-role header so the admin gate can be exercised.
    registerKnowledgeRoutes(
      app,
      service,
      async (req) => {
        const role = req.headers["x-role"] === "admin" ? "admin" : "member";
        req.user = {
          _id: "u1",
          email: "u@example.com",
          passwordHash: "x",
          name: null,
          role,
          status: "active" as const,
          createdAt: new Date(),
        };
        req.principal = {
          id: "u1",
          kind: "user",
          businessId: DEPLOYMENT_BUSINESS_ID,
          credential: "session",
          authMethods: ["password"],
          authenticatedAt: new Date(),
          role,
        };
      },
      makeRequireAuthorization(),
      allowAllPages()
    );
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    await db.close();
  });

  const asAdmin = { "x-role": "admin" };

  it("forbids non-admins on every admin endpoint (403)", async () => {
    for (const [method, url] of [
      ["POST", `${base}/reindex`],
      ["POST", `${base}/backfill`],
      ["GET", `${base}/index-status`],
    ] as const) {
      const res = await app.inject({ method, url, payload: method === "POST" ? {} : undefined });
      expect(res.statusCode).toBe(403);
    }
  });

  it("reindexes a single page for an admin", async () => {
    const created = await app.inject({
      method: "POST",
      url: `${base}/pages`,
      headers: asAdmin,
      payload: { title: "T", content: "alpha body" },
    });
    const pageId = created.json<{ id: string }>().id;

    const res = await app.inject({
      method: "POST",
      url: `${base}/reindex`,
      headers: asAdmin,
      payload: { pageId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ reindexed: number }>().reindexed).toBe(1);
  });

  it("backfill is a 200 no-op count and index-status returns DB-derived health", async () => {
    await app.inject({
      method: "POST",
      url: `${base}/pages`,
      headers: asAdmin,
      payload: { title: "T", content: "france body" },
    });

    const backfill = await app.inject({
      method: "POST",
      url: `${base}/backfill`,
      headers: asAdmin,
      payload: {},
    });
    expect(backfill.statusCode).toBe(200);
    // Already embedded inline on create → nothing to backfill.
    expect(backfill.json<{ reindexed: number }>().reindexed).toBe(0);

    const status = await app.inject({
      method: "GET",
      url: `${base}/index-status`,
      headers: asAdmin,
    });
    expect(status.statusCode).toBe(200);
    const body = status.json<{
      activePages: number;
      chunks: { total: number; embedded: number; lexicalOnly: number };
      queue: unknown;
    }>();
    expect(body.activePages).toBe(1);
    expect(body.chunks.embedded).toBe(body.chunks.total);
    expect(body.queue).toBeNull(); // indexQueueStats not wired in this test
  });
});
