import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { expect, test, vi } from "vitest";
import { ApiError, deleteRecord, previewRecordDelete } from "~/lib/api";
import { buildCatalog } from "~/lib/resource-catalog";
import {
  availableColumns,
  deriveFields,
  detailFields,
  formatIsoDate,
  listColumns,
  parseSchema,
} from "~/lib/schema";
import ResourcesIndex, { ErrorBoundary as IndexErrorBoundary } from "./_app.resources._index";
import ResourceList, { ErrorBoundary as ListErrorBoundary } from "./_app.resources.$type._index";
import ResourceDetail, { ErrorBoundary as DetailErrorBoundary } from "./_app.resources.$type.$id";
import { ErrorBoundary as SchemaErrorBoundary } from "./_app.resources.$type.schema";

/* Render routes directly because real data navigation creates jsdom-undici AbortSignal issues. */

const { revalidate } = vi.hoisted(() => ({ revalidate: vi.fn() }));

vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return {
    ...actual,
    useLoaderData: vi.fn(),
    useNavigate: vi.fn(() => vi.fn()),
    useRouteError: vi.fn(),
    useParams: vi.fn(() => ({})),
    useRevalidator: vi.fn(() => ({ state: "idle", revalidate })),
  };
});

vi.mock("~/lib/api", async () => {
  const actual = await vi.importActual<typeof import("~/lib/api")>("~/lib/api");
  return {
    ...actual,
    deleteRecord: vi.fn(),
    previewRecordDelete: vi.fn(),
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
  status: { type: string }
  quantity: { type: number }
  active: { type: boolean }
  notes: { type: string }
  dueDate: { type: string, format: date }
  startsAt: { type: string, format: date-time }
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
      {
        name: "ticket",
        schema: TICKET_YAML,
        hasHooks: false,
        revision: "a".repeat(40),
        domain: "support",
      },
      {
        name: "customer",
        schema: CUSTOMER_YAML,
        hasHooks: true,
        revision: "b".repeat(40),
        domain: "sales",
      },
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

function renderError(node: ReactElement, error: unknown, params: Record<string, string> = {}) {
  vi.mocked(remix.useRouteError).mockReturnValue(error);
  vi.mocked(remix.useParams).mockReturnValue(params);
  const Stub = createRemixStub([{ path: "/", Component: () => node }]);
  render(<Stub initialEntries={["/"]} />);
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

test("index search includes declared fields beyond the catalog preview", () => {
  renderWithData(<ResourcesIndex />, { rows: catalogRows() });
  const search = screen.getByRole("searchbox", { name: /search resource types/i });

  expect(screen.getByText("title · status · quantity")).toBeInTheDocument();
  fireEvent.change(search, { target: { value: "CUSTOMERID" } });
  expect(screen.getByText("1 of 2 types")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /^ticket$/ })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /^customer$/ })).not.toBeInTheDocument();

  fireEvent.change(search, { target: { value: "customer" } });
  expect(screen.getByText("2 of 2 types")).toBeInTheDocument();

  fireEvent.change(search, { target: { value: "title" } });
  expect(screen.getByText("1 of 2 types")).toBeInTheDocument();

  fireEvent.change(search, { target: { value: "" } });
  expect(screen.getByText("2 types")).toBeInTheDocument();
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

test("index with no types drafts a resource type and keeps manual creation secondary", () => {
  renderWithData(<ResourcesIndex />, { rows: [] });
  expect(screen.getByText(/No resource types yet/i)).toBeInTheDocument();
  const draft = screen.getByRole("link", { name: "Create a resource type in chat" });
  expect(
    new URL(draft.getAttribute("href") ?? "", "http://localhost").searchParams.get("draft")
  ).toMatch(/resource type.*fields/i);
  expect(screen.getByRole("link", { name: "Create manually" })).toHaveAttribute(
    "href",
    "/resources/new"
  );
  expect(document.querySelectorAll(".bg-primary")).toHaveLength(1);
});

test("index ErrorBoundary surfaces 401 as authentication required", () => {
  renderError(<IndexErrorBoundary />, new ApiError(401, "unauthorized"));
  expect(screen.getByText(/authentication required/i)).toBeInTheDocument();
});

test("index ErrorBoundary gives hosted-safe connection recovery and retries the loader", () => {
  renderError(<IndexErrorBoundary />, new TypeError("Failed to fetch"));

  expect(screen.getByText("Resources could not be loaded.")).toBeVisible();
  expect(screen.getByText(/check your connection, then try again/i)).toBeVisible();
  expect(screen.queryByText(/:4010|API could not be reached/i)).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(revalidate).toHaveBeenCalledTimes(1);
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

test.each([
  ["QA-", "QA-n"],
  ["QA", "QAn"],
  ["", "n"],
  [undefined, "n"],
])("list shows generated Record IDs with the configured %s prefix", (prefix, expected) => {
  renderWithData(
    <ResourceList />,
    listData({
      idStrategy: { field: "invoiceNumber", prefix, sequence: true },
      idField: "invoiceNumber",
    })
  );

  expect(screen.getByText(expected)).toBeInTheDocument();
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

test("detail uses valid definition-list groups without dropping field or system values", () => {
  const detailSchema = parseSchema(`
type: object
properties:
  title: { type: string }
  status: { type: string, enum: [open, closed] }
  notes: { type: [string, "null"] }
  dueDate: { type: string, format: date }
`);
  if (!detailSchema.ok) throw new Error(detailSchema.error);
  const detailRecord = {
    id: "REC-1",
    title: "September stock",
    status: "open",
    notes: null,
    dueDate: "2026-09-17",
    version: 3,
    createdAt: "2026-09-16T08:30:00Z",
    updatedAt: "2026-09-17T09:45:00Z",
  };
  renderWithData(<ResourceDetail />, {
    type: "stock",
    record: detailRecord,
    fields: detailFields(deriveFields(detailSchema.schema), detailSchema.schema),
    schemaError: undefined,
  });

  expect(screen.getByRole("heading", { level: 1, name: "September stock" })).toBeInTheDocument();
  expect(screen.getAllByText("September stock")).toHaveLength(2);
  expect(screen.getAllByText("REC-1")).toHaveLength(2);
  for (const value of ["open", "-", formatIsoDate("2026-09-17"), "3"]) {
    expect(screen.getByText(value)).toBeInTheDocument();
  }

  const systemLabel = screen.getByText("System");
  expect(systemLabel.closest("dl")).toBeNull();
  const definitionLists = Array.from(document.querySelectorAll("dl")).filter((list) =>
    list.querySelector("dt")
  );
  expect(definitionLists).toHaveLength(2);
  for (const list of definitionLists) {
    for (const group of list.children) {
      expect(group.tagName).toBe("DIV");
      expect(group.querySelectorAll(":scope > dt")).toHaveLength(1);
      expect(group.querySelectorAll(":scope > dd")).toHaveLength(1);
    }
  }
});

test("detail previews and submits the exact cascade plan before deleting", async () => {
  const plan = {
    id: "plan-1",
    root: { type: "ticket", id: "TICK-1", version: 4 },
    records: [
      { type: "ticket", id: "TICK-1", version: 4 },
      { type: "comment", id: "COMMENT-2", version: 1 },
    ],
    restrictedBy: [],
  };
  vi.mocked(previewRecordDelete).mockResolvedValue(plan);
  vi.mocked(deleteRecord).mockResolvedValue();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  renderWithData(<ResourceDetail />, {
    type: "ticket",
    record,
    fields,
    schemaError: undefined,
    linkLabels: {},
  });

  fireEvent.click(screen.getByRole("button", { name: "Delete" }));

  await waitFor(() => {
    expect(confirm).toHaveBeenCalledWith(
      "Delete these 2 records?\n\nticket/TICK-1\ncomment/COMMENT-2\n\nThis cannot be undone from the UI."
    );
    expect(deleteRecord).toHaveBeenCalledWith("ticket", "TICK-1", 4, plan);
  });
});

test("detail ErrorBoundary renders 404 not found for a missing record", () => {
  renderError(<DetailErrorBoundary />, new ApiError(404, "not found"), { type: "ticket" });

  expect(screen.getByText("Record not found.")).toBeVisible();
  expect(screen.getByText(/no Record matches this ID/i)).toBeVisible();
  expect(screen.getByRole("link", { name: "Back to ticket" })).toHaveAttribute(
    "href",
    "/resources/ticket"
  );
});

test("detail ErrorBoundary distinguishes a missing Resource type from a missing Record", () => {
  renderError(
    <DetailErrorBoundary />,
    new ApiError(404, "resource type not found: never-created"),
    { type: "never-created" }
  );

  expect(screen.getByText("Resource type not found.")).toBeVisible();
  expect(screen.queryByText(/no Record matches/i)).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Back to Resources" })).toHaveAttribute(
    "href",
    "/resources"
  );
});

test("schema ErrorBoundary identifies its missing entity as a Resource type", () => {
  renderError(
    <SchemaErrorBoundary />,
    new ApiError(404, "resource type not found: never-created"),
    { type: "never-created" }
  );

  expect(screen.getByText("Resource type not found.")).toBeVisible();
  expect(screen.queryByText(/Record matches/i)).not.toBeInTheDocument();
});

test("list ErrorBoundary keeps server failures distinct without leaking internals", () => {
  renderError(<ListErrorBoundary />, new ApiError(500, "database exploded"), { type: "ticket" });

  expect(screen.getByText("Resources could not be loaded.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  expect(screen.queryByText(/database exploded|check your connection/i)).not.toBeInTheDocument();
});
