import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const searchPages = vi.fn();
const getKnowledgeOverview = vi.fn();
vi.mock("~/lib/knowledge-api", () => ({
  searchPages: (...a: unknown[]) => searchPages(...a),
  getKnowledgeOverview: (...a: unknown[]) => getKnowledgeOverview(...a),
}));

import { usePageSearch } from "./use-page-search";

const recent = (id: string, title: string) => ({
  documentId: id,
  bundleId: "b1",
  bundleName: "B",
  path: title.toLowerCase(),
  title,
  updatedAt: "2026-06-27T00:00:00Z",
});
const hit = (id: string, title: string) => ({
  documentId: id,
  title,
  bundleId: "b1",
  path: title.toLowerCase(),
  snippet: "snip",
  highlightRanges: [],
  score: 1,
});

describe("usePageSearch", () => {
  beforeEach(() => {
    searchPages.mockReset();
    getKnowledgeOverview.mockReset();
    getKnowledgeOverview.mockResolvedValue({ spaces: [], recent: [] });
    searchPages.mockResolvedValue([]);
  });

  it("loads recent pages (mapped to hits) for a blank query", async () => {
    getKnowledgeOverview.mockResolvedValue({ spaces: [], recent: [recent("d1", "Recent One")] });
    const { result } = renderHook(() => usePageSearch(null));

    expect(result.current.isZeroQuery).toBe(true);
    await waitFor(() => expect(result.current.results).toHaveLength(1));
    expect(result.current.results[0].title).toBe("Recent One");
    expect(searchPages).not.toHaveBeenCalled();
  });

  it("searches scoped to the bundle when scope is 'space'", async () => {
    searchPages.mockResolvedValue([hit("d2", "Orders")]);
    const { result } = renderHook(() => usePageSearch("b1"));
    expect(result.current.scope).toBe("space"); // defaults to space when a bundle is active

    act(() => result.current.setQuery("orders"));
    await waitFor(() =>
      expect(searchPages).toHaveBeenCalledWith("orders", { bundleId: "b1", limit: 10 })
    );
    await waitFor(() => expect(result.current.results[0].title).toBe("Orders"));
  });

  it("drops the bundle filter when scope is 'all'", async () => {
    const { result } = renderHook(() => usePageSearch("b1"));
    act(() => {
      result.current.setScope("all");
      result.current.setQuery("q");
    });
    await waitFor(() =>
      expect(searchPages).toHaveBeenCalledWith("q", { bundleId: undefined, limit: 10 })
    );
  });

  it("dedupes results by documentId", async () => {
    searchPages.mockResolvedValue([hit("dup", "A"), hit("dup", "A again"), hit("d3", "B")]);
    const { result } = renderHook(() => usePageSearch(null));
    act(() => result.current.setQuery("x"));
    await waitFor(() => expect(result.current.results).toHaveLength(2));
    expect(result.current.results.map((r) => r.documentId)).toEqual(["dup", "d3"]);
  });

  it("defaults scope reactively to the active bundle; an explicit choice sticks across navigation", () => {
    const { result, rerender } = renderHook(({ b }) => usePageSearch(b), {
      initialProps: { b: null as string | null },
    });
    expect(result.current.scope).toBe("all"); // no bundle → all

    rerender({ b: "b1" }); // navigate into a bundle (palette is not remounted)
    expect(result.current.scope).toBe("space"); // reactive default follows the bundle

    act(() => result.current.setScope("all")); // user explicitly picks all spaces
    expect(result.current.scope).toBe("all");
    rerender({ b: "b2" });
    expect(result.current.scope).toBe("all"); // explicit choice persists across the change
  });
});
