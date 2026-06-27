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
  it("exposes the knowledge + OKF space tools", () => {
    expect(KNOWLEDGE_TOOLS.map((t) => t.name).sort()).toEqual([
      "cite_sources",
      "create_knowledge_page",
      "create_space",
      "get_backlinks",
      "get_page",
      "get_page_by_path",
      "get_space_graph",
      "list_spaces",
      "navigate_space",
      "query_knowledge",
      "write_page",
    ]);
  });

  it("query_knowledge forwards an optional spaceId filter to the service", async () => {
    const search = vi.fn(async () => ({ results: [], warnings: [] }));
    await getTool("query_knowledge").handler(
      { query: "sla", spaceId: "b1" },
      ctx({ search } as never)
    );
    expect(search).toHaveBeenCalledWith(
      "sla",
      expect.objectContaining({ spaceId: "b1" }),
      expect.any(Number),
      expect.anything()
    );
  });

  it("get_page_by_path returns an active page, else not_found (incl. soft-deleted)", async () => {
    const getPageByPath = vi.fn(async (_b: string, p: string) =>
      p === "tables/orders"
        ? {
            _id: "d1",
            title: "Orders",
            content: "# Orders",
            spaceId: "b1",
            path: "tables/orders",
            active: true,
          }
        : p === "tables/gone"
          ? {
              _id: "d9",
              title: "Gone",
              content: "x",
              spaceId: "b1",
              path: "tables/gone",
              active: false,
            }
          : null
    );
    const t = getTool("get_page_by_path");
    expect(await t.handler({ spaceId: "b1" }, ctx({}))).toMatchObject({ success: false });
    const ok = await t.handler(
      { spaceId: "b1", path: "tables/orders" },
      ctx({ getPageByPath } as never)
    );
    expect(ok).toMatchObject({ success: true, data: { id: "d1", content: "# Orders" } });
    // Missing AND soft-deleted both read as not_found.
    for (const path of ["nope", "tables/gone"]) {
      expect(
        await t.handler({ spaceId: "b1", path }, ctx({ getPageByPath } as never))
      ).toMatchObject({ success: false, error: { code: "not_found" } });
    }
  });

  it("get_page returns active content with a wiki url, else not_found (incl. soft-deleted)", async () => {
    // getActivePage already filters soft-deleted → the tool just null-checks the result.
    const getActivePage = vi.fn(async (id: string) =>
      id === "d1" ? { _id: "d1", title: "Orders", content: "# Orders", spaceId: "b1" } : null
    );
    const t = getTool("get_page");
    const ok = await t.handler({ pageId: "d1" }, ctx({ getActivePage } as never));
    expect(ok).toMatchObject({
      success: true,
      data: { id: "d1", content: "# Orders", url: "/knowledge/pages/d1" },
    });
    // Missing AND soft-deleted both read as not_found.
    for (const pageId of ["x", "deleted"]) {
      expect(await t.handler({ pageId }, ctx({ getActivePage } as never))).toMatchObject({
        success: false,
        error: { code: "not_found" },
      });
    }
  });

  it("get_backlinks returns links or not_found for non-OKF pages", async () => {
    const getBacklinks = vi.fn(async (id: string) =>
      id === "d1"
        ? [{ sourceId: "s1", title: "FAQ", path: "faq", spaceId: "b1", spaceName: "KB" }]
        : null
    );
    const t = getTool("get_backlinks");
    expect(await t.handler({ pageId: "d1" }, ctx({ getBacklinks } as never))).toMatchObject({
      success: true,
      data: { backlinks: [{ sourceId: "s1" }] },
    });
    expect(await t.handler({ pageId: "flat" }, ctx({ getBacklinks } as never))).toMatchObject({
      success: false,
      error: { code: "not_found" },
    });
  });

  it("get_space_graph returns the graph or not_found", async () => {
    const getSpaceGraph = vi.fn(async (id: string) =>
      id === "b1"
        ? { nodes: [{ id: "d1", path: "p", title: "T" }], edges: [], truncated: false }
        : null
    );
    const t = getTool("get_space_graph");
    expect(await t.handler({ spaceId: "b1" }, ctx({ getSpaceGraph } as never))).toMatchObject({
      success: true,
      data: { graph: { nodes: [{ id: "d1" }] } },
    });
    expect(await t.handler({ spaceId: "missing" }, ctx({ getSpaceGraph } as never))).toMatchObject({
      success: false,
      error: { code: "not_found" },
    });
  });

  it("cite_sources resolves pageIds to refs (wiki url only for space pages) and dedups by pageId", async () => {
    // getActivePage already filters soft-deleted/missing → returns null for those.
    const getActivePage = vi.fn(async (id: string) =>
      id === "page-1"
        ? { _id: "page-1", title: "Orders", spaceId: "b1" }
        : id === "flat-1"
          ? { _id: "flat-1", title: "Memo", spaceId: null }
          : null
    );
    const res = await getTool("cite_sources").handler(
      {
        citations: [
          { ref: 1, pageId: "page-1" },
          { ref: 2, pageId: "flat-1" },
          { ref: 3, pageId: "deleted-1" },
          { ref: 4, pageId: "missing" },
          { ref: 5, pageId: "page-1" }, // same page again → must list once (first ref kept)
        ],
      },
      ctx({ getActivePage } as never)
    );
    // Space page → wiki url; flat page → no url key; soft-deleted + missing → dropped; dup deduped.
    expect(res).toEqual({
      success: true,
      data: {
        sources: [
          { ref: 1, id: "page-1", title: "Orders", url: "/knowledge/pages/page-1" },
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
      await getTool("cite_sources").handler({ citations: [{ ref: 0, pageId: "x" }] }, ctx({}))
    ).toMatchObject({ success: false, error: { code: "validation_error" } });
    expect(
      await getTool("cite_sources").handler({ citations: [{ ref: 1 }] }, ctx({}))
    ).toMatchObject({ success: false, error: { code: "validation_error" } });
  });

  it("query_knowledge validates input and returns results", async () => {
    const search = vi.fn(async () => ({
      results: [
        { pageId: "d", chunkId: "c", title: "T", content: "x", source: "authored", score: 0.9 },
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

  it("create_knowledge_page validates and returns the id", async () => {
    const createPage = vi.fn(async () => ({ _id: "doc-1", title: "T" }));
    const t = getTool("create_knowledge_page");
    expect(await t.handler({ title: "T" }, ctx({}))).toMatchObject({ success: false });
    const res = await t.handler({ title: "T", content: "body" }, ctx({ createPage } as never));
    expect(res).toMatchObject({ success: true, data: { id: "doc-1" } });
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
