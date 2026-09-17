import { createRemixStub } from "@remix-run/testing";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { expect, test, vi } from "vitest";
import { parseNumberInput, ResourceForm } from "~/components/resource-form";
import { formFields, parseSchema } from "~/lib/schema";

// LinkCombobox (rendered for the customerId field) calls listRecords on mount — mock it, keep the
// real ApiError that resource-form imports for writeErrorState.
vi.mock("~/lib/api", async () => {
  const actual = await vi.importActual<typeof import("~/lib/api")>("~/lib/api");
  // Stays pending: these tests don't exercise the combobox, and a late resolve would setState
  // after the assertions (act warning). The combobox's own loading path is covered separately.
  return { ...actual, listRecords: vi.fn(() => new Promise<never>(() => {})) };
});

const parsed = parseSchema(`
type: object
x-id-strategy: { sequence: true, field: id }
properties:
  id: { type: string }
  title: { type: string, x-immutable: true }
  email: { type: string, format: email }
  customerId: { type: string, x-links: { target: customer } }
  priority: { type: string, enum: [low, high] }
  count: { type: integer }
  ratio: { type: number }
  open: { type: boolean }
  tags: { type: array }
required: [title, open]
`);
if (!parsed.ok) throw new Error(parsed.error);
const fields = formFields(parsed.schema);

const calendarParsed = parseSchema(`
type: object
properties:
  title: { type: string }
  dueDate: { type: string, format: date }
required: [title]
`);
if (!calendarParsed.ok) throw new Error(calendarParsed.error);
const calendarFields = formFields(calendarParsed.schema);

const booleanParsed = parseSchema(`
type: object
properties:
  title: { type: string }
  active: { type: boolean }
  reviewed: { type: boolean }
  subscribed: { type: boolean, default: true }
  archived: { type: boolean, default: false }
required: [title, active]
`);
if (!booleanParsed.ok) throw new Error(booleanParsed.error);
const booleanFields = formFields(booleanParsed.schema);

const relationshipParsed = parseSchema(`
type: object
properties:
  title: { type: string }
  customerId: { type: string, x-links: { target: customer } }
  ownerId: { type: string, x-links: { target: customer } }
required: [title, ownerId]
`);
if (!relationshipParsed.ok) throw new Error(relationshipParsed.error);
const relationshipFields = formFields(relationshipParsed.schema);

function renderForm(node: ReactElement) {
  const Stub = createRemixStub([{ path: "/", Component: () => node }]);
  return render(<Stub initialEntries={["/"]} />);
}

test("renders one control per kind following the Tulip Surface Protocol mapping", () => {
  const { container } = renderForm(
    <ResourceForm
      fields={fields}
      mode="create"
      onSubmit={vi.fn()}
      submitting={false}
      cancelTo="/"
    />
  );
  expect(container.querySelector("input#title[type=text]")).toBeTruthy();
  expect(container.querySelector("input#email[type=text]")).toBeTruthy();
  expect(container.querySelector("input#customerId[role=combobox]")).toBeTruthy(); // x-links
  expect(container.querySelector("select#priority")).toBeTruthy(); // enum
  expect(container.querySelector("input#count[type=number]")).toBeTruthy();
  expect(container.querySelector("input#ratio[type=number]")).toBeTruthy();
  expect(container.querySelector("input#open[type=checkbox]")).toBeTruthy();
  expect(container.querySelector("textarea#tags")).toBeTruthy(); // array as JSON
});

test("marks required fields and excludes the sequence-generated id", () => {
  const { container } = renderForm(
    <ResourceForm
      fields={fields}
      mode="create"
      onSubmit={vi.fn()}
      submitting={false}
      cancelTo="/"
    />
  );
  expect(container.querySelector("input#id")).toBeNull();
  expect(screen.getAllByText("*")).toHaveLength(2);
});

test("x-immutable field is read-only on edit and its value is carried into the payload", () => {
  const onSubmit = vi.fn();
  const { container } = renderForm(
    <ResourceForm
      fields={fields}
      mode="edit"
      initial={{ title: "Locked", count: 3, open: true }}
      onSubmit={onSubmit}
      submitting={false}
      cancelTo="/"
    />
  );
  const title = container.querySelector("input#title") as HTMLInputElement;
  expect(title.disabled).toBe(true);
  expect(title.value).toBe("Locked");

  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Locked", count: 3, open: true }),
    expect.any(Function)
  );
});

test("submit coerces typed values and omits empty optional fields", () => {
  const onSubmit = vi.fn();
  const { container } = renderForm(
    <ResourceForm
      fields={fields}
      mode="create"
      onSubmit={onSubmit}
      submitting={false}
      cancelTo="/"
    />
  );
  fireEvent.change(container.querySelector("input#title") as HTMLInputElement, {
    target: { value: "Hello" },
  });
  fireEvent.change(container.querySelector("input#count") as HTMLInputElement, {
    target: { value: "5" },
  });
  fireEvent.click(container.querySelector("input#open") as HTMLInputElement);

  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(onSubmit).toHaveBeenCalledWith(
    { title: "Hello", count: 5, open: true },
    expect.any(Function)
  );
});

test("invalid native calendar drafts block submit and remain available for correction", () => {
  const onSubmit = vi.fn();
  const { container } = renderForm(
    <ResourceForm
      fields={calendarFields}
      mode="create"
      onSubmit={onSubmit}
      submitting={false}
      cancelTo="/"
    />
  );
  const title = container.querySelector("input#title") as HTMLInputElement;
  const dueDate = container.querySelector("input#dueDate") as HTMLInputElement;
  let invalidDraft = true;
  Object.defineProperty(dueDate, "validity", {
    configurable: true,
    get: () => ({ badInput: invalidDraft, valid: !invalidDraft }),
  });
  dueDate.dataset.nativeDraft = "29/02/2027";

  fireEvent.change(title, { target: { value: "Invalid draft" } });
  fireEvent.change(dueDate, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));

  expect(onSubmit).not.toHaveBeenCalled();
  const dateError = screen.getByText("enter a valid calendar date");
  expect(dateError).toBeVisible();
  expect(dueDate).toHaveAttribute("aria-invalid", "true");
  expect(dueDate).toHaveAttribute("aria-describedby", dateError.id);
  expect(dueDate).toHaveFocus();
  expect(container.querySelector("input#dueDate")).toBe(dueDate);
  expect(dueDate.dataset.nativeDraft).toBe("29/02/2027");
  expect(title.value).toBe("Invalid draft");

  invalidDraft = false;
  fireEvent.change(dueDate, { target: { value: "2028-02-29" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));

  expect(onSubmit).toHaveBeenCalledWith(
    { title: "Invalid draft", dueDate: "2028-02-29" },
    expect.any(Function)
  );
});

test("an intentionally cleared optional calendar field remains omittable", () => {
  const onSubmit = vi.fn();
  const { container } = renderForm(
    <ResourceForm
      fields={calendarFields}
      mode="create"
      onSubmit={onSubmit}
      submitting={false}
      cancelTo="/"
    />
  );
  const dueDate = container.querySelector("input#dueDate") as HTMLInputElement;
  Object.defineProperty(dueDate, "validity", {
    configurable: true,
    get: () => ({ badInput: false, valid: true }),
  });

  fireEvent.change(container.querySelector("input#title") as HTMLInputElement, {
    target: { value: "No due date" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));

  expect(onSubmit).toHaveBeenCalledWith({ title: "No due date" }, expect.any(Function));
});

test("numeric fields accept exact large integers, scientific notation, and ordinary decimals", () => {
  const onSubmit = vi.fn();
  const { container } = renderForm(
    <ResourceForm
      fields={fields}
      mode="create"
      onSubmit={onSubmit}
      submitting={false}
      cancelTo="/"
    />
  );
  const count = container.querySelector("input#count") as HTMLInputElement;
  const ratio = container.querySelector("input#ratio") as HTMLInputElement;

  fireEvent.change(count, { target: { value: "9007199254740992" } });
  fireEvent.change(ratio, { target: { value: "-9.007199254740992e15" } });
  expect(count.value).toBe("9007199254740992");
  expect(ratio.value).toBe("-9.007199254740992e15");
  fireEvent.click(screen.getByRole("button", { name: "Create" }));

  expect(onSubmit).toHaveBeenCalledWith(
    { count: 9007199254740992, ratio: -9007199254740992, open: false },
    expect.any(Function)
  );
});

test("numeric fields accept decimal text whose JSON representation keeps the same value", () => {
  const onSubmit = vi.fn();
  const { container } = renderForm(
    <ResourceForm
      fields={fields}
      mode="create"
      onSubmit={onSubmit}
      submitting={false}
      cancelTo="/"
    />
  );
  const ratio = container.querySelector("input#ratio") as HTMLInputElement;

  fireEvent.change(ratio, { target: { value: "0.1" } });
  expect(ratio.value).toBe("0.1");
  fireEvent.click(screen.getByRole("button", { name: "Create" }));

  expect(onSubmit).toHaveBeenCalledWith({ ratio: 0.1, open: false }, expect.any(Function));
});

test.each([
  ["9007199254740993", /cannot be represented without changing its value/i],
  ["-9007199254740993", /cannot be represented without changing its value/i],
  ["9.007199254740993e15", /cannot be represented without changing its value/i],
  ["0.10000000000000001", /cannot be represented without changing its value/i],
])("numeric field blocks lossy input %s", (raw, expectedError) => {
  const onSubmit = vi.fn();
  const { container } = renderForm(
    <ResourceForm
      fields={fields}
      mode="create"
      onSubmit={onSubmit}
      submitting={false}
      cancelTo="/"
    />
  );
  const ratio = container.querySelector("input#ratio") as HTMLInputElement;

  fireEvent.change(ratio, { target: { value: raw } });
  expect(ratio.value).toBe(raw);
  fireEvent.click(screen.getByRole("button", { name: "Create" }));

  expect(onSubmit).not.toHaveBeenCalled();
  const error = screen.getByText(expectedError);
  expect(error).toBeVisible();
  expect(ratio).toHaveAttribute("aria-invalid", "true");
  expect(ratio).toHaveAttribute("aria-describedby", error.id);
  expect(ratio).toHaveFocus();
  expect(ratio.value).toBe(raw);
});

test.each(["NaN", "Infinity", "-Infinity", "1e309", "-1e309"])(
  "numeric parsing rejects non-finite value %s",
  (raw) => {
    expect(parseNumberInput(raw)).toEqual({ ok: false, error: "must be a finite number" });
  }
);

test("numeric parsing rejects negative zero because JSON serialization changes it", () => {
  expect(parseNumberInput("-0")).toEqual({
    ok: false,
    error: "cannot be represented without changing its value",
  });
});

test("create omits untouched optional booleans and honors required and defaulted values", () => {
  const onSubmit = vi.fn();
  const { container } = renderForm(
    <ResourceForm
      fields={booleanFields}
      mode="create"
      onSubmit={onSubmit}
      submitting={false}
      cancelTo="/"
    />
  );
  fireEvent.change(container.querySelector("input#title") as HTMLInputElement, {
    target: { value: "Sample" },
  });

  fireEvent.click(screen.getByRole("button", { name: "Create" }));

  expect(onSubmit).toHaveBeenCalledWith(
    { title: "Sample", active: false, subscribed: true, archived: false },
    expect.any(Function)
  );
});

test("title-only edit preserves an omitted optional boolean", () => {
  const onSubmit = vi.fn();
  const { container } = renderForm(
    <ResourceForm
      fields={booleanFields}
      mode="edit"
      initial={{ title: "Before", active: false }}
      onSubmit={onSubmit}
      submitting={false}
      cancelTo="/"
    />
  );
  fireEvent.change(container.querySelector("input#title") as HTMLInputElement, {
    target: { value: "After" },
  });

  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  expect(onSubmit).toHaveBeenCalledWith({ title: "After", active: false }, expect.any(Function));
});

test("clearing an optional relationship omits it from the full-replace payload", () => {
  const onSubmit = vi.fn();
  renderForm(
    <ResourceForm
      fields={relationshipFields}
      mode="edit"
      initial={{ title: "Ticket", customerId: "CUST-1", ownerId: "CUST-2" }}
      onSubmit={onSubmit}
      submitting={false}
      cancelTo="/"
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "Clear customerId selection" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  expect(onSubmit).toHaveBeenCalledWith(
    { title: "Ticket", ownerId: "CUST-2" },
    expect.any(Function)
  );
  expect(screen.queryByRole("button", { name: "Clear ownerId selection" })).not.toBeInTheDocument();
});

test("optional booleans expose unset, true, and false as distinct payload states", async () => {
  const onSubmit = vi.fn();
  renderForm(
    <ResourceForm
      fields={booleanFields}
      mode="create"
      onSubmit={onSubmit}
      submitting={false}
      cancelTo="/"
    />
  );

  const reviewed = screen.getByRole("radiogroup", { name: "reviewed" });
  expect(within(reviewed).getByRole("radio", { name: "Unset" })).toBeChecked();

  fireEvent.click(within(reviewed).getByRole("radio", { name: "True" }));
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() =>
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ reviewed: true }),
      expect.any(Function)
    )
  );

  fireEvent.click(within(reviewed).getByRole("radio", { name: "False" }));
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() =>
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ reviewed: false }),
      expect.any(Function)
    )
  );

  fireEvent.click(within(reviewed).getByRole("radio", { name: "Unset" }));
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(onSubmit.mock.calls.at(-1)?.[0]).not.toHaveProperty("reviewed"));
});

test("edit preserves an explicit optional false", () => {
  const onSubmit = vi.fn();
  renderForm(
    <ResourceForm
      fields={booleanFields}
      mode="edit"
      initial={{ title: "Sample", active: true, reviewed: false }}
      onSubmit={onSubmit}
      submitting={false}
      cancelTo="/"
    />
  );

  const reviewed = screen.getByRole("radiogroup", { name: "reviewed" });
  expect(within(reviewed).getByRole("radio", { name: "False" })).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(onSubmit).toHaveBeenCalledWith(
    { title: "Sample", active: true, reviewed: false },
    expect.any(Function)
  );
});

test("resetting an optional boolean to its original absence clears dirty state", () => {
  const onSubmit = vi.fn();
  renderForm(
    <ResourceForm
      fields={booleanFields}
      mode="create"
      onSubmit={onSubmit}
      submitting={false}
      cancelTo="/"
    />
  );
  const reviewed = screen.getByRole("radiogroup", { name: "reviewed" });

  fireEvent.click(within(reviewed).getByRole("radio", { name: "True" }));
  expect(dispatchUnload()).toBe(true);

  fireEvent.click(within(reviewed).getByRole("radio", { name: "Unset" }));
  expect(dispatchUnload()).toBe(false);
  expect(onSubmit).not.toHaveBeenCalled();
});

test("submits enum values with their schema primitive types", () => {
  const enumSchema = parseSchema(`
type: object
properties:
  score: { type: integer, enum: [1, 2] }
  visible: { type: boolean, enum: [true, false] }
  label: { type: string, enum: [low, high] }
  optional: { type: string, enum: [one, two] }
required: [score, visible, label]
`);
  if (!enumSchema.ok) throw new Error(enumSchema.error);
  const onSubmit = vi.fn();
  const { container } = renderForm(
    <ResourceForm
      fields={formFields(enumSchema.schema)}
      mode="create"
      onSubmit={onSubmit}
      submitting={false}
      cancelTo="/"
    />
  );

  fireEvent.change(container.querySelector("select#score") as HTMLSelectElement, {
    target: { value: "enum:1" },
  });
  fireEvent.change(container.querySelector("select#visible") as HTMLSelectElement, {
    target: { value: "enum:1" },
  });
  fireEvent.change(container.querySelector("select#label") as HTMLSelectElement, {
    target: { value: "enum:0" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));

  expect(onSubmit).toHaveBeenCalledWith(
    { score: 2, visible: false, label: "low" },
    expect.any(Function)
  );
});

test("mixed enum choices preserve native values and keep null distinct from omission", () => {
  const enumSchema = parseSchema(`
type: object
properties:
  choice:
    type: [string, integer, "null"]
    enum: ["1", 1, null]
`);
  if (!enumSchema.ok) throw new Error(enumSchema.error);
  const optionForm = renderForm(
    <ResourceForm
      fields={formFields(enumSchema.schema)}
      mode="create"
      onSubmit={vi.fn()}
      submitting={false}
      cancelTo="/"
    />
  );
  const select = optionForm.container.querySelector("select#choice") as HTMLSelectElement;

  expect(Array.from(select.options).map((option) => option.text)).toEqual([
    "Not set",
    "1 (string)",
    "1 (number)",
    "Null",
  ]);
  optionForm.unmount();

  for (const [selection, expected] of [
    ["", {}],
    ["enum:0", { choice: "1" }],
    ["enum:1", { choice: 1 }],
    ["enum:2", { choice: null }],
  ] as const) {
    const onSubmit = vi.fn();
    const form = renderForm(
      <ResourceForm
        fields={formFields(enumSchema.schema)}
        mode="create"
        onSubmit={onSubmit}
        submitting={false}
        cancelTo="/"
      />
    );
    const choice = form.container.querySelector("select#choice") as HTMLSelectElement;
    if (selection !== "") fireEvent.change(choice, { target: { value: selection } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onSubmit).toHaveBeenCalledWith(expected, expect.any(Function));
    form.unmount();
  }
});

test("edit selects explicit null and preserves an invalid current enum value", () => {
  const enumSchema = parseSchema(`
type: object
properties:
  choice:
    type: [string, integer, "null"]
    enum: ["1", 1, null]
`);
  if (!enumSchema.ok) throw new Error(enumSchema.error);
  const enumFields = formFields(enumSchema.schema);
  const nullSubmit = vi.fn();
  const nullForm = renderForm(
    <ResourceForm
      fields={enumFields}
      mode="edit"
      initial={{ choice: null }}
      onSubmit={nullSubmit}
      submitting={false}
      cancelTo="/"
    />
  );
  const nullSelect = nullForm.container.querySelector("select#choice") as HTMLSelectElement;
  expect(nullSelect.value).toBe("enum:2");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(nullSubmit).toHaveBeenCalledWith({ choice: null }, expect.any(Function));
  nullForm.unmount();

  const invalidSubmit = vi.fn();
  const invalidForm = renderForm(
    <ResourceForm
      fields={enumFields}
      mode="edit"
      initial={{ choice: "legacy" }}
      onSubmit={invalidSubmit}
      submitting={false}
      cancelTo="/"
    />
  );
  const invalidSelect = invalidForm.container.querySelector("select#choice") as HTMLSelectElement;
  expect(invalidSelect.value).toBe("current");
  expect(invalidSelect.selectedOptions[0]?.text).toBe("legacy (current value, not allowed)");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(invalidSubmit).toHaveBeenCalledWith({ choice: "legacy" }, expect.any(Function));
});

test("ordinary string enums keep their concise labels", () => {
  const { container } = renderForm(
    <ResourceForm
      fields={fields}
      mode="create"
      onSubmit={vi.fn()}
      submitting={false}
      cancelTo="/"
    />
  );

  const priority = container.querySelector("select#priority") as HTMLSelectElement;
  expect(Array.from(priority.options).map((option) => option.text)).toEqual([
    "Not set",
    "low",
    "high",
  ]);
});

test("structured enum choices are disclosed and an existing value is preserved", () => {
  const enumSchema = parseSchema(`
type: object
properties:
  choice:
    enum: [one, { label: two }]
`);
  if (!enumSchema.ok) throw new Error(enumSchema.error);
  const onSubmit = vi.fn();
  const { container } = renderForm(
    <ResourceForm
      fields={formFields(enumSchema.schema)}
      mode="edit"
      initial={{ choice: { label: "two" } }}
      onSubmit={onSubmit}
      submitting={false}
      cancelTo="/"
    />
  );

  expect(screen.getByText("Structured enum choices are not supported by this form.")).toBeVisible();
  const choice = container.querySelector("select#choice") as HTMLSelectElement;
  expect(choice.selectedOptions[0]?.text).toBe('{"label":"two"} (current value, not allowed)');
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(onSubmit).toHaveBeenCalledWith({ choice: { label: "two" } }, expect.any(Function));
});

test("invalid JSON in an array/object field blocks submit and exposes an accessible error", () => {
  const onSubmit = vi.fn();
  const { container } = renderForm(
    <ResourceForm
      fields={fields}
      mode="create"
      onSubmit={onSubmit}
      submitting={false}
      cancelTo="/"
    />
  );
  fireEvent.change(container.querySelector("input#title") as HTMLInputElement, {
    target: { value: "Hello" },
  });
  fireEvent.change(container.querySelector("textarea#tags") as HTMLTextAreaElement, {
    target: { value: "not json" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));

  expect(onSubmit).not.toHaveBeenCalled();
  const tags = container.querySelector("textarea#tags") as HTMLTextAreaElement;
  const error = screen.getByText("invalid JSON");
  expect(error).toHaveAttribute("id");
  expect(tags).toHaveAttribute("aria-invalid", "true");
  expect(tags).toHaveAttribute("aria-describedby", error.id);
  expect(tags).toHaveFocus();
  expect(screen.getByRole("alert")).toHaveTextContent(/1 field needs attention/i);

  fireEvent.change(tags, { target: { value: '["fixed"]' } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));

  expect(onSubmit).toHaveBeenCalledOnce();
  expect(screen.queryByText("invalid JSON")).not.toBeInTheDocument();
  expect(tags).not.toHaveAttribute("aria-invalid");
  expect(tags).not.toHaveAttribute("aria-describedby");
});

test("associates server errors with every Resource field control kind", async () => {
  const { container } = renderForm(
    <ResourceForm
      fields={fields}
      mode="create"
      onSubmit={vi.fn()}
      submitting={false}
      fieldErrors={{
        email: "must be an email",
        customerId: "linked Record not found",
        priority: "must be low or high",
        count: "must be an integer",
        open: "must be a Boolean",
        tags: "must be an array",
      }}
      cancelTo="/"
    />
  );

  const controls = [
    container.querySelector("input#email"),
    container.querySelector("input#customerId"),
    container.querySelector("select#priority"),
    container.querySelector("input#count"),
    container.querySelector("input#open"),
    container.querySelector("textarea#tags"),
  ];
  for (const control of controls) {
    expect(control).toHaveAttribute("aria-invalid", "true");
    expect(control).toHaveAttribute("aria-describedby");
  }
  const ids = [...container.querySelectorAll("[id]")].map((element) => element.id);
  expect(new Set(ids).size).toBe(ids.length);
  await waitFor(() => expect(container.querySelector("input#email")).toHaveFocus());
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.getByRole("alert")).toHaveTextContent(/6 fields need attention/i);
});

test("associates an optional Boolean group error with its inline message", async () => {
  renderForm(
    <ResourceForm
      fields={booleanFields}
      mode="create"
      onSubmit={vi.fn()}
      submitting={false}
      fieldErrors={{ reviewed: "choose a valid value" }}
      cancelTo="/"
    />
  );

  const reviewed = screen.getByRole("radiogroup", { name: "reviewed" });
  const error = screen.getByText("choose a valid value");
  expect(reviewed).toHaveAttribute("aria-invalid", "true");
  expect(reviewed).toHaveAttribute("aria-describedby", error.id);
  await waitFor(() => expect(reviewed).toHaveFocus());
});

test("associates a multiline string error with its textarea", async () => {
  const multilineParsed = parseSchema(`
type: object
properties:
  notes: { type: string }
`);
  if (!multilineParsed.ok) throw new Error(multilineParsed.error);
  renderForm(
    <ResourceForm
      fields={formFields(multilineParsed.schema)}
      mode="edit"
      initial={{ notes: "first line\nsecond line" }}
      onSubmit={vi.fn()}
      submitting={false}
      fieldErrors={{ notes: "must be shorter" }}
      cancelTo="/"
    />
  );

  const notes = screen.getByRole("textbox", { name: "notes" });
  const error = screen.getByText("must be shorter");
  expect(notes.tagName).toBe("TEXTAREA");
  expect(notes).toHaveAttribute("aria-invalid", "true");
  expect(notes).toHaveAttribute("aria-describedby", error.id);
  await waitFor(() => expect(notes).toHaveFocus());
});

test("focuses and announces a form-level error without marking a field invalid", async () => {
  const { container } = renderForm(
    <ResourceForm
      fields={fields}
      mode="create"
      onSubmit={vi.fn()}
      submitting={false}
      formError="service unavailable"
      cancelTo="/"
    />
  );

  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent("service unavailable");
  await waitFor(() => expect(alert).toHaveFocus());
  expect(container.querySelector("[aria-invalid=true]")).toBeNull();
});

test("announces an unmapped server error instead of leaving it inaccessible", async () => {
  renderForm(
    <ResourceForm
      fields={fields}
      mode="create"
      onSubmit={vi.fn()}
      submitting={false}
      fieldErrors={{ unknown: "could not validate this value" }}
      cancelTo="/"
    />
  );

  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent("unknown: could not validate this value");
  await waitFor(() => expect(alert).toHaveFocus());
});

function dispatchUnload(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
