import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { PgKnowledgeLinksRepo } from "./links-repo";
import { PgKnowledgePageRepo } from "./repo";
import { PgKnowledgeSpaceOverrideRepo } from "./space-overrides-repo";
import { PgKnowledgeSpaceRepo } from "./spaces-repo";
import type { KnowledgePage, KnowledgeSpace } from "./types";

function space(over: Partial<KnowledgeSpace> = {}): KnowledgeSpace {
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

function page(spaceId: string, path: string, over: Partial<KnowledgePage> = {}): KnowledgePage {
  const now = new Date();
  return {
    _id: randomUUID(),
    title: path,
    content: "# md",
    plainText: "body",
    source: "authored",
    sourceId: `okf:${spaceId}:${path}`,
    domain: null,
    tags: [],
    active: true,
    alwaysLoadForAgents: false,
    version: 1,
    spaceId,
    path,
    resource: null,
    frontmatterExtra: {},
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe("PgKnowledgeSpaceRepo", () => {
  let db: PGlite;
  let spaces: PgKnowledgeSpaceRepo;
  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    spaces = new PgKnowledgeSpaceRepo(db);
  });
  afterEach(async () => {
    await db.close();
  });

  it("inserts, reads by id/name, lists, COALESCE-updates, deletes", async () => {
    const b = space({ name: "sales", description: "d" });
    await spaces.insert(b);
    expect((await spaces.getById(b._id))?.name).toBe("sales");
    expect((await spaces.getByName("sales"))?._id).toBe(b._id);
    expect((await spaces.list({ limit: 10 })).items).toHaveLength(1);

    const upd = await spaces.update(b._id, { description: "d2" }, new Date());
    expect(upd?.description).toBe("d2");
    expect(upd?.name).toBe("sales"); // name preserved (COALESCE-keep)

    expect(await spaces.delete(b._id)).toBe(true);
    expect(await spaces.getById(b._id)).toBeNull();
  });

  it("enforces the unique space name", async () => {
    await spaces.insert(space({ name: "dup" }));
    await expect(spaces.insert(space({ name: "dup" }))).rejects.toThrow();
  });
});

describe("PgKnowledgePageRepo — OKF columns", () => {
  let db: PGlite;
  let pages: PgKnowledgePageRepo;
  let spaces: PgKnowledgeSpaceRepo;
  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    pages = new PgKnowledgePageRepo(db);
    spaces = new PgKnowledgeSpaceRepo(db);
  });
  afterEach(async () => {
    await db.close();
  });

  it("round-trips OKF columns including frontmatter_extra jsonb", async () => {
    const b = space();
    await spaces.insert(b);
    await pages.insert(
      page(b._id, "tables/orders", {
        resource: "https://x/orders",
        frontmatterExtra: { confidence: "high", n: 3 },
      })
    );
    const got = await pages.getBySpacePath(b._id, "tables/orders");
    expect(got?.spaceId).toBe(b._id);
    expect(got?.resource).toBe("https://x/orders");
    expect(got?.frontmatterExtra).toEqual({ confidence: "high", n: 3 });
  });

  it("listBySpace returns active pages ordered by path", async () => {
    const b = space();
    await spaces.insert(b);
    await pages.insert(page(b._id, "tables/orders"));
    await pages.insert(page(b._id, "playbooks/incident"));
    await pages.insert(page(b._id, "tables/customers"));
    const list = await pages.listBySpace(b._id);
    expect(list.map((d) => d.path)).toEqual([
      "playbooks/incident",
      "tables/customers",
      "tables/orders",
    ]);
  });
});

describe("PgKnowledgeLinksRepo", () => {
  let db: PGlite;
  let pages: PgKnowledgePageRepo;
  let spaces: PgKnowledgeSpaceRepo;
  let links: PgKnowledgeLinksRepo;
  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    pages = new PgKnowledgePageRepo(db);
    spaces = new PgKnowledgeSpaceRepo(db);
    links = new PgKnowledgeLinksRepo(db);
  });
  afterEach(async () => {
    await db.close();
  });

  it("replaces links, expands neighbors, exposes the graph, resolves broken links", async () => {
    const b = space();
    await spaces.insert(b);
    const orders = page(b._id, "tables/orders");
    const customers = page(b._id, "tables/customers");
    await pages.insert(orders);
    await pages.insert(customers);

    await links.replaceForPage(orders._id, b._id, [
      { targetPath: "tables/customers", targetId: customers._id },
      { targetPath: "tables/missing", targetId: null }, // broken: target not yet imported
    ]);

    expect(await links.getLinkedPageIds([orders._id])).toEqual([customers._id]);
    expect(await links.getGraphForSpace(b._id)).toHaveLength(2);

    // Import the missing target, then resolve the dangling link.
    const missing = page(b._id, "tables/missing");
    await pages.insert(missing);
    await links.resolveBrokenLinks(b._id);
    expect((await links.getLinkedPageIds([orders._id])).sort()).toEqual(
      [customers._id, missing._id].sort()
    );
  });

  it("returns [] for an empty source set", async () => {
    expect(await links.getLinkedPageIds([])).toEqual([]);
  });

  it("stores cross-space links and resolves them once the target space + page exist", async () => {
    const eng = space({ name: "Engineering" });
    await spaces.insert(eng);
    const src = page(eng._id, "runbook");
    await pages.insert(src);

    // Author a cross-space link to Sales/pricing BEFORE that space exists → unresolved.
    await links.replaceForPage(src._id, eng._id, [
      { targetPath: "pricing", targetId: null, targetSpaceName: "Sales", targetSpaceId: null },
    ]);
    let graph = await links.getGraphForSpace(eng._id);
    expect(graph).toHaveLength(1);
    expect(graph[0].targetSpaceName).toBe("Sales");
    expect(graph[0].targetSpaceId).toBeNull();
    expect(graph[0].targetId).toBeNull();

    // Now create Sales + its pricing page, then run the global cross-space resolve.
    const sales = space({ name: "Sales" });
    await spaces.insert(sales);
    const pricing = page(sales._id, "pricing");
    await pages.insert(pricing);
    await links.resolveCrossSpaceLinks();

    graph = await links.getGraphForSpace(eng._id);
    expect(graph[0].targetSpaceId).toBe(sales._id);
    expect(graph[0].targetId).toBe(pricing._id);
  });

  it("getBacklinks finds same-space and cross-space inbound links (resolved or not)", async () => {
    const eng = space({ name: "Engineering" });
    const sales = space({ name: "Sales" });
    await spaces.insert(eng);
    await spaces.insert(sales);
    const target = page(eng._id, "runbook");
    const sameSpace = page(eng._id, "oncall");
    const crossSpace = page(sales._id, "deploy");
    await pages.insert(target);
    await pages.insert(sameSpace);
    await pages.insert(crossSpace);

    await links.replaceForPage(sameSpace._id, eng._id, [
      { targetPath: "runbook", targetId: target._id },
    ]);
    // Cross-space link authored without a resolved id (matched by name + path).
    await links.replaceForPage(crossSpace._id, sales._id, [
      {
        targetPath: "runbook",
        targetId: null,
        targetSpaceName: "Engineering",
        targetSpaceId: eng._id,
      },
    ]);

    const backlinks = await links.getBacklinks({
      pageId: target._id,
      spaceId: eng._id,
      spaceName: "Engineering",
      path: "runbook",
    });
    expect(backlinks.map((b) => b.sourceId).sort()).toEqual([sameSpace._id, crossSpace._id].sort());
    expect(backlinks.find((b) => b.sourceId === crossSpace._id)?.spaceName).toBe("Sales");
  });
});

describe("PgKnowledgeSpaceOverrideRepo", () => {
  let db: PGlite;
  let spaces: PgKnowledgeSpaceRepo;
  let overrides: PgKnowledgeSpaceOverrideRepo;
  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    spaces = new PgKnowledgeSpaceRepo(db);
    overrides = new PgKnowledgeSpaceOverrideRepo(db);
  });
  afterEach(async () => {
    await db.close();
  });

  it("upserts, reads, lists, and deletes overrides", async () => {
    const b = space();
    await spaces.insert(b);
    await overrides.upsert({
      spaceId: b._id,
      dirPath: "",
      file: "index.md",
      content: "# idx",
      updatedAt: new Date(),
    });
    expect((await overrides.get(b._id, "", "index.md"))?.content).toBe("# idx");

    await overrides.upsert({
      spaceId: b._id,
      dirPath: "",
      file: "index.md",
      content: "# idx2",
      updatedAt: new Date(),
    });
    expect((await overrides.get(b._id, "", "index.md"))?.content).toBe("# idx2"); // upsert updates
    expect(await overrides.listForSpace(b._id)).toHaveLength(1);

    expect(await overrides.delete(b._id, "", "index.md")).toBe(true);
    expect(await overrides.get(b._id, "", "index.md")).toBeNull();
  });
});
