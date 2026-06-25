import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
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
import { KnowledgeService } from "./service";
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
    documents: new PgKnowledgeDocumentRepo(db),
    chunks: new PgKnowledgeChunkRepo(db),
    collections: new PgKnowledgeCollectionRepo(db),
    revisions: new PgKnowledgeRevisionRepo(db),
    bundles: new PgKnowledgeBundleRepo(db),
    links: new PgKnowledgeLinksRepo(db),
    overrides: new PgKnowledgeBundleOverrideRepo(db),
    embeddings: lexicalOnly(),
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

  async function seedBundle(name = "sales") {
    const r = await svc.createBundle({ name });
    if (!r.ok) throw new Error(r.reason);
    return r.bundle;
  }

  it("creates a bundle and rejects a duplicate name", async () => {
    const b = await seedBundle();
    expect(b.name).toBe("sales");
    expect(await svc.createBundle({ name: "sales" })).toEqual({ ok: false, reason: "name_taken" });
  });

  it("returns bundle_not_found for a write to an unknown bundle", async () => {
    expect(
      await svc.writeConcept({ bundleId: randomUUID(), path: "x", content: CUSTOMERS })
    ).toEqual({ ok: false, reason: "bundle_not_found" });
  });

  it("accepts type-less content (no required frontmatter)", async () => {
    const b = await seedBundle();
    expect(
      (await svc.writeConcept({ bundleId: b._id, path: "bare", content: "just a body" })).ok
    ).toBe(true);
  });

  it("writes concepts, resolves cross-links, and navigates the tree", async () => {
    const b = await seedBundle();
    await svc.writeConcept({ bundleId: b._id, path: "tables/customers", content: CUSTOMERS });
    expect(
      (await svc.writeConcept({ bundleId: b._id, path: "tables/orders", content: ORDERS })).ok
    ).toBe(true);

    expect(await svc.navigateBundle(b._id, "")).toContain("[tables](tables/)");
    const tables = await svc.navigateBundle(b._id, "tables");
    expect(tables).toContain("[Orders](orders.md)");
    expect(tables).toContain("[Customers](customers.md)");

    const graph = await svc.getBundleGraph(b._id);
    expect(graph?.edges).toHaveLength(1);
    expect(graph?.edges[0]?.broken).toBe(false);
    expect(graph?.nodes.map((n) => n.path).sort()).toEqual(["tables/customers", "tables/orders"]);
  });

  it("expands search hits to linked neighbors", async () => {
    const b = await seedBundle();
    await svc.writeConcept({ bundleId: b._id, path: "tables/customers", content: CUSTOMERS });
    await svc.writeConcept({ bundleId: b._id, path: "tables/orders", content: ORDERS });

    const plain = await svc.search("Schema", {}, 10);
    const expanded = await svc.search("Schema", {}, 10, { expandGraph: true });
    expect(expanded.results.length).toBeGreaterThanOrEqual(plain.results.length);

    const docs = await svc.listBundleDocuments(b._id);
    const customersId = docs.find((d) => d.path === "tables/customers")?._id;
    expect(new Set(expanded.results.map((r) => r.documentId)).has(customersId as string)).toBe(
      true
    );
  });

  it("stores a reserved index path as an override that navigate honors", async () => {
    const b = await seedBundle();
    expect(
      await svc.writeConcept({ bundleId: b._id, path: "index", content: "# Hand-written root" })
    ).toEqual({ ok: true, override: true });
    expect(await svc.navigateBundle(b._id, "")).toBe("# Hand-written root");
  });

  it("resolves cross-space links and exposes backlinks across bundles", async () => {
    const eng = await seedBundle("Engineering");
    const sales = await seedBundle("Sales");

    // An Engineering page links cross-space to a Sales page that doesn't exist yet.
    await svc.writeConcept({
      bundleId: eng._id,
      path: "runbook",
      content:
        "---\ntype: Playbook\ntitle: Runbook\n---\n\nPricing: [pricing](tf:page/Sales/pricing).",
    });
    // A same-space page links to the runbook.
    await svc.writeConcept({
      bundleId: eng._id,
      path: "oncall",
      content: "---\ntype: Playbook\ntitle: On-call\n---\n\nSee the [runbook](runbook.md).",
    });
    // Create the Sales target.
    await svc.writeConcept({
      bundleId: sales._id,
      path: "pricing",
      content: "---\ntype: Doc\ntitle: Pricing\n---\n\nbody",
    });

    const eDocs = await svc.listBundleDocuments(eng._id);
    const sDocs = await svc.listBundleDocuments(sales._id);
    const runbookId = eDocs.find((d) => d.path === "runbook")?._id as string;
    const pricingId = sDocs.find((d) => d.path === "pricing")?._id as string;

    // Same-space backlink: On-call → Runbook.
    expect((await svc.getBacklinks(runbookId))?.map((b) => b.title)).toEqual(["On-call"]);

    // Cross-space backlink: Engineering/Runbook → Sales/Pricing (matched by name + path).
    const pricingBacklinks = await svc.getBacklinks(pricingId);
    expect(pricingBacklinks?.map((b) => b.title)).toEqual(["Runbook"]);
    expect(pricingBacklinks?.[0]?.bundleName).toBe("Engineering");

    // listAllPages spans every bundle (feeds the @-mention Pages section).
    const pages = await svc.listAllPages();
    expect(pages.map((p) => `${p.bundleName}/${p.path}`).sort()).toEqual([
      "Engineering/oncall",
      "Engineering/runbook",
      "Sales/pricing",
    ]);
  });

  it("snapshots a revision only when an existing concept's content changes", async () => {
    const b = await seedBundle();
    const v1 = "---\ntype: Doc\ntitle: Note\n---\n\nfirst";
    const created = await svc.writeConcept({ bundleId: b._id, path: "note", content: v1 });
    const docId = (created as { document: { _id: string } }).document._id;
    // Create produced no prior → no revision.
    expect(await svc.listRevisions(docId)).toHaveLength(0);
    // Re-writing identical content is silent.
    await svc.writeConcept({ bundleId: b._id, path: "note", content: v1 });
    expect(await svc.listRevisions(docId)).toHaveLength(0);
    // A real change snapshots the prior body, with a null reason for ordinary edits.
    await svc.writeConcept({
      bundleId: b._id,
      path: "note",
      content: "---\ntype: Doc\ntitle: Note\n---\n\nsecond",
    });
    const revs = await svc.listRevisions(docId);
    expect(revs).toHaveLength(1);
    expect(revs[0]?.content).toContain("first");
    expect(revs[0]?.reason).toBeNull();
  });

  it("exposes cross-space target fields on graph edges", async () => {
    const eng = await seedBundle("Engineering");
    const sales = await seedBundle("Sales");
    await svc.writeConcept({
      bundleId: eng._id,
      path: "runbook",
      content: "---\ntype: Playbook\ntitle: Runbook\n---\n\n[p](tf:page/Sales/pricing).",
    });
    const graph = await svc.getBundleGraph(eng._id);
    const edge = graph?.edges.find((e) => e.targetBundleName === "Sales");
    expect(edge).toBeTruthy();
    expect(edge?.targetBundleId).toBe(sales._id);
  });

  it("rewrites inbound cross-space links + snapshots a tagged revision on rename", async () => {
    const eng = await seedBundle("Engineering");
    const sales = await seedBundle("Sales");
    await svc.writeConcept({
      bundleId: eng._id,
      path: "runbook",
      content: "---\ntype: Playbook\ntitle: Runbook\n---\n\nSee [pricing](tf:page/Sales/pricing).",
    });
    await svc.writeConcept({
      bundleId: sales._id,
      path: "pricing",
      content: "---\ntype: Doc\ntitle: Pricing\n---\n\nbody",
    });

    expect((await svc.updateBundle(sales._id, { name: "Revenue" }))?.name).toBe("Revenue");

    const runbook = (await svc.listBundleDocuments(eng._id)).find((d) => d.path === "runbook");
    expect(runbook?.content).toContain("tf:page/Revenue/pricing");
    expect(runbook?.content).not.toContain("tf:page/Sales/pricing");
    const revs = await svc.listRevisions(runbook?._id as string);
    expect(revs.some((r) => r.reason?.includes("bundle renamed"))).toBe(true);

    // The renamed Revenue/pricing still sees the runbook as a backlink (link re-resolved by id).
    const pricingId = (await svc.listBundleDocuments(sales._id)).find((d) => d.path === "pricing")
      ?._id as string;
    expect((await svc.getBacklinks(pricingId))?.map((bl) => bl.title)).toEqual(["Runbook"]);
  });

  it("excludes soft-deleted sources from backlinks", async () => {
    const b = await seedBundle();
    await svc.writeConcept({
      bundleId: b._id,
      path: "target",
      content: "---\ntype: Doc\ntitle: Target\n---\n\nbody",
    });
    await svc.writeConcept({
      bundleId: b._id,
      path: "source",
      content: "---\ntype: Doc\ntitle: Source\n---\n\nSee [t](target.md).",
    });
    const docs = await svc.listBundleDocuments(b._id);
    const targetId = docs.find((d) => d.path === "target")?._id as string;
    const sourceId = docs.find((d) => d.path === "source")?._id as string;

    // Baseline: Source is a backlink of Target.
    expect((await svc.getBacklinks(targetId))?.map((x) => x.title)).toEqual(["Source"]);

    // Soft-deleting the source removes it from Target's "Linked from" (its link rows persist).
    await svc.deleteDocument(sourceId);
    expect((await svc.getBacklinks(targetId))?.map((x) => x.title)).toEqual([]);
  });

  it("treats a link to a soft-deleted target as broken on re-resolution", async () => {
    const b = await seedBundle();
    await svc.writeConcept({
      bundleId: b._id,
      path: "target",
      content: "---\ntype: Doc\ntitle: Target\n---\n\nbody",
    });
    await svc.writeConcept({
      bundleId: b._id,
      path: "source",
      content: "---\ntype: Doc\ntitle: Source\n---\n\n[t](target.md).",
    });
    const targetId = (await svc.listBundleDocuments(b._id)).find((d) => d.path === "target")
      ?._id as string;
    await svc.deleteDocument(targetId);
    // Re-writing the source re-extracts its links; the deleted target must not resolve.
    await svc.writeConcept({
      bundleId: b._id,
      path: "source",
      content: "---\ntype: Doc\ntitle: Source\n---\n\n[t](target.md). v2",
    });
    const docs = await svc.listBundleDocuments(b._id);
    const sourceId = docs.find((d) => d.path === "source")?._id;
    expect(docs.map((d) => d.path)).toEqual(["source"]); // target is gone (inactive)
    expect(
      (await svc.getBundleGraph(b._id))?.edges.find((e) => e.sourceId === sourceId)?.broken
    ).toBe(true);
  });

  it("does not resurrect a soft-deleted page when its target bundle is renamed", async () => {
    const eng = await seedBundle("Engineering");
    const sales = await seedBundle("Sales");
    await svc.writeConcept({
      bundleId: eng._id,
      path: "runbook",
      content: "---\ntype: Playbook\ntitle: Runbook\n---\n\n[p](tf:page/Sales/pricing).",
    });
    await svc.writeConcept({
      bundleId: sales._id,
      path: "pricing",
      content: "---\ntype: Doc\ntitle: Pricing\n---\n\nbody",
    });
    const runbookId = (await svc.listBundleDocuments(eng._id)).find((d) => d.path === "runbook")
      ?._id as string;
    expect(await svc.deleteDocument(runbookId)).toBe(true);

    await svc.updateBundle(sales._id, { name: "Revenue" });

    // The rename's link rewrite must skip the soft-deleted source rather than re-activating it.
    expect((await svc.getDocument(runbookId))?.active).toBe(false);
  });

  it("rejects renaming a bundle onto an existing name", async () => {
    await seedBundle("Engineering");
    const sales = await seedBundle("Sales");
    await expect(svc.updateBundle(sales._id, { name: "Engineering" })).rejects.toThrow(
      /already in use/
    );
  });

  it("summarizes spaces with page counts + recent pages, excluding soft-deleted", async () => {
    const a = await seedBundle("Alpha");
    const b = await seedBundle("Bravo");
    const doc = (title: string) => `---\ntype: Doc\ntitle: ${title}\n---\n\nbody`;
    await svc.writeConcept({ bundleId: a._id, path: "one", content: doc("One") });
    await svc.writeConcept({ bundleId: a._id, path: "two", content: doc("Two") });
    await svc.writeConcept({ bundleId: b._id, path: "solo", content: doc("Solo") });
    const twoId = (await svc.listBundleDocuments(a._id)).find((d) => d.path === "two")
      ?._id as string;
    await svc.deleteDocument(twoId); // soft-deleted → drops from count + recent

    const { spaces, recent } = await svc.getKnowledgeOverview(8);

    const byName = new Map(spaces.map((s) => [s.bundle.name, s]));
    expect(byName.get("Alpha")?.pageCount).toBe(1); // "two" deleted, "one" remains
    expect(byName.get("Bravo")?.pageCount).toBe(1);
    // lastActivity reflects the latest page edit (never older than the bundle's own update).
    expect(byName.get("Alpha")?.lastActivity.getTime()).toBeGreaterThanOrEqual(
      a.updatedAt.getTime()
    );

    const titles = recent.map((p) => p.title);
    expect(titles).toContain("One");
    expect(titles).toContain("Solo");
    expect(titles).not.toContain("Two"); // soft-deleted excluded
    expect(recent.every((p) => p.path !== "" && p.bundleName !== "")).toBe(true);
  });
});
