import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError, createRecord, updateRecord } from "~/lib/api";
import { formFields, parseSchema } from "~/lib/schema";
import ResourceEdit from "./_app.resources.$type.$id_.edit";
import ResourceCreate from "./_app.resources.$type.new";

vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return {
    ...actual,
    useLoaderData: vi.fn(),
    useNavigate: vi.fn(),
    useParams: vi.fn(() => ({})),
  };
});

vi.mock("~/lib/api", async () => {
  const actual = await vi.importActual<typeof import("~/lib/api")>("~/lib/api");
  return {
    ...actual,
    listRecords: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    createRecord: vi.fn(),
    updateRecord: vi.fn(),
  };
});

const parsed = parseSchema(`
type: object
x-id-strategy: { sequence: true, field: id }
properties:
  id: { type: string }
  title: { type: string }
  open: { type: boolean }
required: [title]
`);
if (!parsed.ok) throw new Error(parsed.error);
const fields = formFields(parsed.schema);

function renderRoute(node: ReactElement, data: unknown) {
  vi.mocked(remix.useLoaderData).mockReturnValue(data);
  const Stub = createRemixStub([{ path: "/", Component: () => node }]);
  render(<Stub initialEntries={["/"]} />);
}

afterEach(() => vi.clearAllMocks());

test("create: a successful POST navigates to the new record's detail page", async () => {
  const navigate = vi.fn();
  vi.mocked(remix.useNavigate).mockReturnValue(navigate);
  vi.mocked(createRecord).mockResolvedValue({
    id: "TICK-9",
    version: 1,
    createdAt: "",
    updatedAt: "",
  });
  renderRoute(<ResourceCreate />, { type: "ticket", fields, schemaError: undefined });

  fireEvent.change(document.querySelector("input#title") as HTMLInputElement, {
    target: { value: "New bug" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));

  await waitFor(() => expect(navigate).toHaveBeenCalledWith("/resources/ticket/TICK-9"));
  expect(createRecord).toHaveBeenCalledWith(
    "ticket",
    expect.objectContaining({ title: "New bug" })
  );
});

test("create: a 422 maps the error path onto the offending field", async () => {
  vi.mocked(remix.useNavigate).mockReturnValue(vi.fn());
  vi.mocked(createRecord).mockRejectedValue(new ApiError(422, "must be a string", "/title"));
  renderRoute(<ResourceCreate />, { type: "ticket", fields, schemaError: undefined });

  fireEvent.change(document.querySelector("input#title") as HTMLInputElement, {
    target: { value: "x" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));

  expect(await screen.findByText("must be a string")).toBeInTheDocument();
});

test("edit: a 409 surfaces the version-conflict banner and does not navigate", async () => {
  const navigate = vi.fn();
  vi.mocked(remix.useNavigate).mockReturnValue(navigate);
  vi.mocked(updateRecord).mockRejectedValue(new ApiError(409, "version conflict"));
  renderRoute(<ResourceEdit />, {
    type: "ticket",
    id: "TICK-1",
    record: { id: "TICK-1", title: "Old", open: false, version: 2, createdAt: "", updatedAt: "" },
    fields,
    schemaError: undefined,
  });

  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  expect(await screen.findByText(/changed since you loaded it/)).toBeInTheDocument();
  expect(navigate).not.toHaveBeenCalled();
});
