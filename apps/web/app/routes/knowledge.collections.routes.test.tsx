import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { expect, test, vi } from "vitest";
import { ApiError } from "~/lib/api";
import type {
  CollectionWithCount,
  KnowledgeCollection,
  KnowledgeDocument,
} from "~/lib/knowledge-api";
import CollectionsIndex, {
  ErrorBoundary as IndexErrorBoundary,
} from "./_app.knowledge.collections._index";
import CollectionDetailRoute, {
  ErrorBoundary as DetailErrorBoundary,
} from "./_app.knowledge.collections.$id";

vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return {
    ...actual,
    useLoaderData: vi.fn(),
    useRouteError: vi.fn(),
    useParams: vi.fn(() => ({})),
  };
});

const collection: KnowledgeCollection = {
  id: "c1",
  name: "Support KB",
  description: "Help-center articles",
  domain: null,
  version: 1,
  createdAt: "2026-06-01T00:00:00Z",
  updatedAt: "2026-06-01T00:00:00Z",
};

const member: KnowledgeDocument = {
  id: "d1",
  title: "Refund policy",
  content: "text",
  source: "authored",
  sourceId: "d1",
  domain: null,
  tags: [],
  active: true,
  alwaysLoadForAgents: false,
  version: 1,
  createdAt: "2026-06-01T00:00:00Z",
  updatedAt: "2026-06-01T00:00:00Z",
  indexingStatus: "pending",
};

function renderWithData(node: ReactElement, data: unknown) {
  vi.mocked(remix.useLoaderData).mockReturnValue(data);
  const Stub = createRemixStub([{ path: "/", Component: () => node }]);
  render(<Stub initialEntries={["/"]} />);
}

function renderError(node: ReactElement, error: unknown) {
  vi.mocked(remix.useRouteError).mockReturnValue(error);
  render(node);
}

test("collections index lists rows with a document count and a New link", () => {
  const items: CollectionWithCount[] = [{ ...collection, docCount: 3 }];
  renderWithData(<CollectionsIndex />, { items, nextCursor: null });
  expect(screen.getByRole("link", { name: /Support KB/ })).toHaveAttribute(
    "href",
    "/knowledge/collections/c1"
  );
  expect(screen.getByText("3")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /New collection/i })).toBeInTheDocument();
});

test("collections index with zero rows shows 0 results", () => {
  renderWithData(<CollectionsIndex />, { items: [], nextCursor: null });
  expect(screen.getByText("0 results")).toBeInTheDocument();
});

test("collections index ErrorBoundary surfaces 401 as authentication required", () => {
  renderError(<IndexErrorBoundary />, new ApiError(401, "unauthorized"));
  expect(screen.getByText(/authentication required/i)).toBeInTheDocument();
});

test("collection detail renders the name, member documents, and an add control", () => {
  renderWithData(<CollectionDetailRoute />, { collection, documents: [member] });
  expect(screen.getByRole("heading", { name: "Support KB" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Refund policy/ })).toHaveAttribute(
    "href",
    "/knowledge/documents/d1"
  );
  expect(screen.getByRole("button", { name: /^add$/i })).toBeInTheDocument();
});

test("collection detail ErrorBoundary renders 404 not found", () => {
  renderError(<DetailErrorBoundary />, new ApiError(404, "not found"));
  expect(screen.getByText(/404 not found/i)).toBeInTheDocument();
});
