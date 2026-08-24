import { describe, expect, it, vi } from "vitest";
import type { PageReadAuthorizer } from "./page-access";
import type { KnowledgeService } from "./service";
import { KNOWLEDGE_TOOLS, type KnowledgeToolContext } from "./tools";
import type { QueryKnowledgeHit } from "./types";

type KnowledgeTool = (typeof KNOWLEDGE_TOOLS)[number];

function getTool(name: string): KnowledgeTool {
  const t = KNOWLEDGE_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

/**
 * Authorizes everything. This suite asserts Tool shape and routing, not access control — that is
 * `apps/api/src/knowledge/tool-page-access.pg.test.ts`, which runs the real gate.
 */
const allowAll: PageReadAuthorizer = {
  canRead: async () => true,
  canReadSpace: async () => true,
  readablePageIds: async (_userId, pageIds) => ({ allowed: [...pageIds], excluded: 0 }),
  readableSpaceIds: async (_userId, spaceIds) => [...spaceIds],
};

function ctx(service: Partial<KnowledgeService>): KnowledgeToolContext {
  return { userId: "u1", service: service as KnowledgeService, pageGate: allowAll };
}

function expectNoMalformedTargets(toolName: string, args: unknown): void {
  const tool = getTool(toolName);
  expect(() => tool.targetsFor(args)).not.toThrow();
  for (const ref of tool.targetsFor(args)) {
    expect(ref.type).not.toMatch(/undefined|null/);
    expect(ref.id).not.toMatch(/undefined|null/);
  }
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
      "list_governance_pages",
      "list_spaces",
      "navigate_space",
      "query_knowledge",
      "write_page",
    ]);
  });

  it("target derivations tolerate empty and unexpected raw arguments", () => {
    for (const name of [
      "query_knowledge",
      "cite_sources",
      "write_page",
      "navigate_space",
      "get_page_by_path",
      "get_page",
      "get_backlinks",
      "get_space_graph",
      "list_spaces",
    ]) {
      expectNoMalformedTargets(name, {});
      expectNoMalformedTargets(name, { unexpected: true });
      expectNoMalformedTargets(name, null);
    }
  });

  it("write_page and get_page_by_path derive only determined page path targets", () => {
    for (const name of ["write_page", "get_page_by_path"]) {
      const tool = getTool(name);
      expect(tool.targetsFor({ spaceId: "s1" })).toEqual([
        { type: "platform.knowledge", id: "space:s1" },
      ]);
      expect(tool.targetsFor({ path: "handbook" })).toEqual([]);
      expect(tool.targetsFor({ spaceId: { id: "s1" }, path: "handbook" })).toEqual([]);
      expect(tool.targetsFor({ spaceId: "s1", path: "handbook" })).toEqual([
        { type: "platform.knowledge", id: "space:s1" },
        { type: "platform.knowledge", id: "path:s1:handbook" },
      ]);
    }
  });

  it("cite_sources target derivation ignores non-array citations and non-string pageIds", () => {
    const tool = getTool("cite_sources");
    expect(tool.targetsFor({ citations: "x" })).toEqual([]);
    expect(
      tool.targetsFor({ citations: [{ pageId: { id: "p1" } }, null, { pageId: "p1" }] })
    ).toEqual([{ type: "platform.knowledge", id: "page:p1" }]);
  });

  it("query_knowledge uses a space target only for valid UUID filters", () => {
    const tool = getTool("query_knowledge");
    const uuid = "cf653c1b-e20a-4edd-81ec-dc92c7ae193f";

    expect(tool.targetsFor({ query: "sla", spaceId: uuid })).toEqual([
      { type: "platform.knowledge", id: `space:${uuid}` },
    ]);
    expect(tool.targetsFor({ query: "sla" })).toEqual([]);
    expect(tool.targetsFor({ query: "sla", spaceId: "global" })).toEqual([]);
    expect(tool.targetsFor({ query: "sla", spaceId: 7 })).toEqual([]);
  });

  it("list_spaces stays at the coarse knowledge catalog scope", () => {
    const tool = getTool("list_spaces");

    expect(tool.targetsFor({})).toEqual([]);
    expect(tool.targetsFor(null)).toEqual([]);
    expect(tool.authorization.resources).toEqual(["platform.knowledge"]);
  });

  it("query_knowledge forwards a valid UUID spaceId filter to the service", async () => {
    const hybridSearchPages = vi.fn(async () => ({ results: [], warnings: [] }));
    const uuid = "cf653c1b-e20a-4edd-81ec-dc92c7ae193f";
    await getTool("query_knowledge").handler(
      { query: "sla", spaceId: uuid },
      ctx({ hybridSearchPages } as never)
    );
    expect(hybridSearchPages).toHaveBeenCalledWith(
      "sla",
      expect.objectContaining({ spaceId: uuid }),
      expect.any(Number),
      expect.objectContaining({ principalId: "u1" })
    );
  });

  it("query_knowledge normalizes placeholder filters: ignores non-UUID spaceId and blank domain", async () => {
    const hybridSearchPages = vi.fn(async () => ({ results: [], warnings: [] }));
    // Agents often fill optional params with placeholders ("global", "default", "", "*").
    const res = await getTool("query_knowledge").handler(
      { query: "pooling", spaceId: "global", domain: "", tags: [] },
      ctx({ hybridSearchPages } as never)
    );
    expect(hybridSearchPages).toHaveBeenCalledWith(
      "pooling",
      { spaceId: undefined, domain: undefined, tags: undefined },
      expect.any(Number),
      expect.objectContaining({ principalId: "u1" })
    );
    // No throw, and the dropped spaceId is surfaced as a debuggable warning.
    expect(res).toMatchObject({ success: true });
    expect((res as { data: { warnings: string[] } }).data.warnings).toContain(
      "ignored-invalid-spaceId"
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

  it("cite_sources resolves pageIds to refs (wiki url + path for space pages) and dedups by pageId", async () => {
    // getActivePage already filters soft-deleted/missing → returns null for those.
    const getActivePage = vi.fn(async (id: string) =>
      id === "page-1"
        ? { _id: "page-1", title: "Orders", spaceId: "b1", path: "tables/orders" }
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
    // Space page → wiki url + path; flat page → no url/path key; soft-deleted + missing → dropped; dup deduped.
    expect(res).toEqual({
      success: true,
      data: {
        sources: [
          {
            ref: 1,
            id: "page-1",
            title: "Orders",
            url: "/knowledge/pages/page-1",
            path: "tables/orders",
          },
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

  it("query_knowledge validates input and returns page-level hits (no chunkId)", async () => {
    const hits: QueryKnowledgeHit[] = [
      {
        pageId: "d1",
        title: "France",
        snippet: "Paris is the capital",
        source: "authored",
        origin: "okf",
        score: 0.9,
        path: "geo/france",
        spaceId: "b1",
      },
      {
        pageId: "d2",
        title: "Memo",
        snippet: "flat page",
        source: "conversation",
        origin: "okf",
        score: 0.5,
      },
    ];
    const hybridSearchPages = vi.fn(async () => ({ results: hits, warnings: [] }));
    const t = getTool("query_knowledge");
    expect(await t.handler({}, ctx({}))).toMatchObject({
      success: false,
      error: { code: "validation_error" },
    });
    const good = await t.handler({ query: "france" }, ctx({ hybridSearchPages } as never));
    expect(good).toMatchObject({ success: true, data: { results: hits, warnings: [] } });
    expect(hybridSearchPages).toHaveBeenCalled();
    // Page-level hits carry no chunkId.
    const results = (good as { data: { results: QueryKnowledgeHit[] } }).data.results;
    for (const hit of results) expect(hit).not.toHaveProperty("chunkId");
  });

  it("create_knowledge_page validates and returns the id", async () => {
    const stored = { _id: "doc-1", title: "T", spaceId: "space-1", path: "t" };
    const createPage = vi.fn(async () => stored);
    const getActivePage = vi.fn(async () => stored);
    const t = getTool("create_knowledge_page");
    expect(await t.handler({ title: "T" }, ctx({}))).toMatchObject({ success: false });
    const res = await t.handler(
      { title: "T", content: "body" },
      ctx({ createPage, getActivePage } as never)
    );
    expect(res).toMatchObject({ success: true, data: { id: "doc-1", spaceId: "space-1" } });
  });

  /**
   * A Page the reader's own paths cannot reach is not a created Page. Reporting success for one is
   * how an Agent comes to believe it wrote content that nothing can later cite.
   */
  it("create_knowledge_page fails rather than reporting a Page no reader can reach", async () => {
    const t = getTool("create_knowledge_page");
    const unplaced = { _id: "doc-1", title: "T", spaceId: null, path: null };
    const placed = { _id: "doc-1", title: "T", spaceId: "space-1", path: "t" };

    const noPlace = await t.handler(
      { title: "T", content: "body" },
      ctx({ createPage: async () => unplaced, getActivePage: async () => unplaced } as never)
    );
    const noRead = await getTool("create_knowledge_page").handler({ title: "T", content: "body" }, {
      userId: "u1",
      service: { createPage: async () => placed, getActivePage: async () => placed },
      pageGate: { ...allowAll, canRead: async () => false },
    } as never);

    expect(noPlace).toMatchObject({ success: false, error: { message: "page_not_placed" } });
    expect(noRead).toMatchObject({ success: false, error: { message: "page_not_readable" } });
  });

  it("returns internal_error (never throws) when the service fails", async () => {
    const hybridSearchPages = vi.fn(async () => {
      throw new Error("db down");
    });
    const res = await getTool("query_knowledge").handler(
      { query: "x" },
      ctx({ hybridSearchPages } as never)
    );
    expect(res).toMatchObject({
      success: false,
      error: { code: "internal_error", message: "db down" },
    });
  });
});
