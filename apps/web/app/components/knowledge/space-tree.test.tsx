import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { listAllPages, listSpaces, navigateSpace } from "~/lib/knowledge-api";
import { KnowledgeTree } from "./space-tree";

vi.mock("~/lib/knowledge-api", () => ({
  listAllPages: vi.fn(),
  listSpaces: vi.fn(),
  navigateSpace: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  vi.mocked(listSpaces).mockResolvedValue({
    items: [
      {
        id: "space",
        name: "Handbook",
        description: null,
        createdAt: "2026-09-18T00:00:00Z",
        updatedAt: "2026-09-18T00:00:00Z",
      },
    ],
    nextCursor: null,
  });
  vi.mocked(navigateSpace).mockResolvedValue({ listing: "* [Guide](guide.md)" });
});

test.each(["mcp", "authored"] as const)(
  "tree honors server source metadata for %s Pages",
  async (source) => {
    vi.mocked(listAllPages).mockResolvedValue({
      items: [
        {
          pageId: "page",
          spaceId: "space",
          spaceName: "Handbook",
          path: "guide",
          title: "Guide",
          source,
        },
      ],
    });
    const Stub = createRemixStub([
      { path: "/knowledge/pages/:pageId/*", Component: KnowledgeTree },
    ]);
    render(<Stub initialEntries={["/knowledge/pages/page/guide"]} />);
    expect(await screen.findByRole("link", { name: "Guide" })).toHaveAttribute(
      "href",
      "/knowledge/pages/page/guide"
    );
    if (source === "mcp") {
      expect(screen.queryByRole("button", { name: "Move Guide" })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "New page under Guide" })).not.toBeInTheDocument();
    } else {
      expect(screen.getByRole("button", { name: "Move Guide" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "New page under Guide" })).toBeInTheDocument();
    }
  }
);
