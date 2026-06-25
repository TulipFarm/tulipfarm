import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { PgKnowledgeBundleOverrideRepo } from "./bundle-overrides-repo";
import { PgKnowledgeBundleRepo } from "./bundles-repo";
import { PgKnowledgeChunkRepo } from "./chunks-repo";
import { PgKnowledgeLinksRepo } from "./links-repo";
import {
  PgKnowledgeCollectionRepo,
  PgKnowledgeDocumentRepo,
  PgKnowledgeRevisionRepo,
} from "./repo";
import { registerKnowledgeRoutes } from "./routes";
import { KnowledgeService } from "./service";
import type { EmbeddingPort } from "./types";

function lexicalOnly(): EmbeddingPort {
  return {
    isAvailable: () => false,
    embedMany: async (values) => ({ embeddings: values.map(() => [0, 0, 0]), dimension: 3 }),
    getActive: () => null,
    getDimension: () => null,
    consumePendingReindex: () => false,
  };
}

async function buildApp(db: PGlite): Promise<FastifyInstance> {
  const service = new KnowledgeService({
    documents: new PgKnowledgeDocumentRepo(db),
    chunks: new PgKnowledgeChunkRepo(db),
    collections: new PgKnowledgeCollectionRepo(db),
    revisions: new PgKnowledgeRevisionRepo(db),
    bundles: new PgKnowledgeBundleRepo(db),
    links: new PgKnowledgeLinksRepo(db),
    overrides: new PgKnowledgeBundleOverrideRepo(db),
    embeddings: lexicalOnly(),
  });
  const app = Fastify();
  registerKnowledgeRoutes(app, service, async () => {});
  await app.ready();
  return app;
}

const base = "/api/v1/knowledge";
const ORDERS = `---\ntype: BigQuery Table\ntitle: Orders\n---\n\n# Schema\n\nJoined with [customers](/tables/customers.md).`;
const CUSTOMERS = `---\ntype: BigQuery Table\ntitle: Customers\n---\n\nProfiles.`;

describe("OKF bundle routes", () => {
  let db: PGlite;
  let app: FastifyInstance;
  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    app = await buildApp(db);
  });
  afterEach(async () => {
    await app.close();
    await db.close();
  });

  async function createBundle(name = "sales"): Promise<string> {
    const res = await app.inject({ method: "POST", url: `${base}/bundles`, payload: { name } });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string }>().id;
  }

  async function writeConcept(id: string, path: string, content: string) {
    return app.inject({
      method: "POST",
      url: `${base}/bundles/${id}/concepts`,
      payload: { path, content },
    });
  }

  it("does bundle CRUD with duplicate-name 409", async () => {
    const id = await createBundle();
    expect((await app.inject({ method: "GET", url: `${base}/bundles/${id}` })).statusCode).toBe(
      200
    );
    expect(
      (await app.inject({ method: "GET", url: `${base}/bundles` })).json<{ items: unknown[] }>()
        .items
    ).toHaveLength(1);

    const dup = await app.inject({
      method: "POST",
      url: `${base}/bundles`,
      payload: { name: "sales" },
    });
    expect(dup.statusCode).toBe(409);

    const upd = await app.inject({
      method: "PUT",
      url: `${base}/bundles/${id}`,
      payload: { description: "d" },
    });
    expect(upd.json<{ description: string }>().description).toBe("d");

    expect((await app.inject({ method: "DELETE", url: `${base}/bundles/${id}` })).statusCode).toBe(
      204
    );
    expect((await app.inject({ method: "GET", url: `${base}/bundles/${id}` })).statusCode).toBe(
      404
    );
  });

  it("writes concepts and exposes documents, navigate, and the graph", async () => {
    const id = await createBundle();
    await writeConcept(id, "tables/customers", CUSTOMERS);
    const wc = await writeConcept(id, "tables/orders", ORDERS);
    expect(wc.statusCode).toBe(201);
    expect(wc.json<{ path: string }>().path).toBe("tables/orders");

    const docs = await app.inject({ method: "GET", url: `${base}/bundles/${id}/documents` });
    expect(docs.json<{ items: unknown[] }>().items).toHaveLength(2);

    const nav = await app.inject({
      method: "GET",
      url: `${base}/bundles/${id}/navigate?dirPath=tables`,
    });
    expect(nav.json<{ listing: string }>().listing).toContain("[Orders](orders.md)");

    const graph = await app.inject({ method: "GET", url: `${base}/bundles/${id}/graph` });
    const g = graph.json<{ edges: Array<{ broken: boolean }> }>();
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]?.broken).toBe(false);
  });

  it("renames a bundle (rewriting inbound links) and 409s a name collision", async () => {
    const eng = await createBundle("Engineering");
    const sales = await createBundle("Sales");
    await writeConcept(
      eng,
      "runbook",
      "---\ntype: Playbook\ntitle: Runbook\n---\n\n[p](tf:page/Sales/pricing)."
    );
    await writeConcept(sales, "pricing", "---\ntype: Doc\ntitle: Pricing\n---\n\nbody");

    // Renaming onto an existing name is rejected.
    const collide = await app.inject({
      method: "PUT",
      url: `${base}/bundles/${sales}`,
      payload: { name: "Engineering" },
    });
    expect(collide.statusCode).toBe(409);

    // A clean rename succeeds and rewrites the Engineering graph's cross-space edge to the new name.
    const rename = await app.inject({
      method: "PUT",
      url: `${base}/bundles/${sales}`,
      payload: { name: "Revenue" },
    });
    expect(rename.statusCode).toBe(200);

    const graph = (await app.inject({ method: "GET", url: `${base}/bundles/${eng}/graph` })).json<{
      edges: Array<{ targetBundleName: string | null; targetBundleId: string | null }>;
    }>();
    const edge = graph.edges.find((e) => e.targetBundleName === "Revenue");
    expect(edge?.targetBundleId).toBe(sales);
  });

  it("treats a reserved index path as an override", async () => {
    const id = await createBundle();
    const res = await writeConcept(id, "index", "# Root");
    expect(res.statusCode).toBe(200);
    expect(res.json<{ override: boolean }>().override).toBe(true);
  });

  it("404s a concept write to an unknown bundle", async () => {
    const res = await writeConcept(randomUUID(), "a", CUSTOMERS);
    expect(res.statusCode).toBe(404);
  });

  it("lists all pages across bundles and returns a concept's backlinks", async () => {
    const eng = await createBundle("Engineering");
    const sales = await createBundle("Sales");
    await writeConcept(
      eng,
      "runbook",
      "---\ntype: Playbook\ntitle: Runbook\n---\n\nPricing: [pricing](tf:page/Sales/pricing)."
    );
    await writeConcept(sales, "pricing", "---\ntype: Doc\ntitle: Pricing\n---\n\nbody");

    const pages = (await app.inject({ method: "GET", url: `${base}/pages` })).json<{
      items: Array<{ bundleName: string; path: string }>;
    }>().items;
    expect(pages.map((p) => `${p.bundleName}/${p.path}`).sort()).toEqual([
      "Engineering/runbook",
      "Sales/pricing",
    ]);

    const salesDocs = (
      await app.inject({ method: "GET", url: `${base}/bundles/${sales}/documents` })
    ).json<{ items: Array<{ id: string; path: string }> }>().items;
    const pricingId = salesDocs.find((d) => d.path === "pricing")?.id as string;

    const backlinks = await app.inject({
      method: "GET",
      url: `${base}/documents/${pricingId}/backlinks`,
    });
    expect(backlinks.statusCode).toBe(200);
    const items = backlinks.json<{ items: Array<{ title: string; bundleName: string }> }>().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe("Runbook");
    expect(items[0]?.bundleName).toBe("Engineering");

    expect(
      (await app.inject({ method: "GET", url: `${base}/documents/${randomUUID()}/backlinks` }))
        .statusCode
    ).toBe(404);
  });
});
