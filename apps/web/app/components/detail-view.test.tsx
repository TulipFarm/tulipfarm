import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { DetailView } from "~/components/detail-view";
import type { ResourceRecord } from "~/lib/api";
import { deriveFields, detailFields, parseSchema } from "~/lib/schema";

const parsed = parseSchema(`
type: object
properties:
  id: { type: string }
  title: { type: string }
  customerId: { type: string, x-links: { target: customer } }
  open: { type: boolean }
`);
if (!parsed.ok) throw new Error(parsed.error);
const fields = detailFields(deriveFields(parsed.schema), parsed.schema);

const record: ResourceRecord = {
  id: "TICK-1",
  title: "Login 500",
  customerId: "CUST-9",
  open: true,
  version: 4,
  createdAt: "2026-06-01T09:12:00Z",
  updatedAt: "2026-06-08T14:03:00Z",
};

function renderDetail() {
  const Stub = createRemixStub([
    { path: "/", Component: () => <DetailView fields={fields} record={record} /> },
  ]);
  render(<Stub initialEntries={["/"]} />);
}

test("renders every schema field with its value", () => {
  renderDetail();
  expect(screen.getByText("title")).toBeInTheDocument();
  expect(screen.getByText("Login 500")).toBeInTheDocument();
});

test("renders an x-links field as a link to the target resource", () => {
  renderDetail();
  expect(screen.getByRole("link", { name: /CUST-9/ })).toHaveAttribute(
    "href",
    "/resources/customer/CUST-9"
  );
});

test("separates a System block carrying version and timestamps", () => {
  renderDetail();
  expect(screen.getByText("System")).toBeInTheDocument();
  expect(screen.getByText("version")).toBeInTheDocument();
  expect(screen.getByText("4")).toBeInTheDocument();
});
