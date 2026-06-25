import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { PgKnowledgeBundleOverrideRepo } from "./bundle-overrides-repo";
import { PgKnowledgeBundleRepo } from "./bundles-repo";
import { PgKnowledgeLinksRepo } from "./links-repo";
import { PgKnowledgeDocumentRepo } from "./repo";
import type { KnowledgeBundle, KnowledgeDocument } from "./types";

function bundle(over: Partial<KnowledgeBundle> = {}): KnowledgeBundle {
  const now = new Date();
  return {
    _id: randomUUID(),
    name: `b-${randomUUID()}`,
    description: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function concept(
  bundleId: string,
  path: string,
  over: Partial<KnowledgeDocument> = {}
): KnowledgeDocument {
  const now = new Date();
  return {
    _id: randomUUID(),
    title: path,
    content: "# md",
    plainText: "body",
    source: "authored",
    sourceId: `okf:${bundleId}:${path}`,
    domain: null,
    tags: [],
    active: true,
    alwaysLoadForAgents: false,
    version: 1,
    bundleId,
    path,
    resource: null,
    frontmatterExtra: {},
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe("PgKnowledgeBundleRepo", () => {
  let db: PGlite;
  let bundles: PgKnowledgeBundleRepo;
  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    bundles = new PgKnowledgeBundleRepo(db);
  });
  afterEach(async () => {
    await db.close();
  });

  it("inserts, reads by id/name, lists, COALESCE-updates, deletes", async () => {
    const b = bundle({ name: "sales", description: "d" });
    await bundles.insert(b);
    expect((await bundles.getById(b._id))?.name).toBe("sales");
    expect((await bundles.getByName("sales"))?._id).toBe(b._id);
    expect((await bundles.list({ limit: 10 })).items).toHaveLength(1);

    const upd = await bundles.update(b._id, { description: "d2" }, new Date());
    expect(upd?.description).toBe("d2");
    expect(upd?.name).toBe("sales"); // name preserved (COALESCE-keep)

    expect(await bundles.delete(b._id)).toBe(true);
    expect(await bundles.getById(b._id)).toBeNull();
  });

  it("enforces the unique bundle name", async () => {
    await bundles.insert(bundle({ name: "dup" }));
    await expect(bundles.insert(bundle({ name: "dup" }))).rejects.toThrow();
  });
});

describe("PgKnowledgeDocumentRepo — OKF columns", () => {
  let db: PGlite;
  let docs: PgKnowledgeDocumentRepo;
  let bundles: PgKnowledgeBundleRepo;
  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    docs = new PgKnowledgeDocumentRepo(db);
    bundles = new PgKnowledgeBundleRepo(db);
  });
  afterEach(async () => {
    await db.close();
  });

  it("round-trips OKF columns including frontmatter_extra jsonb", async () => {
    const b = bundle();
    await bundles.insert(b);
    await docs.insert(
      concept(b._id, "tables/orders", {
        resource: "https://x/orders",
        frontmatterExtra: { confidence: "high", n: 3 },
      })
    );
    const got = await docs.getByBundlePath(b._id, "tables/orders");
    expect(got?.bundleId).toBe(b._id);
    expect(got?.resource).toBe("https://x/orders");
    expect(got?.frontmatterExtra).toEqual({ confidence: "high", n: 3 });
  });

  it("listByBundle returns active concepts ordered by path", async () => {
    const b = bundle();
    await bundles.insert(b);
    await docs.insert(concept(b._id, "tables/orders"));
    await docs.insert(concept(b._id, "playbooks/incident"));
    await docs.insert(concept(b._id, "tables/customers"));
    const list = await docs.listByBundle(b._id);
    expect(list.map((d) => d.path)).toEqual([
      "playbooks/incident",
      "tables/customers",
      "tables/orders",
    ]);
  });
});

describe("PgKnowledgeLinksRepo", () => {
  let db: PGlite;
  let docs: PgKnowledgeDocumentRepo;
  let bundles: PgKnowledgeBundleRepo;
  let links: PgKnowledgeLinksRepo;
  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    docs = new PgKnowledgeDocumentRepo(db);
    bundles = new PgKnowledgeBundleRepo(db);
    links = new PgKnowledgeLinksRepo(db);
  });
  afterEach(async () => {
    await db.close();
  });

  it("replaces links, expands neighbors, exposes the graph, resolves broken links", async () => {
    const b = bundle();
    await bundles.insert(b);
    const orders = concept(b._id, "tables/orders");
    const customers = concept(b._id, "tables/customers");
    await docs.insert(orders);
    await docs.insert(customers);

    await links.replaceForDocument(orders._id, b._id, [
      { targetPath: "tables/customers", targetId: customers._id },
      { targetPath: "tables/missing", targetId: null }, // broken: target not yet imported
    ]);

    expect(await links.getLinkedDocumentIds([orders._id])).toEqual([customers._id]);
    expect(await links.getGraphForBundle(b._id)).toHaveLength(2);

    // Import the missing target, then resolve the dangling link.
    const missing = concept(b._id, "tables/missing");
    await docs.insert(missing);
    await links.resolveBrokenLinks(b._id);
    expect((await links.getLinkedDocumentIds([orders._id])).sort()).toEqual(
      [customers._id, missing._id].sort()
    );
  });

  it("returns [] for an empty source set", async () => {
    expect(await links.getLinkedDocumentIds([])).toEqual([]);
  });

  it("stores cross-space links and resolves them once the target bundle + page exist", async () => {
    const eng = bundle({ name: "Engineering" });
    await bundles.insert(eng);
    const src = concept(eng._id, "runbook");
    await docs.insert(src);

    // Author a cross-space link to Sales/pricing BEFORE that bundle exists → unresolved.
    await links.replaceForDocument(src._id, eng._id, [
      { targetPath: "pricing", targetId: null, targetBundleName: "Sales", targetBundleId: null },
    ]);
    let graph = await links.getGraphForBundle(eng._id);
    expect(graph).toHaveLength(1);
    expect(graph[0].targetBundleName).toBe("Sales");
    expect(graph[0].targetBundleId).toBeNull();
    expect(graph[0].targetId).toBeNull();

    // Now create Sales + its pricing page, then run the global cross-bundle resolve.
    const sales = bundle({ name: "Sales" });
    await bundles.insert(sales);
    const pricing = concept(sales._id, "pricing");
    await docs.insert(pricing);
    await links.resolveCrossBundleLinks();

    graph = await links.getGraphForBundle(eng._id);
    expect(graph[0].targetBundleId).toBe(sales._id);
    expect(graph[0].targetId).toBe(pricing._id);
  });

  it("getBacklinks finds same-space and cross-space inbound links (resolved or not)", async () => {
    const eng = bundle({ name: "Engineering" });
    const sales = bundle({ name: "Sales" });
    await bundles.insert(eng);
    await bundles.insert(sales);
    const target = concept(eng._id, "runbook");
    const sameSpace = concept(eng._id, "oncall");
    const crossSpace = concept(sales._id, "deploy");
    await docs.insert(target);
    await docs.insert(sameSpace);
    await docs.insert(crossSpace);

    await links.replaceForDocument(sameSpace._id, eng._id, [
      { targetPath: "runbook", targetId: target._id },
    ]);
    // Cross-space link authored without a resolved id (matched by name + path).
    await links.replaceForDocument(crossSpace._id, sales._id, [
      {
        targetPath: "runbook",
        targetId: null,
        targetBundleName: "Engineering",
        targetBundleId: eng._id,
      },
    ]);

    const backlinks = await links.getBacklinks({
      documentId: target._id,
      bundleId: eng._id,
      bundleName: "Engineering",
      path: "runbook",
    });
    expect(backlinks.map((b) => b.sourceId).sort()).toEqual([sameSpace._id, crossSpace._id].sort());
    expect(backlinks.find((b) => b.sourceId === crossSpace._id)?.bundleName).toBe("Sales");
  });
});

describe("PgKnowledgeBundleOverrideRepo", () => {
  let db: PGlite;
  let bundles: PgKnowledgeBundleRepo;
  let overrides: PgKnowledgeBundleOverrideRepo;
  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    bundles = new PgKnowledgeBundleRepo(db);
    overrides = new PgKnowledgeBundleOverrideRepo(db);
  });
  afterEach(async () => {
    await db.close();
  });

  it("upserts, reads, lists, and deletes overrides", async () => {
    const b = bundle();
    await bundles.insert(b);
    await overrides.upsert({
      bundleId: b._id,
      dirPath: "",
      file: "index.md",
      content: "# idx",
      updatedAt: new Date(),
    });
    expect((await overrides.get(b._id, "", "index.md"))?.content).toBe("# idx");

    await overrides.upsert({
      bundleId: b._id,
      dirPath: "",
      file: "index.md",
      content: "# idx2",
      updatedAt: new Date(),
    });
    expect((await overrides.get(b._id, "", "index.md"))?.content).toBe("# idx2"); // upsert updates
    expect(await overrides.listForBundle(b._id)).toHaveLength(1);

    expect(await overrides.delete(b._id, "", "index.md")).toBe(true);
    expect(await overrides.get(b._id, "", "index.md")).toBeNull();
  });
});
