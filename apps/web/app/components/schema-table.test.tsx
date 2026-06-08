import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { SchemaTable } from "~/components/schema-table";
import type { ResourceRecord } from "~/lib/api";
import { deriveFields, listColumns, parseSchema } from "~/lib/schema";

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
