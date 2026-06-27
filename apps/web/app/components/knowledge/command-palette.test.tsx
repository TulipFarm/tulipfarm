import { createRemixStub } from "@remix-run/testing";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const searchPages = vi.fn();
const getKnowledgeOverview = vi.fn();
const listSpaces = vi.fn();
vi.mock("~/lib/knowledge-api", () => ({
  searchPages: (...a: unknown[]) => searchPages(...a),
  getKnowledgeOverview: (...a: unknown[]) => getKnowledgeOverview(...a),
  listSpaces: (...a: unknown[]) => listSpaces(...a),
}));

import { CommandPalette, OPEN_SEARCH_EVENT, queryHighlightRanges } from "./command-palette";

const hit = (id: string, title: string) => ({
  pageId: id,
  title,
  spaceId: "b1",
  path: title.toLowerCase(),
  snippet: "a snippet",
  highlightRanges: [] as Array<[number, number]>,
  score: 1,
});

function renderPalette(spaceId: string | null = null) {
  const Stub = createRemixStub([
    { path: "/", Component: () => <CommandPalette spaceId={spaceId} /> },
    { path: "/knowledge/pages/:id/*", Component: () => <div>NAVIGATED</div> },
  ]);
  return render(<Stub />);
}

describe("CommandPalette", () => {
  beforeEach(() => {
    searchPages.mockReset();
    getKnowledgeOverview.mockReset();
    listSpaces.mockReset();
    getKnowledgeOverview.mockResolvedValue({ spaces: [], recent: [] });
    listSpaces.mockResolvedValue({ items: [{ id: "b1", name: "Engineering" }], nextCursor: null });
    searchPages.mockResolvedValue([]);
  });

  it("is closed until the open event fires, then shows the search input", async () => {
    renderPalette();
    expect(screen.queryByPlaceholderText("Search knowledge…")).not.toBeInTheDocument();

    fireEvent(window, new Event(OPEN_SEARCH_EVENT));
    expect(await screen.findByPlaceholderText("Search knowledge…")).toBeInTheDocument();
  });

  it("opens on ⌘K", async () => {
    renderPalette();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(await screen.findByPlaceholderText("Search knowledge…")).toBeInTheDocument();
  });

  it("searches as the user types and navigates to the selected page", async () => {
    searchPages.mockResolvedValue([hit("d2", "Orders Table")]);
    renderPalette();
    fireEvent(window, new Event(OPEN_SEARCH_EVENT));
    const input = await screen.findByPlaceholderText("Search knowledge…");

    await userEvent.type(input, "orders");
    await waitFor(() =>
      expect(searchPages).toHaveBeenCalledWith("orders", expect.objectContaining({ limit: 10 }))
    );
    const item = await screen.findByText("Orders Table");

    await userEvent.click(item);
    expect(await screen.findByText("NAVIGATED")).toBeInTheDocument();
  });

  it("shows a skeleton while a search is in flight, not 'No pages found'", async () => {
    let resolveSearch: (hits: unknown) => void = () => {};
    searchPages.mockReturnValue(new Promise((r) => (resolveSearch = r)));
    renderPalette();
    fireEvent(window, new Event(OPEN_SEARCH_EVENT));
    const input = await screen.findByPlaceholderText("Search knowledge…");

    await userEvent.type(input, "escalate");
    expect(await screen.findByTestId("search-skeleton")).toBeInTheDocument();
    expect(screen.queryByText("No pages found.")).not.toBeInTheDocument();

    await act(async () => resolveSearch([hit("d2", "On-call Guide")]));
    await waitFor(() => expect(screen.queryByTestId("search-skeleton")).not.toBeInTheDocument());
    expect(screen.getByText("On-call Guide")).toBeInTheDocument();
  });

  it("highlights only the typed prefix in the snippet, not the whole word", async () => {
    searchPages.mockResolvedValue([
      { ...hit("d3", "Deploy Runbook"), snippet: "Never deploy on a Friday." },
    ]);
    renderPalette();
    fireEvent(window, new Event(OPEN_SEARCH_EVENT));
    const input = await screen.findByPlaceholderText("Search knowledge…");

    await userEvent.type(input, "fri");
    const mark = await screen.findByText("Fri"); // "Fri", not "Friday"
    expect(mark.tagName).toBe("MARK");
  });

  it("shows the scope toggle only when a space is active", async () => {
    const { unmount } = renderPalette(null);
    fireEvent(window, new Event(OPEN_SEARCH_EVENT));
    await screen.findByPlaceholderText("Search knowledge…");
    expect(screen.queryByText("This space")).not.toBeInTheDocument();
    unmount();

    renderPalette("b1");
    fireEvent(window, new Event(OPEN_SEARCH_EVENT));
    await screen.findByPlaceholderText("Search knowledge…");
    expect(screen.getByText("This space")).toBeInTheDocument();
    expect(screen.getByText("All spaces")).toBeInTheDocument();
  });
});

describe("queryHighlightRanges", () => {
  it("highlights word-start prefixes per term and merges overlaps", () => {
    expect(queryHighlightRanges("Friday deploy", "fri")).toEqual([[0, 3]]); // index 0
    expect(queryHighlightRanges("Deploy on Friday", "deploy fri")).toEqual([
      [0, 6],
      [10, 13],
    ]); // multi-term
    expect(queryHighlightRanges("aaa bbb", "a")).toEqual([[0, 1]]); // word start only, not mid-word
    expect(queryHighlightRanges("abcdef", "ab abc")).toEqual([[0, 3]]); // overlapping → merged
    expect(queryHighlightRanges("no hit here", "xyz")).toEqual([]);
    expect(queryHighlightRanges("anything", "   ")).toEqual([]); // no usable terms
  });
});
