import { describe, expect, it, vi } from "vitest";
import { search } from "./search-service";
import { KnowledgeService, type KnowledgeServiceDeps } from "./service";

vi.mock("./search-service", () => ({ search: vi.fn() }));

describe("KnowledgeService.getConceptByPath", () => {
  it("normalizes the path (strips leading/trailing slash + .md) before the bundle lookup", async () => {
    const getByBundlePath = vi.fn(async () => null);
    const svc = new KnowledgeService({
      documents: { getByBundlePath },
    } as unknown as KnowledgeServiceDeps);

    await svc.getConceptByPath("b1", "/tables/orders.md");
    expect(getByBundlePath).toHaveBeenCalledWith("b1", "tables/orders");

    await svc.getConceptByPath("b1", "tables/orders");
    expect(getByBundlePath).toHaveBeenLastCalledWith("b1", "tables/orders");
  });

  it("returns the document the repo resolves", async () => {
    const doc = { _id: "d1", title: "Orders" };
    const svc = new KnowledgeService({
      documents: { getByBundlePath: vi.fn(async () => doc) },
    } as unknown as KnowledgeServiceDeps);
    expect(await svc.getConceptByPath("b1", "tables/orders")).toBe(doc);
  });
});

describe("KnowledgeService.getActiveDocument", () => {
  function svcWith(doc: unknown) {
    return new KnowledgeService({
      documents: { getById: vi.fn(async () => doc) },
    } as unknown as KnowledgeServiceDeps);
  }

  it("returns the document when active", async () => {
    const doc = { _id: "d1", title: "Orders", active: true };
    expect(await svcWith(doc).getActiveDocument("d1")).toBe(doc);
  });

  it("returns null for a soft-deleted or missing document", async () => {
    expect(await svcWith({ _id: "d1", active: false }).getActiveDocument("d1")).toBeNull();
    expect(await svcWith(null).getActiveDocument("missing")).toBeNull();
  });
});

describe("KnowledgeService.search graph expansion scope", () => {
  const neighbor = (id: string, bundleId: string) => ({
    _id: id,
    title: id,
    plainText: "body",
    source: "authored",
    active: true,
    bundleId,
  });

  function svc() {
    return new KnowledgeService({
      embeddings: {},
      chunks: {},
      links: { getLinkedDocumentIds: vi.fn(async () => ["nb-same", "nb-other"]) },
      documents: {
        getById: vi.fn(async (id: string) =>
          id === "nb-same"
            ? neighbor("nb-same", "b1")
            : id === "nb-other"
              ? neighbor("nb-other", "b2")
              : null
        ),
      },
    } as unknown as KnowledgeServiceDeps);
  }

  it("drops cross-bundle neighbors when the search is scoped to a bundle", async () => {
    vi.mocked(search).mockResolvedValue({
      results: [{ documentId: "hit-1" }],
      warnings: [],
    } as never);
    const res = await svc().search("q", { bundleId: "b1" }, 10, { expandGraph: true });
    const ids = res.results.map((r) => r.documentId);
    expect(ids).toContain("nb-same");
    // The b2 neighbor must NOT leak into a search explicitly scoped to b1.
    expect(ids).not.toContain("nb-other");
  });

  it("keeps neighbors from any bundle when the search is unscoped", async () => {
    vi.mocked(search).mockResolvedValue({
      results: [{ documentId: "hit-1" }],
      warnings: [],
    } as never);
    const res = await svc().search("q", {}, 10, { expandGraph: true });
    const ids = res.results.map((r) => r.documentId);
    expect(ids).toEqual(expect.arrayContaining(["nb-same", "nb-other"]));
  });
});
