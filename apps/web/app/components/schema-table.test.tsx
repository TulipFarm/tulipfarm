import { createRemixStub } from "@remix-run/testing";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { SchemaTable } from "~/components/schema-table";
import type { ResourceRecord } from "~/lib/api";
import { deriveFields, listColumns, parseSchema, type SortState } from "~/lib/schema";

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

const records: ResourceRecord[] = [
  {
    id: "TICK-1",
    title: "First",
    customerId: "CUST-9",
    open: true,
    version: 1,
    createdAt: "",
    updatedAt: "2026-06-08T00:00:00Z",
  },
  {
    id: "TICK-2",
    title: "Second",
    customerId: null,
    open: false,
    version: 1,
    createdAt: "",
    updatedAt: "2026-06-07T00:00:00Z",
  },
];

function renderTable() {
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => <SchemaTable columns={columns} records={records} type="ticket" />,
    },
  ]);
  render(<Stub initialEntries={["/"]} />);
}

test("renders schema-derived column headers including the synthesized updatedAt", () => {
  renderTable();
  for (const header of ["id", "title", "customerId", "open", "updatedAt"]) {
    expect(screen.getByRole("columnheader", { name: header })).toBeInTheDocument();
  }
});

test("the id cell links to the record detail page", () => {
  renderTable();
  expect(screen.getByRole("link", { name: /TICK-1/ })).toHaveAttribute(
    "href",
    "/resources/ticket/TICK-1"
  );
});

test("an x-links cell links to the target resource", () => {
  renderTable();
  expect(screen.getByRole("link", { name: /CUST-9/ })).toHaveAttribute(
    "href",
    "/resources/customer/CUST-9"
  );
});

test("booleans render ✓/✗ and null cells render a muted dash", () => {
  renderTable();
  expect(screen.getByText("✓")).toBeInTheDocument();
  expect(screen.getByText("✗")).toBeInTheDocument();
  expect(screen.getAllByText("—").length).toBeGreaterThan(0); // null customerId on row 2
});

function renderSortable(sort?: SortState, onToggleSort?: (c: string) => void) {
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => (
        <SchemaTable
          columns={columns}
          records={records}
          type="ticket"
          sort={sort}
          onToggleSort={onToggleSort}
        />
      ),
    },
  ]);
  render(<Stub initialEntries={["/"]} />);
}

test("without onToggleSort, headers are plain text (no sort buttons)", () => {
  renderTable();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

test("with onToggleSort, clicking a header fires the callback with the column name", () => {
  const onToggleSort = vi.fn();
  renderSortable(undefined, onToggleSort);
  fireEvent.click(screen.getByRole("button", { name: /title/ }));
  expect(onToggleSort).toHaveBeenCalledWith("title");
});

test("the active sort column carries aria-sort and a direction glyph", () => {
  renderSortable({ field: "title", dir: "asc" }, vi.fn());
  const header = screen.getByRole("columnheader", { name: /title/ });
  expect(header).toHaveAttribute("aria-sort", "ascending");
  expect(header.textContent).toContain("↑");
  // a non-active column has no aria-sort
  expect(screen.getByRole("columnheader", { name: /^id/ })).not.toHaveAttribute("aria-sort");
});

test("descending sort reflects aria-sort=descending and the ↓ glyph", () => {
  renderSortable({ field: "title", dir: "desc" }, vi.fn());
  const header = screen.getByRole("columnheader", { name: /title/ });
  expect(header).toHaveAttribute("aria-sort", "descending");
  expect(header.textContent).toContain("↓");
});
