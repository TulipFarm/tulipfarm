import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { expect, test, vi } from "vitest";
import { ApiError } from "~/lib/api";
import type { KnowledgeDocument } from "~/lib/knowledge-api";
import DocumentsIndex, {
  ErrorBoundary as IndexErrorBoundary,
} from "./_app.knowledge.documents._index";
import DocumentDetail, {
  ErrorBoundary as DetailErrorBoundary,
} from "./_app.knowledge.documents.$id";

/*
 * Route smoke tests, mirroring resources.routes.test.tsx: mock useLoaderData/useRouteError and render
 * each Component / ErrorBoundary directly (Link needs router context → createRemixStub at "/").
 */
vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return {
    ...actual,
    useLoaderData: vi.fn(),
    useRouteError: vi.fn(),
    useParams: vi.fn(() => ({})),
  };
});

const doc: KnowledgeDocument = {
  id: "d1",
  title: "Onboarding",
  content: "# Hello\n\nbody text",
  source: "authored",
  sourceId: "d1",
  domain: "sales",
  tags: ["a", "b"],
  active: true,
  alwaysLoadForAgents: false,
  version: 2,
  createdAt: "2026-06-01T00:00:00Z",
  updatedAt: "2026-06-08T00:00:00Z",
  indexingStatus: "indexed",
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

test("documents index lists rows with status badge, a New link, and Load more when paginated", () => {
  renderWithData(<DocumentsIndex />, { items: [doc], nextCursor: "next-page" });
  expect(screen.getByRole("link", { name: /Onboarding/ })).toHaveAttribute(
    "href",
    "/knowledge/documents/d1"
  );
  expect(screen.getByText("indexed")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /New document/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /load more/i })).toBeInTheDocument();
});

test("documents index with zero rows shows 0 results and no Load more", () => {
  renderWithData(<DocumentsIndex />, { items: [], nextCursor: null });
  expect(screen.getByText("0 results")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument();
});

test("documents index ErrorBoundary surfaces 401 as authentication required", () => {
  renderError(<IndexErrorBoundary />, new ApiError(401, "unauthorized"));
  expect(screen.getByText(/authentication required/i)).toBeInTheDocument();
});

test("document detail renders title, rendered markdown, status badge, and edit link", () => {
  renderWithData(<DocumentDetail />, { doc });
  expect(screen.getByRole("heading", { name: "Onboarding" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Hello" })).toBeInTheDocument(); // markdown body
  expect(screen.getByText("indexed")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /edit/i })).toHaveAttribute(
    "href",
    "/knowledge/documents/d1/edit"
  );
});

test("document detail Delete reveals an inline confirm", () => {
  renderWithData(<DocumentDetail />, { doc });
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(screen.getByRole("button", { name: /confirm delete/i })).toBeInTheDocument();
});

test("document detail ErrorBoundary renders 404 not found", () => {
  renderError(<DetailErrorBoundary />, new ApiError(404, "not found"));
  expect(screen.getByText(/404 not found/i)).toBeInTheDocument();
});
