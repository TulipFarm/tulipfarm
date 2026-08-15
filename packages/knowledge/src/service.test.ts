import { describe, expect, it, vi } from "vitest";
import { search } from "./search-service";
import { KnowledgeService, type KnowledgeServiceDeps } from "./service";

vi.mock("./search-service", () => ({ search: vi.fn() }));

describe("KnowledgeService.getPageByPath", () => {
  it("normalizes the path (strips leading/trailing slash + .md) before the space lookup", async () => {
    const getBySpacePath = vi.fn(async () => null);
    const svc = new KnowledgeService({
      pages: { getBySpacePath },
    } as unknown as KnowledgeServiceDeps);

    await svc.getPageByPath("s1", "/tables/orders.md");
    expect(getBySpacePath).toHaveBeenCalledWith("s1", "tables/orders");

    await svc.getPageByPath("s1", "tables/orders");
    expect(getBySpacePath).toHaveBeenLastCalledWith("s1", "tables/orders");
  });

  it("returns the page the repo resolves", async () => {
    const page = { _id: "d1", title: "Orders" };
    const svc = new KnowledgeService({
      pages: { getBySpacePath: vi.fn(async () => page) },
    } as unknown as KnowledgeServiceDeps);
    expect(await svc.getPageByPath("s1", "tables/orders")).toBe(page);
  });
});

describe("KnowledgeService.getActivePage", () => {
  function svcWith(page: unknown) {
    return new KnowledgeService({
      pages: { getById: vi.fn(async () => page) },
    } as unknown as KnowledgeServiceDeps);
  }

  it("returns the page when active", async () => {
    const page = { _id: "d1", title: "Orders", active: true };
    expect(await svcWith(page).getActivePage("d1")).toBe(page);
  });

  it("returns null for a soft-deleted or missing page", async () => {
    expect(await svcWith({ _id: "d1", active: false }).getActivePage("d1")).toBeNull();
    expect(await svcWith(null).getActivePage("missing")).toBeNull();
  });
});

describe("KnowledgeService.search graph expansion scope", () => {
  const neighbor = (id: string, spaceId: string) => ({
    _id: id,
    title: id,
    plainText: "body",
    source: "authored",
    active: true,
    spaceId,
  });

  function svc() {
    return new KnowledgeService({
      embeddings: {},
      chunks: {},
      links: { getLinkedPageIds: vi.fn(async () => ["nb-same", "nb-other"]) },
      pages: {
        getById: vi.fn(async (id: string) =>
          id === "nb-same"
            ? neighbor("nb-same", "s1")
            : id === "nb-other"
              ? neighbor("nb-other", "s2")
              : null
        ),
      },
    } as unknown as KnowledgeServiceDeps);
  }

  it("drops cross-space neighbors when the search is scoped to a space", async () => {
    vi.mocked(search).mockResolvedValue({
      results: [{ pageId: "hit-1" }],
      warnings: [],
    } as never);
    const res = await svc().search("q", { spaceId: "s1" }, 10, { expandGraph: true });
    const ids = res.results.map((r) => r.pageId);
    expect(ids).toContain("nb-same");
    // The s2 neighbor must NOT leak into a search explicitly scoped to s1.
    expect(ids).not.toContain("nb-other");
  });

  it("keeps neighbors from any space when the search is unscoped", async () => {
    vi.mocked(search).mockResolvedValue({
      results: [{ pageId: "hit-1" }],
      warnings: [],
    } as never);
    const res = await svc().search("q", {}, 10, { expandGraph: true });
    const ids = res.results.map((r) => r.pageId);
    expect(ids).toEqual(expect.arrayContaining(["nb-same", "nb-other"]));
  });
});
