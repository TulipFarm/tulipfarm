import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

const nestedParsed = parseSchema(`
type: object
x-id-strategy: { sequence: true, field: id }
properties:
  id: { type: string }
  metadata:
    type: object
    properties:
      address:
        type: object
        properties:
          city: { type: string }
          postcode: { type: string }
        additionalProperties: false
    required: [address]
required: [metadata]
`);
if (!nestedParsed.ok) throw new Error(nestedParsed.error);
const nestedFields = formFields(nestedParsed.schema);

function renderRoute(node: ReactElement, data: unknown) {
  vi.mocked(remix.useLoaderData).mockReturnValue(data);
  const Stub = createRemixStub([
    { path: "/", Component: () => node },
    {
      path: "/resources/:type/:id",
      Component: () => <p>destination: {remix.useLocation().pathname}</p>,
    },
    {
      path: "/resources/:type",
      Component: () => <p>destination: {remix.useLocation().pathname}</p>,
    },
  ]);
  render(<Stub initialEntries={["/"]} />);
}

afterEach(() => vi.clearAllMocks());

test("create: a successful POST navigates to the new record's detail page", async () => {
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

  expect(await screen.findByText("destination: /resources/ticket/TICK-9")).toBeInTheDocument();
  expect(createRecord).toHaveBeenCalledWith(
    "ticket",
    expect.objectContaining({ title: "New bug" })
  );
});

test("create: a 422 maps the error path onto the offending field", async () => {
  vi.mocked(createRecord).mockRejectedValue(new ApiError(422, "must be a string", "/title"));
  renderRoute(<ResourceCreate />, { type: "ticket", fields, schemaError: undefined });

  fireEvent.change(document.querySelector("input#title") as HTMLInputElement, {
    target: { value: "x" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));

  expect(await screen.findByText("must be a string")).toBeInTheDocument();
});

test.each([
  ["/metadata/address/postcode", "metadata.address.postcode: must be string"],
  ["/metadata/address/city", "metadata.address.city: must have required property 'city'"],
  [
    "/metadata/address/legacy~1code",
    'metadata.address["legacy/code"]: must NOT have additional properties',
  ],
  ["/metadata/contacts/0/postcode", "metadata.contacts[0].postcode: must be string"],
])("create: a nested 422 shows the full path under its top-level field", async (path, message) => {
  vi.mocked(createRecord).mockRejectedValue(
    new ApiError(422, message.split(": ").at(-1) ?? "", path)
  );
  renderRoute(<ResourceCreate />, {
    type: "customer",
    fields: nestedFields,
    schemaError: undefined,
  });

  const metadata = document.querySelector("textarea#metadata") as HTMLTextAreaElement;
  fireEvent.change(metadata, {
    target: { value: '{"address":{"city":"London","postcode":123}}' },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));

  expect(await screen.findByText(message)).toBeInTheDocument();
  expect(metadata.value).toBe('{"address":{"city":"London","postcode":123}}');
  expect(screen.queryByText(/^destination:/)).not.toBeInTheDocument();
});

test("create: correcting nested data after a 422 creates the Record normally", async () => {
  vi.mocked(createRecord)
    .mockRejectedValueOnce(new ApiError(422, "must be string", "/metadata/address/postcode"))
    .mockResolvedValueOnce({
      id: "CUSTOMER-1",
      version: 1,
      createdAt: "",
      updatedAt: "",
    });
  renderRoute(<ResourceCreate />, {
    type: "customer",
    fields: nestedFields,
    schemaError: undefined,
  });

  const metadata = document.querySelector("textarea#metadata") as HTMLTextAreaElement;
  fireEvent.change(metadata, {
    target: { value: '{"address":{"city":"London","postcode":123}}' },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(await screen.findByText("metadata.address.postcode: must be string")).toBeInTheDocument();

  fireEvent.change(metadata, {
    target: { value: '{"address":{"city":"London","postcode":"00123"}}' },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));

  expect(
    await screen.findByText("destination: /resources/customer/CUSTOMER-1")
  ).toBeInTheDocument();
  expect(createRecord).toHaveBeenLastCalledWith("customer", {
    metadata: { address: { city: "London", postcode: "00123" } },
  });
});

test("create: a uniqueness conflict keeps the server advice and the draft", async () => {
  vi.mocked(createRecord).mockRejectedValue(
    new ApiError(409, "duplicate value violates a unique constraint")
  );
  renderRoute(<ResourceCreate />, { type: "ticket", fields, schemaError: undefined });

  const title = document.querySelector("input#title") as HTMLInputElement;
  fireEvent.change(title, { target: { value: "Duplicate" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));

  expect(
    await screen.findByText(/duplicate value violates a unique constraint/)
  ).toBeInTheDocument();
  expect(title.value).toBe("Duplicate");
  fireEvent.click(screen.getByRole("link", { name: "Cancel" }));
  expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
});

test("edit: a 409 surfaces the version-conflict banner and does not navigate", async () => {
  vi.mocked(updateRecord).mockRejectedValue(
    new ApiError(409, "version conflict", undefined, "version conflict")
  );
  renderRoute(<ResourceEdit />, {
    type: "ticket",
    id: "TICK-1",
    record: { id: "TICK-1", title: "Old", open: false, version: 2, createdAt: "", updatedAt: "" },
    fields,
    schemaError: undefined,
  });

  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  expect(await screen.findByText(/changed since you loaded it/)).toBeInTheDocument();
  expect(screen.queryByText(/^destination:/)).not.toBeInTheDocument();
});

test("edit: a uniqueness conflict keeps the server advice and the draft", async () => {
  vi.mocked(updateRecord).mockRejectedValue(
    new ApiError(409, "duplicate value violates a unique constraint")
  );
  renderRoute(<ResourceEdit />, {
    type: "ticket",
    id: "TICK-1",
    record: { id: "TICK-1", title: "Old", open: false, version: 2, createdAt: "", updatedAt: "" },
    fields,
    schemaError: undefined,
  });

  const title = document.querySelector("input#title") as HTMLInputElement;
  fireEvent.change(title, { target: { value: "Duplicate" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  expect(
    await screen.findByText(/duplicate value violates a unique constraint/)
  ).toBeInTheDocument();
  expect(title.value).toBe("Duplicate");
});

const datedParsed = parseSchema(`
type: object
x-id-strategy: { sequence: true, field: id }
properties:
  id: { type: string }
  syncedAt: { type: string, format: date-time }
required: [syncedAt]
`);
if (!datedParsed.ok) throw new Error(datedParsed.error);
const datedFields = formFields(datedParsed.schema);

const multilineParsed = parseSchema(`
type: object
x-id-strategy: { sequence: true, field: id }
properties:
  id: { type: string }
  notes: { type: string }
`);
if (!multilineParsed.ok) throw new Error(multilineParsed.error);
const multilineFields = formFields(multilineParsed.schema);
const storedMultilineNotes = "  first\nsecond\tlast  ";

test("edit: a stored multiline string keeps its exact DOM value and update payload", async () => {
  vi.mocked(updateRecord).mockResolvedValue({
    id: "NOTE-1",
    notes: storedMultilineNotes,
    version: 2,
    createdAt: "",
    updatedAt: "",
  });
  renderRoute(<ResourceEdit />, {
    type: "note",
    id: "NOTE-1",
    record: {
      id: "NOTE-1",
      notes: storedMultilineNotes,
      version: 1,
      createdAt: "",
      updatedAt: "",
    },
    fields: multilineFields,
    schemaError: undefined,
  });

  const notes = document.querySelector("textarea#notes") as HTMLTextAreaElement | null;
  expect(notes).not.toBeNull();
  expect(notes?.value).toBe(storedMultilineNotes);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() =>
    expect(updateRecord).toHaveBeenCalledWith("note", "NOTE-1", 1, {
      notes: storedMultilineNotes,
    })
  );
});

test("edit: multiline user edits stay controlled and preserve DOM-normalized CRLF", async () => {
  vi.mocked(updateRecord).mockResolvedValue({
    id: "NOTE-1",
    notes: "  revised\nnext\tlast  ",
    version: 2,
    createdAt: "",
    updatedAt: "",
  });
  renderRoute(<ResourceEdit />, {
    type: "note",
    id: "NOTE-1",
    record: {
      id: "NOTE-1",
      notes: storedMultilineNotes,
      version: 1,
      createdAt: "",
      updatedAt: "",
    },
    fields: multilineFields,
    schemaError: undefined,
  });

  const notes = document.querySelector("textarea#notes") as HTMLTextAreaElement;
  fireEvent.change(notes, { target: { value: "  revised\r\nnext\tlast  " } });
  expect(notes.value).toBe("  revised\nnext\tlast  ");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() =>
    expect(updateRecord).toHaveBeenCalledWith("note", "NOTE-1", 1, {
      notes: "  revised\nnext\tlast  ",
    })
  );
});

test("edit: cancelling a multiline edit can keep the draft or discard without writing", async () => {
  const user = userEvent.setup();
  renderRoute(<ResourceEdit />, {
    type: "note",
    id: "NOTE-1",
    record: {
      id: "NOTE-1",
      notes: storedMultilineNotes,
      version: 1,
      createdAt: "",
      updatedAt: "",
    },
    fields: multilineFields,
    schemaError: undefined,
  });

  const notes = document.querySelector("textarea#notes") as HTMLTextAreaElement;
  await user.clear(notes);
  await user.type(notes, "changed\nnotes");
  fireEvent.click(screen.getByRole("link", { name: "Cancel" }));

  expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
  expect(screen.queryByText(/^destination:/)).not.toBeInTheDocument();
  expect(updateRecord).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  expect(notes).toHaveValue("changed\nnotes");

  fireEvent.click(screen.getByRole("link", { name: "Cancel" }));
  await user.click(await screen.findByRole("button", { name: "Discard changes" }));
  expect(await screen.findByText("destination: /resources/note/NOTE-1")).toBeInTheDocument();
  expect(updateRecord).not.toHaveBeenCalled();
});

test("edit: untouched and reset drafts navigate without a warning", async () => {
  const user = userEvent.setup();
  renderRoute(<ResourceEdit />, {
    type: "ticket",
    id: "TICK-1",
    record: { id: "TICK-1", title: "Old", open: false, version: 2, createdAt: "", updatedAt: "" },
    fields,
    schemaError: undefined,
  });

  const title = screen.getByLabelText(/^title/);
  await user.clear(title);
  await user.type(title, "Changed");
  expect(dispatchUnload()).toBe(true);
  await user.clear(title);
  await user.type(title, "Old");
  expect(dispatchUnload()).toBe(false);
  fireEvent.click(screen.getByRole("link", { name: "Cancel" }));

  expect(await screen.findByText("destination: /resources/ticket/TICK-1")).toBeInTheDocument();
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(updateRecord).not.toHaveBeenCalled();
});

test("create: checkbox changes are guarded and resetting them restores fast navigation", async () => {
  const user = userEvent.setup();
  renderRoute(<ResourceCreate />, { type: "ticket", fields, schemaError: undefined });

  const checkbox = screen.getByLabelText("open");
  await user.click(checkbox);
  expect(dispatchUnload()).toBe(true);
  fireEvent.click(screen.getByRole("link", { name: "Cancel" }));
  expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  await user.click(checkbox);
  expect(dispatchUnload()).toBe(false);
  await user.click(screen.getByRole("link", { name: "Cancel" }));

  expect(await screen.findByText("destination: /resources/ticket")).toBeInTheDocument();
  expect(createRecord).not.toHaveBeenCalled();
});

test("create: a datetime-local field is submitted as RFC 3339, not the browser's local string", async () => {
  vi.mocked(createRecord).mockResolvedValue({
    id: "S-1",
    version: 1,
    createdAt: "",
    updatedAt: "",
  });
  renderRoute(<ResourceCreate />, { type: "sync", fields: datedFields, schemaError: undefined });

  const input = document.querySelector("input#syncedAt") as HTMLInputElement;
  expect(input.type).toBe("datetime-local");
  // What the control actually yields: no seconds, no offset. The API's date-time format rejects it.
  fireEvent.change(input, { target: { value: "2026-08-29T10:15" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));

  await waitFor(() => expect(createRecord).toHaveBeenCalled());
  const sent = vi.mocked(createRecord).mock.calls[0][1] as { syncedAt: string };
  expect(sent.syncedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  expect(new Date(sent.syncedAt).getTime()).toBe(new Date("2026-08-29T10:15").getTime());
});

test("create: an existing RFC 3339 value round-trips back into the local control", () => {
  const iso = new Date("2026-08-29T10:15").toISOString();
  renderRoute(<ResourceEdit />, {
    type: "sync",
    id: "S-1",
    record: { id: "S-1", syncedAt: iso, version: 1, createdAt: "", updatedAt: "" },
    fields: datedFields,
    schemaError: undefined,
  });

  expect((document.querySelector("input#syncedAt") as HTMLInputElement).value).toBe(
    "2026-08-29T10:15"
  );
});

function dispatchUnload(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
