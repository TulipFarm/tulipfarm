import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { PgKnowledgeChunkRepo } from "./chunks-repo";
import { PgKnowledgeLinksRepo } from "./links-repo";
import { PageRetrievalService } from "./page-search-adapter";
import { PgKnowledgePageRepo, PgKnowledgeRevisionRepo } from "./repo";
import { KnowledgeService } from "./service";
import { PgKnowledgeSpaceOverrideRepo } from "./space-overrides-repo";
import { PgKnowledgeSpaceRepo } from "./spaces-repo";
import type { EmbeddingPort } from "./types";

// Lexical-only embeddings (no provider) → deterministic websearch_to_tsquery ranking.
function lexicalOnly(): EmbeddingPort {
  return {
    isAvailable: () => false,
    embedMany: async (values) => ({ embeddings: values.map(() => [0, 0, 0]), dimension: 3 }),
    getActive: () => null,
    getDimension: () => null,
    consumePendingReindex: () => false,
  };
}

function makeService(db: PGlite): KnowledgeService {
  return new KnowledgeService({
    pages: new PgKnowledgePageRepo(db),
    chunks: new PgKnowledgeChunkRepo(db),
    revisions: new PgKnowledgeRevisionRepo(db),
    spaces: new PgKnowledgeSpaceRepo(db),
    links: new PgKnowledgeLinksRepo(db),
    overrides: new PgKnowledgeSpaceOverrideRepo(db),
    embeddings: lexicalOnly(),
    retrieval: new PageRetrievalService(db),
  });
}

const ORDERS = `---
type: BigQuery Table
title: Orders
tags: [sales, orders]
---

# Schema

One row per order. Joined with [customers](/tables/customers.md) on customer_id.`;

const CUSTOMERS = `---
type: BigQuery Table
title: Customers
---

Customer profiles for the retail business.`;

describe("KnowledgeService — OKF", () => {
  let db: PGlite;
  let svc: KnowledgeService;
  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    svc = makeService(db);
  });
  afterEach(async () => {
    await db.close();
  });

  async function seedSpace(name = "sales") {
    const r = await svc.createSpace({ name });
    if (!r.ok) throw new Error(r.reason);
    return r.space;
  }

  it("creates a space and rejects a duplicate name", async () => {
    const b = await seedSpace();
    expect(b.name).toBe("sales");
    expect(await svc.createSpace({ name: "sales" })).toEqual({ ok: false, reason: "name_taken" });
  });

  it("returns space_not_found for a write to an unknown space", async () => {
    expect(await svc.writePage({ spaceId: randomUUID(), path: "x", content: CUSTOMERS })).toEqual({
      ok: false,
      reason: "space_not_found",
    });
  });

  it("accepts type-less content (no required frontmatter)", async () => {
    const b = await seedSpace();
    expect((await svc.writePage({ spaceId: b._id, path: "bare", content: "just a body" })).ok).toBe(
      true
    );
  });

  it("writes pages, resolves cross-links, and navigates the tree", async () => {
    const b = await seedSpace();
    await svc.writePage({ spaceId: b._id, path: "tables/customers", content: CUSTOMERS });
    expect(
      (await svc.writePage({ spaceId: b._id, path: "tables/orders", content: ORDERS })).ok
    ).toBe(true);

    expect(await svc.navigateSpace(b._id, "")).toContain("[tables](tables/)");
    const tables = await svc.navigateSpace(b._id, "tables");
    expect(tables).toContain("[Orders](orders.md)");
    expect(tables).toContain("[Customers](customers.md)");

    const graph = await svc.getSpaceGraph(b._id);
    expect(graph?.edges).toHaveLength(1);
    expect(graph?.edges[0]?.broken).toBe(false);
    expect(graph?.nodes.map((n) => n.path).sort()).toEqual(["tables/customers", "tables/orders"]);
  });

  it("expands search hits to linked neighbors", async () => {
    const b = await seedSpace();
    await svc.writePage({ spaceId: b._id, path: "tables/customers", content: CUSTOMERS });
    await svc.writePage({ spaceId: b._id, path: "tables/orders", content: ORDERS });

    const plain = await svc.search("Schema", {}, 10);
    const expanded = await svc.search("Schema", {}, 10, { expandGraph: true });
    expect(expanded.results.length).toBeGreaterThanOrEqual(plain.results.length);

    const docs = await svc.listSpacePages(b._id);
    const customersId = docs.find((d) => d.path === "tables/customers")?._id;
    expect(new Set(expanded.results.map((r) => r.pageId)).has(customersId as string)).toBe(true);
  });

  it("stores a reserved index path as an override that navigate honors", async () => {
    const b = await seedSpace();
    expect(
      await svc.writePage({ spaceId: b._id, path: "index", content: "# Hand-written root" })
    ).toEqual({ ok: true, override: true });
    expect(await svc.navigateSpace(b._id, "")).toBe("# Hand-written root");
  });

  it("resolves cross-space links and exposes backlinks across spaces", async () => {
    const eng = await seedSpace("Engineering");
    const sales = await seedSpace("Sales");

    // An Engineering page links cross-space to a Sales page that doesn't exist yet.
    await svc.writePage({
      spaceId: eng._id,
      path: "runbook",
      content:
        "---\ntype: Playbook\ntitle: Runbook\n---\n\nPricing: [pricing](tf:page/Sales/pricing).",
    });
    // A same-space page links to the runbook.
    await svc.writePage({
      spaceId: eng._id,
      path: "oncall",
      content: "---\ntype: Playbook\ntitle: On-call\n---\n\nSee the [runbook](runbook.md).",
    });
    // Create the Sales target.
    await svc.writePage({
      spaceId: sales._id,
      path: "pricing",
      content: "---\ntype: Doc\ntitle: Pricing\n---\n\nbody",
    });

    const eDocs = await svc.listSpacePages(eng._id);
    const sDocs = await svc.listSpacePages(sales._id);
    const runbookId = eDocs.find((d) => d.path === "runbook")?._id as string;
    const pricingId = sDocs.find((d) => d.path === "pricing")?._id as string;

    // Same-space backlink: On-call → Runbook.
    expect((await svc.getBacklinks(runbookId))?.map((b) => b.title)).toEqual(["On-call"]);

    // Cross-space backlink: Engineering/Runbook → Sales/Pricing (matched by name + path).
    const pricingBacklinks = await svc.getBacklinks(pricingId);
    expect(pricingBacklinks?.map((b) => b.title)).toEqual(["Runbook"]);
    expect(pricingBacklinks?.[0]?.spaceName).toBe("Engineering");

    // listAllPages spans every space (feeds the @-mention Pages section).
    const pages = await svc.listAllPages();
    expect(pages.map((p) => `${p.spaceName}/${p.path}`).sort()).toEqual([
      "Engineering/oncall",
      "Engineering/runbook",
      "Sales/pricing",
    ]);
  });

  it("snapshots a revision only when an existing page's content changes", async () => {
    const b = await seedSpace();
    const v1 = "---\ntype: Doc\ntitle: Note\n---\n\nfirst";
    const created = await svc.writePage({ spaceId: b._id, path: "note", content: v1 });
    const pageId = (created as { page: { _id: string } }).page._id;
    // Create produced no prior → no revision.
    expect(await svc.listRevisions(pageId)).toHaveLength(0);
    // Re-writing identical content is silent.
    await svc.writePage({ spaceId: b._id, path: "note", content: v1 });
    expect(await svc.listRevisions(pageId)).toHaveLength(0);
    // A real change snapshots the prior body, with a null reason for ordinary edits.
    await svc.writePage({
      spaceId: b._id,
      path: "note",
      content: "---\ntype: Doc\ntitle: Note\n---\n\nsecond",
    });
    const revs = await svc.listRevisions(pageId);
    expect(revs).toHaveLength(1);
    expect(revs[0]?.content).toContain("first");
    expect(revs[0]?.reason).toBeNull();
  });

  it("exposes cross-space target fields on graph edges", async () => {
    const eng = await seedSpace("Engineering");
    const sales = await seedSpace("Sales");
    await svc.writePage({
      spaceId: eng._id,
      path: "runbook",
      content: "---\ntype: Playbook\ntitle: Runbook\n---\n\n[p](tf:page/Sales/pricing).",
    });
    const graph = await svc.getSpaceGraph(eng._id);
    const edge = graph?.edges.find((e) => e.targetSpaceName === "Sales");
    expect(edge).toBeTruthy();
    expect(edge?.targetSpaceId).toBe(sales._id);
  });

  it("rewrites inbound cross-space links + snapshots a tagged revision on rename", async () => {
    const eng = await seedSpace("Engineering");
    const sales = await seedSpace("Sales");
    await svc.writePage({
      spaceId: eng._id,
      path: "runbook",
      content: "---\ntype: Playbook\ntitle: Runbook\n---\n\nSee [pricing](tf:page/Sales/pricing).",
    });
    await svc.writePage({
      spaceId: sales._id,
      path: "pricing",
      content: "---\ntype: Doc\ntitle: Pricing\n---\n\nbody",
    });

    expect((await svc.updateSpace(sales._id, { name: "Revenue" }))?.name).toBe("Revenue");

    const runbook = (await svc.listSpacePages(eng._id)).find((d) => d.path === "runbook");
    expect(runbook?.content).toContain("tf:page/Revenue/pricing");
    expect(runbook?.content).not.toContain("tf:page/Sales/pricing");
    const revs = await svc.listRevisions(runbook?._id as string);
    expect(revs.some((r) => r.reason?.includes("space renamed"))).toBe(true);

    // The renamed Revenue/pricing still sees the runbook as a backlink (link re-resolved by id).
    const pricingId = (await svc.listSpacePages(sales._id)).find((d) => d.path === "pricing")
      ?._id as string;
    expect((await svc.getBacklinks(pricingId))?.map((bl) => bl.title)).toEqual(["Runbook"]);
  });

  it("excludes soft-deleted sources from backlinks", async () => {
    const b = await seedSpace();
    await svc.writePage({
      spaceId: b._id,
      path: "target",
      content: "---\ntype: Doc\ntitle: Target\n---\n\nbody",
    });
    await svc.writePage({
      spaceId: b._id,
      path: "source",
      content: "---\ntype: Doc\ntitle: Source\n---\n\nSee [t](target.md).",
    });
    const docs = await svc.listSpacePages(b._id);
    const targetId = docs.find((d) => d.path === "target")?._id as string;
    const sourceId = docs.find((d) => d.path === "source")?._id as string;

    // Baseline: Source is a backlink of Target.
    expect((await svc.getBacklinks(targetId))?.map((x) => x.title)).toEqual(["Source"]);

    // Soft-deleting the source removes it from Target's "Linked from" (its link rows persist).
    await svc.deletePage(sourceId);
    expect((await svc.getBacklinks(targetId))?.map((x) => x.title)).toEqual([]);
  });

  it("treats a link to a soft-deleted target as broken on re-resolution", async () => {
    const b = await seedSpace();
    await svc.writePage({
      spaceId: b._id,
      path: "target",
      content: "---\ntype: Doc\ntitle: Target\n---\n\nbody",
    });
    await svc.writePage({
      spaceId: b._id,
      path: "source",
      content: "---\ntype: Doc\ntitle: Source\n---\n\n[t](target.md).",
    });
    const targetId = (await svc.listSpacePages(b._id)).find((d) => d.path === "target")
      ?._id as string;
    await svc.deletePage(targetId);
    // Re-writing the source re-extracts its links; the deleted target must not resolve.
    await svc.writePage({
      spaceId: b._id,
      path: "source",
      content: "---\ntype: Doc\ntitle: Source\n---\n\n[t](target.md). v2",
    });
    const docs = await svc.listSpacePages(b._id);
    const sourceId = docs.find((d) => d.path === "source")?._id;
    expect(docs.map((d) => d.path)).toEqual(["source"]); // target is gone (inactive)
    expect(
      (await svc.getSpaceGraph(b._id))?.edges.find((e) => e.sourceId === sourceId)?.broken
    ).toBe(true);
  });

  it("does not resurrect a soft-deleted page when its target space is renamed", async () => {
    const eng = await seedSpace("Engineering");
    const sales = await seedSpace("Sales");
    await svc.writePage({
      spaceId: eng._id,
      path: "runbook",
      content: "---\ntype: Playbook\ntitle: Runbook\n---\n\n[p](tf:page/Sales/pricing).",
    });
    await svc.writePage({
      spaceId: sales._id,
      path: "pricing",
      content: "---\ntype: Doc\ntitle: Pricing\n---\n\nbody",
    });
    const runbookId = (await svc.listSpacePages(eng._id)).find((d) => d.path === "runbook")
      ?._id as string;
    expect(await svc.deletePage(runbookId)).toBe(true);

    await svc.updateSpace(sales._id, { name: "Revenue" });

    // The rename's link rewrite must skip the soft-deleted source rather than re-activating it.
    expect((await svc.getPage(runbookId))?.active).toBe(false);
  });

  it("rejects renaming a space onto an existing name", async () => {
    await seedSpace("Engineering");
    const sales = await seedSpace("Sales");
    await expect(svc.updateSpace(sales._id, { name: "Engineering" })).rejects.toThrow(
      /already in use/
    );
  });

  it("summarizes spaces with page counts + recent pages, excluding soft-deleted", async () => {
    const a = await seedSpace("Alpha");
    const b = await seedSpace("Bravo");
    const doc = (title: string) => `---\ntype: Doc\ntitle: ${title}\n---\n\nbody`;
    await svc.writePage({ spaceId: a._id, path: "one", content: doc("One") });
    await svc.writePage({ spaceId: a._id, path: "two", content: doc("Two") });
    await svc.writePage({ spaceId: b._id, path: "solo", content: doc("Solo") });
    const twoId = (await svc.listSpacePages(a._id)).find((d) => d.path === "two")?._id as string;
    await svc.deletePage(twoId); // soft-deleted → drops from count + recent

    const { spaces, recent } = await svc.getKnowledgeOverview(8);

    const byName = new Map(spaces.map((s) => [s.space.name, s]));
    expect(byName.get("Alpha")?.pageCount).toBe(1); // "two" deleted, "one" remains
    expect(byName.get("Bravo")?.pageCount).toBe(1);
    // lastActivity reflects the latest page edit (never older than the space's own update).
    expect(byName.get("Alpha")?.lastActivity.getTime()).toBeGreaterThanOrEqual(
      a.updatedAt.getTime()
    );

    const titles = recent.map((p) => p.title);
    expect(titles).toContain("One");
    expect(titles).toContain("Solo");
    expect(titles).not.toContain("Two"); // soft-deleted excluded
    expect(recent.every((p) => p.path !== "" && p.spaceName !== "")).toBe(true);
  });
});
