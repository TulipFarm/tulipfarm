import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { expect, test, vi } from "vitest";
import { ApiError } from "~/lib/api";
import { buildCatalog } from "~/lib/resource-catalog";
import {
  availableColumns,
  deriveFields,
  detailFields,
  listColumns,
  parseSchema,
} from "~/lib/schema";
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
const schemaFields = deriveFields(parsed.schema);
const columns = availableColumns(schemaFields, parsed.schema);
const defaultColumns = listColumns(schemaFields, parsed.schema).map((c) => c.name);
const fields = detailFields(schemaFields, parsed.schema);

const TICKET_YAML = `
type: object
properties:
  title: { type: string }
  customerId: { type: string, x-links: { target: customer } }
`;
const CUSTOMER_YAML = `
type: object
properties:
  name: { type: string }
`;

/** The catalog rows the index loader would build, without going near the network. */
function catalogRows() {
  return buildCatalog(
    [
      { name: "ticket", schema: TICKET_YAML, hasHooks: false, domain: "support" },
      { name: "customer", schema: CUSTOMER_YAML, hasHooks: true, domain: "sales" },
    ],
    [
      { name: "ticket", count: 41, lastUpdatedAt: "2026-06-08T14:03:00Z" },
      { name: "customer", count: 7, lastUpdatedAt: null },
    ]
  );
}

/** The type-page loader shape, with only the parts a test cares about overridden. */
function listData(overrides: Record<string, unknown> = {}) {
  return {
    type: "ticket",
    domain: "support",
    hasHooks: false,
    idStrategy: { field: "id" },
    schemaFields: fields,
    idField: "id",
    linkTargets: ["customer"],
    columns,
    defaultColumns,
    schemaError: undefined,
    items: [],
    nextCursor: null,
    recordCount: 0,
    lastUpdatedAt: null,
    ...overrides,
  };
}

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

test("index lists every type with its record count, domain and relationships", () => {
  renderWithData(<ResourcesIndex />, { rows: catalogRows() });

  expect(screen.getByText("2 types")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /ticket/ })).toHaveAttribute("href", "/resources/ticket");
  expect(screen.getByText("41")).toBeInTheDocument();
  const ticketRow = screen.getByRole("link", { name: /ticket/ }).closest("tr");
  expect(within(ticketRow as HTMLElement).getByText("support")).toBeInTheDocument();
  // customer is pointed at by ticket, so the catalog shows the inbound edge without a round trip.
  const customerRow = screen.getByRole("link", { name: /customer/ }).closest("tr");
  expect(within(customerRow as HTMLElement).getByText("ticket")).toBeInTheDocument();
});

test("index sorts by record count when the Records header is used", () => {
  renderWithData(<ResourcesIndex />, { rows: catalogRows() });

  const header = screen.getByRole("columnheader", { name: /records/i });
  expect(header).not.toHaveAttribute("aria-sort");
  fireEvent.click(within(header).getByRole("button"));

  expect(header).toHaveAttribute("aria-sort", "descending");
  const names = screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.textContent ?? "");
  expect(names[0]).toContain("ticket");
});

test("index search narrows the catalog and reports how much it hid", () => {
  renderWithData(<ResourcesIndex />, { rows: catalogRows() });

  fireEvent.change(screen.getByRole("searchbox", { name: /search resource types/i }), {
    target: { value: "sales" },
  });

  expect(screen.getByText("1 of 2 types")).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /^ticket$/ })).not.toBeInTheDocument();
});

test("index empty search state names the query that found nothing", () => {
  renderWithData(<ResourcesIndex />, { rows: catalogRows() });

  fireEvent.change(screen.getByRole("searchbox", { name: /search resource types/i }), {
    target: { value: "zzz" },
  });

  expect(screen.getByText(/No type matches “zzz”/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
  expect(screen.getByText("2 types")).toBeInTheDocument();
});

test("index with no types explains what a resource type is and links to the builder", () => {
  renderWithData(<ResourcesIndex />, { rows: [] });
  expect(screen.getByText(/No resource types yet/i)).toBeInTheDocument();
  expect(screen.getAllByRole("link", { name: /New type/i })[0]).toHaveAttribute(
    "href",
    "/resources/new"
  );
});

test("index ErrorBoundary surfaces 401 as authentication required", () => {
  renderError(<IndexErrorBoundary />, new ApiError(401, "unauthorized"));
  expect(screen.getByText(/authentication required/i)).toBeInTheDocument();
});

test("list renders the schema-driven table and a Load more button when paginated", () => {
  renderWithData(
    <ResourceList />,
    listData({ items: [record], nextCursor: "next-page", recordCount: 1 })
  );
  expect(screen.getByRole("link", { name: /TICK-1/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /load more/i })).toBeInTheDocument();
});

test("list shows the server-side total, not just how many rows are loaded", () => {
  renderWithData(<ResourceList />, listData({ items: [record], recordCount: 4211 }));
  expect(screen.getByText("4,211")).toBeInTheDocument();
});

test("list can show a column the default view had to drop", () => {
  renderWithData(<ResourceList />, listData({ items: [record], recordCount: 1 }));

  expect(screen.queryByRole("columnheader", { name: "createdAt" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: "createdAt, runtime-managed" }));
  expect(screen.getByRole("columnheader", { name: "createdAt" })).toBeInTheDocument();
});

test("list marks runtime-managed columns in the picker and lists them after the type's own", () => {
  renderWithData(<ResourceList />, listData({ items: [record], recordCount: 1 }));

  const boxes = screen.getAllByRole("checkbox");
  expect(boxes[0]).toHaveAccessibleName("title");
  // A bare adjacent badge would be announced as "createdAtsystem".
  expect(screen.getByRole("checkbox", { name: "createdAt, runtime-managed" })).toBeInTheDocument();
  expect(boxes.at(-1)).toHaveAccessibleName(/runtime-managed$/);
});

test("list links out to each type this one points at", () => {
  renderWithData(<ResourceList />, listData({ items: [record] }));
  expect(screen.getByRole("link", { name: /customer/ })).toHaveAttribute(
    "href",
    "/resources/customer"
  );
});

// Following that link is a same-route navigation, so React Router keeps the component mounted and
// only loader data changes. Every list control is seeded from loader data on mount, so without a
// remount the new type inherits the old one's rows, cursor and column selection.
test("switching type drops the previous type's records instead of showing them under a new header", async () => {
  vi.mocked(remix.useLoaderData).mockImplementation(() =>
    remix.useLocation().pathname.endsWith("/customer")
      ? listData({ type: "customer", linkTargets: [], items: [], recordCount: 0 })
      : listData({ items: [record], recordCount: 1 })
  );
  const Stub = createRemixStub([{ path: "/resources/:type", Component: () => <ResourceList /> }]);
  render(<Stub initialEntries={["/resources/ticket"]} />);
  expect(screen.getByRole("link", { name: /TICK-1/ })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("link", { name: /customer/ }));

  expect(await screen.findByText(/No customer records yet/i)).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /TICK-1/ })).not.toBeInTheDocument();
});

test("list with zero records says so in the type's own words and offers the create action", () => {
  renderWithData(<ResourceList />, listData());
  expect(screen.getByText(/No ticket records yet/i)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument();
});

test("list surfaces an unparseable schema instead of rendering an empty table", () => {
  renderWithData(<ResourceList />, listData({ schemaError: "schema is not an object" }));
  expect(screen.getByText(/schema will not parse/i)).toBeInTheDocument();
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
});

test("detail names the record in its heading and still lists every field", () => {
  renderWithData(<ResourceDetail />, { type: "ticket", record, fields, schemaError: undefined });
  expect(screen.getByRole("heading", { level: 1, name: "Login 500" })).toBeInTheDocument();
  // The heading is a label for the record; the field list stays complete regardless.
  expect(screen.getAllByText("Login 500")).toHaveLength(2);
  expect(screen.getByText("System")).toBeInTheDocument();
});

test("detail ErrorBoundary renders 404 not found for a missing record", () => {
  renderError(<DetailErrorBoundary />, new ApiError(404, "not found"));
  expect(screen.getByText(/404 not found/i)).toBeInTheDocument();
});

test("list ErrorBoundary surfaces a non-auth API failure generically", () => {
  renderError(<ListErrorBoundary />, new ApiError(500, "boom"));
  expect(screen.getByText(/error: 500/i)).toBeInTheDocument();
});
