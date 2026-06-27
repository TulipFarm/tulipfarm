import { describe, expect, it, vi } from "vitest";
import type { KnowledgeService } from "./service";
import { KNOWLEDGE_TOOLS, type KnowledgeTool, type KnowledgeToolContext } from "./tools";

function getTool(name: string): KnowledgeTool {
  const t = KNOWLEDGE_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

function ctx(service: Partial<KnowledgeService>): KnowledgeToolContext {
  return { userId: "u1", service: service as KnowledgeService };
}

describe("knowledge tools", () => {
  it("exposes the knowledge + OKF bundle tools", () => {
    expect(KNOWLEDGE_TOOLS.map((t) => t.name).sort()).toEqual([
      "cite_sources",
      "create_bundle",
      "create_knowledge_collection",
      "create_knowledge_document",
      "get_backlinks",
      "get_bundle_graph",
      "get_concept_by_path",
      "get_document",
      "list_bundles",
      "list_knowledge_collections",
      "navigate_bundle",
      "query_knowledge",
      "write_concept",
    ]);
  });

  it("query_knowledge forwards an optional bundleId filter to the service", async () => {
    const search = vi.fn(async () => ({ results: [], warnings: [] }));
    await getTool("query_knowledge").handler(
      { query: "sla", bundleId: "b1" },
      ctx({ search } as never)
    );
    expect(search).toHaveBeenCalledWith(
      "sla",
      expect.objectContaining({ bundleId: "b1" }),
      expect.any(Number),
      expect.anything()
    );
  });

  it("get_concept_by_path returns an active concept, else not_found (incl. soft-deleted)", async () => {
    const getConceptByPath = vi.fn(async (_b: string, p: string) =>
      p === "tables/orders"
        ? {
            _id: "d1",
            title: "Orders",
            content: "# Orders",
            bundleId: "b1",
            path: "tables/orders",
            active: true,
          }
        : p === "tables/gone"
          ? {
              _id: "d9",
              title: "Gone",
              content: "x",
              bundleId: "b1",
              path: "tables/gone",
              active: false,
            }
          : null
    );
    const t = getTool("get_concept_by_path");
    expect(await t.handler({ bundleId: "b1" }, ctx({}))).toMatchObject({ success: false });
    const ok = await t.handler(
      { bundleId: "b1", path: "tables/orders" },
      ctx({ getConceptByPath } as never)
    );
    expect(ok).toMatchObject({ success: true, data: { id: "d1", content: "# Orders" } });
    // Missing AND soft-deleted both read as not_found.
    for (const path of ["nope", "tables/gone"]) {
      expect(
        await t.handler({ bundleId: "b1", path }, ctx({ getConceptByPath } as never))
      ).toMatchObject({ success: false, error: { code: "not_found" } });
    }
  });

  it("get_document returns active content with a wiki url, else not_found (incl. soft-deleted)", async () => {
    // getActiveDocument already filters soft-deleted → the tool just null-checks the result.
    const getActiveDocument = vi.fn(async (id: string) =>
      id === "d1" ? { _id: "d1", title: "Orders", content: "# Orders", bundleId: "b1" } : null
    );
    const t = getTool("get_document");
    const ok = await t.handler({ documentId: "d1" }, ctx({ getActiveDocument } as never));
    expect(ok).toMatchObject({
      success: true,
      data: { id: "d1", content: "# Orders", url: "/knowledge/concepts/d1" },
    });
    // Missing AND soft-deleted both read as not_found.
    for (const documentId of ["x", "deleted"]) {
      expect(await t.handler({ documentId }, ctx({ getActiveDocument } as never))).toMatchObject({
        success: false,
        error: { code: "not_found" },
      });
    }
  });

  it("get_backlinks returns links or not_found for non-OKF docs", async () => {
    const getBacklinks = vi.fn(async (id: string) =>
      id === "d1"
        ? [{ sourceId: "s1", title: "FAQ", path: "faq", bundleId: "b1", bundleName: "KB" }]
        : null
    );
    const t = getTool("get_backlinks");
    expect(await t.handler({ documentId: "d1" }, ctx({ getBacklinks } as never))).toMatchObject({
      success: true,
      data: { backlinks: [{ sourceId: "s1" }] },
    });
    expect(await t.handler({ documentId: "flat" }, ctx({ getBacklinks } as never))).toMatchObject({
      success: false,
      error: { code: "not_found" },
    });
  });

  it("get_bundle_graph returns the graph or not_found", async () => {
    const getBundleGraph = vi.fn(async (id: string) =>
      id === "b1"
        ? { nodes: [{ id: "d1", path: "p", title: "T" }], edges: [], truncated: false }
        : null
    );
    const t = getTool("get_bundle_graph");
    expect(await t.handler({ bundleId: "b1" }, ctx({ getBundleGraph } as never))).toMatchObject({
      success: true,
      data: { graph: { nodes: [{ id: "d1" }] } },
    });
    expect(
      await t.handler({ bundleId: "missing" }, ctx({ getBundleGraph } as never))
    ).toMatchObject({ success: false, error: { code: "not_found" } });
  });

  it("cite_sources resolves documentIds to refs (wiki url only for concepts) and dedups by documentId", async () => {
    // getActiveDocument already filters soft-deleted/missing → returns null for those.
    const getActiveDocument = vi.fn(async (id: string) =>
      id === "concept-1"
        ? { _id: "concept-1", title: "Orders", bundleId: "b1" }
        : id === "flat-1"
          ? { _id: "flat-1", title: "Memo", bundleId: null }
          : null
    );
    const res = await getTool("cite_sources").handler(
      {
        citations: [
          { ref: 1, documentId: "concept-1" },
          { ref: 2, documentId: "flat-1" },
          { ref: 3, documentId: "deleted-1" },
          { ref: 4, documentId: "missing" },
          { ref: 5, documentId: "concept-1" }, // same page again → must list once (first ref kept)
        ],
      },
      ctx({ getActiveDocument } as never)
    );
    // Concept → wiki url; flat doc → no url key; soft-deleted + missing → dropped; dup deduped.
    expect(res).toEqual({
      success: true,
      data: {
        sources: [
          { ref: 1, id: "concept-1", title: "Orders", url: "/knowledge/concepts/concept-1" },
          { ref: 2, id: "flat-1", title: "Memo" },
        ],
      },
    });
  });

  it("cite_sources rejects empty or invalid input", async () => {
    expect(await getTool("cite_sources").handler({}, ctx({}))).toMatchObject({
      success: false,
      error: { code: "validation_error" },
    });
    expect(
      await getTool("cite_sources").handler({ citations: [{ ref: 0, documentId: "x" }] }, ctx({}))
    ).toMatchObject({ success: false, error: { code: "validation_error" } });
    expect(
      await getTool("cite_sources").handler({ citations: [{ ref: 1 }] }, ctx({}))
    ).toMatchObject({ success: false, error: { code: "validation_error" } });
  });

  it("query_knowledge validates input and returns results", async () => {
    const search = vi.fn(async () => ({
      results: [
        { documentId: "d", chunkId: "c", title: "T", content: "x", source: "authored", score: 0.9 },
      ],
      warnings: [],
    }));
    const t = getTool("query_knowledge");
    expect(await t.handler({}, ctx({}))).toMatchObject({
      success: false,
      error: { code: "validation_error" },
    });
    const good = await t.handler({ query: "france" }, ctx({ search } as never));
    expect(good).toMatchObject({ success: true });
    expect(search).toHaveBeenCalled();
  });

  it("create_knowledge_document validates and returns the id", async () => {
    const createDocument = vi.fn(async () => ({ _id: "doc-1", title: "T" }));
    const t = getTool("create_knowledge_document");
    expect(await t.handler({ title: "T" }, ctx({}))).toMatchObject({ success: false });
    const res = await t.handler({ title: "T", content: "body" }, ctx({ createDocument } as never));
    expect(res).toMatchObject({ success: true, data: { id: "doc-1" } });
  });

  it("create_knowledge_collection returns the id", async () => {
    const createCollection = vi.fn(async () => ({ _id: "col-1", name: "kb" }));
    const res = await getTool("create_knowledge_collection").handler(
      { name: "kb" },
      ctx({ createCollection } as never)
    );
    expect(res).toMatchObject({ success: true, data: { id: "col-1", name: "kb" } });
  });

  it("list_knowledge_collections returns collections", async () => {
    const listCollections = vi.fn(async () => ({
      items: [{ _id: "c1", name: "kb", description: null, domain: null }],
      nextCursor: null,
    }));
    const res = await getTool("list_knowledge_collections").handler(
      {},
      ctx({ listCollections } as never)
    );
    const data = (res as { success: true; data: { collections: unknown[] } }).data;
    expect(data.collections).toHaveLength(1);
  });

  it("returns internal_error (never throws) when the service fails", async () => {
    const search = vi.fn(async () => {
      throw new Error("db down");
    });
    const res = await getTool("query_knowledge").handler({ query: "x" }, ctx({ search } as never));
    expect(res).toMatchObject({
      success: false,
      error: { code: "internal_error", message: "db down" },
    });
  });
});
