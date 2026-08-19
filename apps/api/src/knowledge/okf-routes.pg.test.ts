import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { EmbeddingPort } from "@tulipfarm/knowledge";
import {
  KnowledgeService,
  PageRetrievalService,
  PgKnowledgeChunkRepo,
  PgKnowledgeLinksRepo,
  PgKnowledgePageRepo,
  PgKnowledgeRevisionRepo,
  PgKnowledgeSpaceOverrideRepo,
  PgKnowledgeSpaceRepo,
} from "@tulipfarm/knowledge";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeRequireAuthorization } from "../authz/route-gate";
import { allowAllPages } from "../test/page-gate";
import { makeMigratedPglite } from "../test/pglite";
import { registerKnowledgeRoutes } from "./routes";

function lexicalOnly(): EmbeddingPort {
  return {
    isAvailable: () => false,
    embedMany: async (values) => ({ embeddings: values.map(() => [0, 0, 0]), dimension: 3 }),
    getActive: () => null,
    getDimension: () => null,
    pendingReindex: () => false,
    clearPendingReindex: () => {},
  };
}

async function buildApp(db: PGlite): Promise<FastifyInstance> {
  const service = new KnowledgeService({
    pages: new PgKnowledgePageRepo(db),
    chunks: new PgKnowledgeChunkRepo(db),
    revisions: new PgKnowledgeRevisionRepo(db),
    spaces: new PgKnowledgeSpaceRepo(db),
    links: new PgKnowledgeLinksRepo(db),
    overrides: new PgKnowledgeSpaceOverrideRepo(db),
    embeddings: lexicalOnly(),
    retrieval: new PageRetrievalService(db),
  });
  const app = Fastify();
  registerKnowledgeRoutes(
    app,
    service,
    async () => {},
    makeRequireAuthorization(),
    allowAllPages(),
    new PageRetrievalService(db)
  );
  await app.ready();
  return app;
}

const base = "/api/v1/knowledge";
const ORDERS = `---\ntype: BigQuery Table\ntitle: Orders\n---\n\n# Schema\n\nJoined with [customers](/tables/customers.md).`;
const CUSTOMERS = `---\ntype: BigQuery Table\ntitle: Customers\n---\n\nProfiles.`;

describe("OKF space routes", () => {
  let db: PGlite;
  let app: FastifyInstance;
  beforeEach(async () => {
    db = await makeMigratedPglite();
    app = await buildApp(db);
  });
  afterEach(async () => {
    await app.close();
    await db.close();
  });

  async function createSpace(name = "sales"): Promise<string> {
    const res = await app.inject({ method: "POST", url: `${base}/spaces`, payload: { name } });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string }>().id;
  }

  async function writePage(id: string, path: string, content: string) {
    return app.inject({
      method: "POST",
      url: `${base}/spaces/${id}/pages`,
      payload: { path, content },
    });
  }

  it("does space CRUD with duplicate-name 409", async () => {
    const id = await createSpace();
    expect((await app.inject({ method: "GET", url: `${base}/spaces/${id}` })).statusCode).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: `${base}/spaces` })).json<{ items: unknown[] }>()
        .items
    ).toHaveLength(1);

    const dup = await app.inject({
      method: "POST",
      url: `${base}/spaces`,
      payload: { name: "sales" },
    });
    expect(dup.statusCode).toBe(409);

    const upd = await app.inject({
      method: "PUT",
      url: `${base}/spaces/${id}`,
      payload: { description: "d" },
    });
    expect(upd.json<{ description: string }>().description).toBe("d");

    expect((await app.inject({ method: "DELETE", url: `${base}/spaces/${id}` })).statusCode).toBe(
      204
    );
    expect((await app.inject({ method: "GET", url: `${base}/spaces/${id}` })).statusCode).toBe(404);
  });

  it("writes pages and exposes pages, navigate, and the graph", async () => {
    const id = await createSpace();
    await writePage(id, "tables/customers", CUSTOMERS);
    const wc = await writePage(id, "tables/orders", ORDERS);
    expect(wc.statusCode).toBe(201);
    expect(wc.json<{ path: string }>().path).toBe("tables/orders");

    const docs = await app.inject({ method: "GET", url: `${base}/spaces/${id}/pages` });
    expect(docs.json<{ items: unknown[] }>().items).toHaveLength(2);

    const nav = await app.inject({
      method: "GET",
      url: `${base}/spaces/${id}/navigate?dirPath=tables`,
    });
    expect(nav.json<{ listing: string }>().listing).toContain("[Orders](orders.md)");

    const graph = await app.inject({ method: "GET", url: `${base}/spaces/${id}/graph` });
    const g = graph.json<{ edges: Array<{ broken: boolean }> }>();
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]?.broken).toBe(false);
  });

  it("renames a space (rewriting inbound links) and 409s a name collision", async () => {
    const eng = await createSpace("Engineering");
    const sales = await createSpace("Sales");
    await writePage(
      eng,
      "runbook",
      "---\ntype: Playbook\ntitle: Runbook\n---\n\n[p](tf:page/Sales/pricing)."
    );
    await writePage(sales, "pricing", "---\ntype: Doc\ntitle: Pricing\n---\n\nbody");

    // Renaming onto an existing name is rejected.
    const collide = await app.inject({
      method: "PUT",
      url: `${base}/spaces/${sales}`,
      payload: { name: "Engineering" },
    });
    expect(collide.statusCode).toBe(409);

    // A clean rename succeeds and rewrites the Engineering graph's cross-space edge to the new name.
    const rename = await app.inject({
      method: "PUT",
      url: `${base}/spaces/${sales}`,
      payload: { name: "Revenue" },
    });
    expect(rename.statusCode).toBe(200);

    const graph = (await app.inject({ method: "GET", url: `${base}/spaces/${eng}/graph` })).json<{
      edges: Array<{ targetSpaceName: string | null; targetSpaceId: string | null }>;
    }>();
    const edge = graph.edges.find((e) => e.targetSpaceName === "Revenue");
    expect(edge?.targetSpaceId).toBe(sales);
  });

  it("treats a reserved index path as an override", async () => {
    const id = await createSpace();
    const res = await writePage(id, "index", "# Root");
    expect(res.statusCode).toBe(200);
    expect(res.json<{ override: boolean }>().override).toBe(true);
  });

  it("404s a page write to an unknown space", async () => {
    const res = await writePage(randomUUID(), "a", CUSTOMERS);
    expect(res.statusCode).toBe(404);
  });

  it("lists all pages across spaces and returns a page's backlinks", async () => {
    const eng = await createSpace("Engineering");
    const sales = await createSpace("Sales");
    await writePage(
      eng,
      "runbook",
      "---\ntype: Playbook\ntitle: Runbook\n---\n\nPricing: [pricing](tf:page/Sales/pricing)."
    );
    await writePage(sales, "pricing", "---\ntype: Doc\ntitle: Pricing\n---\n\nbody");

    const pages = (await app.inject({ method: "GET", url: `${base}/pages/mentions` })).json<{
      items: Array<{ spaceName: string; path: string }>;
    }>().items;
    expect(pages.map((p) => `${p.spaceName}/${p.path}`).sort()).toEqual([
      "Engineering/runbook",
      "Sales/pricing",
    ]);

    const salesPages = (
      await app.inject({ method: "GET", url: `${base}/spaces/${sales}/pages` })
    ).json<{ items: Array<{ id: string; path: string }> }>().items;
    const pricingId = salesPages.find((d) => d.path === "pricing")?.id as string;

    const backlinks = await app.inject({
      method: "GET",
      url: `${base}/pages/${pricingId}/backlinks`,
    });
    expect(backlinks.statusCode).toBe(200);
    const items = backlinks.json<{ items: Array<{ title: string; spaceName: string }> }>().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe("Runbook");
    expect(items[0]?.spaceName).toBe("Engineering");

    expect(
      (await app.inject({ method: "GET", url: `${base}/pages/${randomUUID()}/backlinks` }))
        .statusCode
    ).toBe(404);
  });
});
