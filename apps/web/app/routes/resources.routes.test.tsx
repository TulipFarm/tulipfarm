import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { expect, test, vi } from "vitest";
import { ApiError } from "~/lib/api";
import { deriveFields, detailFields, listColumns, parseSchema } from "~/lib/schema";
import ResourcesIndex, { ErrorBoundary as IndexErrorBoundary } from "./_app.resources._index";
import ResourceList, { ErrorBoundary as ListErrorBoundary } from "./_app.resources.$type._index";
import ResourceDetail, { ErrorBoundary as DetailErrorBoundary } from "./_app.resources.$type.$id";

/* Render routes directly because real data navigation creates jsdom-undici AbortSignal issues. */

vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return {
    ...actual,
    useLoaderData: vi.fn(),
    useRouteError: vi.fn(),
    useParams: vi.fn(() => ({})),
  };
});

const parsed = parseSchema(`
type: object
x-id-strategy: { field: id }
properties:
  id: { type: string }
  title: { type: string }
  customerId: { type: string, x-links: { target: customer } }
  open: { type: boolean }
`);
if (!parsed.ok) throw new Error(parsed.error);
const columns = listColumns(deriveFields(parsed.schema), parsed.schema);
const fields = detailFields(deriveFields(parsed.schema), parsed.schema);

const record = {
  id: "TICK-1",
  title: "Login 500",
  customerId: "CUST-9",
  open: true,
  version: 4,
  createdAt: "2026-06-01T09:12:00Z",
  updatedAt: "2026-06-08T14:03:00Z",
};

// Render a component that reads loader data, with router context for its <Link>s.
function renderWithData(node: ReactElement, data: unknown) {
  vi.mocked(remix.useLoaderData).mockReturnValue(data);
  const Stub = createRemixStub([{ path: "/", Component: () => node }]);
  render(<Stub initialEntries={["/"]} />);
}

// Render an ErrorBoundary with a given routed error (the states have no <Link>, so no router).
function renderError(node: ReactElement, error: unknown) {
  vi.mocked(remix.useRouteError).mockReturnValue(error);
  render(node);
}

test("index lists resource types with field counts and a hooks pill", () => {
  renderWithData(<ResourcesIndex />, {
    rows: [
      { name: "ticket", hasHooks: false, fieldCount: 5 },
      { name: "article", hasHooks: true, fieldCount: 6 },
    ],
  });
  expect(screen.getByText("2 types")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /ticket/ })).toHaveAttribute("href", "/resources/ticket");
  expect(screen.getByText("hooks")).toBeInTheDocument();
});

test("index with no types shows a create prompt with a New type link", () => {
  renderWithData(<ResourcesIndex />, { rows: [] });
  expect(screen.getByText(/No resource types defined yet/i)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /New type/i })).toHaveAttribute("href", "/resources/new");
});

test("index ErrorBoundary surfaces 401 as authentication required", () => {
  renderError(<IndexErrorBoundary />, new ApiError(401, "unauthorized"));
  expect(screen.getByText(/authentication required/i)).toBeInTheDocument();
});

test("list renders the schema-driven table and a Load more button when paginated", () => {
  renderWithData(<ResourceList />, {
    type: "ticket",
    columns,
    schemaError: undefined,
    items: [record],
    nextCursor: "next-page",
  });
  expect(screen.getByRole("link", { name: /TICK-1/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /load more/i })).toBeInTheDocument();
});

test("list with zero records shows 0 results and no Load more", () => {
  renderWithData(<ResourceList />, {
    type: "ticket",
    columns,
    schemaError: undefined,
    items: [],
    nextCursor: null,
  });
  expect(screen.getByText("0 results")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument();
});

test("detail renders all fields and a [system] block", () => {
  renderWithData(<ResourceDetail />, { type: "ticket", record, fields, schemaError: undefined });
  expect(screen.getByText("Login 500")).toBeInTheDocument();
  expect(screen.getByText("system")).toBeInTheDocument();
});

test("detail ErrorBoundary renders 404 not found for a missing record", () => {
  renderError(<DetailErrorBoundary />, new ApiError(404, "not found"));
  expect(screen.getByText(/404 not found/i)).toBeInTheDocument();
});

test("list ErrorBoundary surfaces a non-auth API failure generically", () => {
  renderError(<ListErrorBoundary />, new ApiError(500, "boom"));
  expect(screen.getByText(/error: 500/i)).toBeInTheDocument();
});
