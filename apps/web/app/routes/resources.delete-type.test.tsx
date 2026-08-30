import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  availableColumns,
  deriveFields,
  detailFields,
  listColumns,
  parseSchema,
} from "~/lib/schema";
import ResourceList from "./_app.resources.$type._index";

/* Render the route directly because real data navigation creates jsdom-undici AbortSignal issues. */

vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return { ...actual, useLoaderData: vi.fn(), useNavigate: vi.fn() };
});

vi.mock("~/lib/api", async () => {
  const actual = await vi.importActual<typeof import("~/lib/api")>("~/lib/api");
  return { ...actual, deleteResourceType: vi.fn(), listRecords: vi.fn() };
});

const api = await import("~/lib/api");

const parsed = parseSchema(`
type: object
x-id-strategy: { field: id }
properties:
  id: { type: string }
  title: { type: string }
`);
if (!parsed.ok) throw new Error(parsed.error);
const fields = deriveFields(parsed.schema);
const columns = availableColumns(fields, parsed.schema);

const navigate = vi.fn();
let confirmSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.mocked(remix.useNavigate).mockReturnValue(navigate);
  vi.mocked(remix.useLoaderData).mockReturnValue({
    type: "ticket",
    domain: null,
    hasHooks: false,
    idStrategy: { field: "id" },
    schemaFields: detailFields(fields, parsed.schema),
    idField: "id",
    linkTargets: [],
    columns,
    defaultColumns: listColumns(fields, parsed.schema).map((c) => c.name),
    schemaError: undefined,
    items: [],
    nextCursor: null,
    recordCount: 0,
    lastUpdatedAt: null,
  });
  vi.mocked(api.deleteResourceType).mockResolvedValue(undefined);
  confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
  confirmSpy.mockRestore();
});

function renderList() {
  const Stub = createRemixStub([{ path: "/", Component: () => <ResourceList /> }]);
  render(<Stub initialEntries={["/"]} />);
}

// A closed <dialog> is absent from the accessibility tree, and Modal only opens it in an effect —
// every dialog query here must be async or it races that effect.
async function openDeleteTypeDialog() {
  renderList();
  fireEvent.click(screen.getByRole("button", { name: /delete type/i }));
  return await screen.findByRole("dialog");
}

test("Delete type asks for confirmation in an in-app dialog, not window.confirm", async () => {
  const dialog = await openDeleteTypeDialog();
  expect(dialog).toBeInTheDocument();
  expect(confirmSpy).not.toHaveBeenCalled();
});

test("the Delete type dialog names the type and what survives the delete", async () => {
  const dialog = await openDeleteTypeDialog();
  expect(dialog.textContent).toContain("ticket");
  expect(dialog.textContent).toMatch(/records are kept/i);
});

test("Delete type does not call the API until the dialog is confirmed", async () => {
  const dialog = await openDeleteTypeDialog();
  expect(api.deleteResourceType).not.toHaveBeenCalled();

  fireEvent.click(within(dialog).getByRole("button", { name: /delete type/i }));
  await waitFor(() => expect(api.deleteResourceType).toHaveBeenCalledWith("ticket"));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith("/resources"));
});

test("cancelling the Delete type dialog leaves the type alone", async () => {
  const dialog = await openDeleteTypeDialog();
  fireEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));
  expect(api.deleteResourceType).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
