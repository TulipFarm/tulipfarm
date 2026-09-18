import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { KnowledgePage } from "~/lib/knowledge-api";
import type { McpKnowledgePageSource } from "~/lib/mcp-knowledge";
import { buildPageResolver } from "~/lib/page-href";
import { PageDetail } from "./page-detail";

vi.mock("./history-panel", () => ({ HistoryDrawer: () => null }));

const page: KnowledgePage = {
  id: "page",
  title: "Source handbook",
  content: "",
  source: "mcp",
  sourceId: "mcp:source-hash",
  domain: null,
  tags: [],
  active: true,
  alwaysLoadForAgents: false,
  version: 1,
  spaceId: "space",
  path: "handbook",
  resource: null,
  createdAt: "2026-09-18T00:00:00Z",
  updatedAt: "2026-09-18T00:00:00Z",
};

function mount(doc = page, source?: McpKnowledgePageSource) {
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => (
        <PageDetail
          spaceId="space"
          doc={doc}
          source={source}
          path="handbook"
          editTo="/knowledge/pages/page/edit"
          onDelete={vi.fn()}
          deleting={false}
          backlinks={[]}
          resolver={buildPageResolver([])}
        />
      ),
    },
  ]);
  render(<Stub />);
}

test("synced Pages are read-only even when empty and direct users to source management", () => {
  mount();
  expect(screen.getByRole("complementary", { name: "Synced Page" })).toHaveTextContent("read-only");
  expect(screen.getByRole("link", { name: "Integrations" })).toHaveAttribute(
    "href",
    "/integrations"
  );
  expect(screen.queryByRole("link", { name: "Edit" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Add content" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "More actions" })).not.toBeInTheDocument();
});

test("authored Pages retain their existing editing and history controls", () => {
  mount({ ...page, source: "authored", sourceId: "user" });
  expect(screen.getByRole("link", { name: "Edit" })).toHaveAttribute(
    "href",
    "/knowledge/pages/page/edit"
  );
  expect(screen.getByRole("link", { name: "Add content" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "More actions" })).toBeInTheDocument();
  expect(screen.queryByRole("complementary", { name: "Synced Page" })).not.toBeInTheDocument();
});

test("shows server-calculated stale status and an original-source link", () => {
  mount(page, {
    readOnly: true,
    sourceUrl: "https://github.com/example/handbook/blob/main/README.md",
    lastSyncedAt: "2026-09-18T00:00:00Z",
    stale: true,
  });
  expect(screen.getByRole("status")).toHaveTextContent("refresh failed or is overdue");
  expect(screen.getByText(/Last synced:/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Open original source" })).toHaveAttribute(
    "href",
    "https://github.com/example/handbook/blob/main/README.md"
  );
});

test("source metadata cannot create an unsafe outbound link", () => {
  mount(page, {
    readOnly: true,
    sourceUrl: "javascript:alert(1)",
    lastSyncedAt: "2026-09-18T00:00:00Z",
    stale: false,
  });
  expect(screen.queryByRole("link", { name: "Open original source" })).not.toBeInTheDocument();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
