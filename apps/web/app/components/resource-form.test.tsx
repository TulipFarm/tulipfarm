import { createRemixStub } from "@remix-run/testing";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { expect, test, vi } from "vitest";
import { ResourceForm } from "~/components/resource-form";
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
  customerId: { type: string, x-links: { target: customer } }
  priority: { type: string, enum: [low, high] }
  level: { type: integer, enum: [1, 2, 3] }
  count: { type: integer }
  open: { type: boolean }
  due: { type: string, format: date }
  at: { type: string, format: date-time }
  tags: { type: array }
required: [title]
`);
if (!parsed.ok) throw new Error(parsed.error);
const fields = formFields(parsed.schema);

function renderForm(node: ReactElement) {
  const Stub = createRemixStub([{ path: "/", Component: () => node }]);
  return render(<Stub initialEntries={["/"]} />);
}

test("renders one control per kind following the A2UI mapping", () => {
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
  expect(container.querySelector("input#customerId[role=combobox]")).toBeTruthy(); // x-links
  expect(container.querySelector("select#priority")).toBeTruthy(); // enum
  expect(container.querySelector("input#count[type=number]")).toBeTruthy();
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
  expect(screen.getByText("*")).toBeInTheDocument(); // required marker on title
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
    expect.objectContaining({ title: "Locked", count: 3, open: true })
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
  expect(onSubmit).toHaveBeenCalledWith({ title: "Hello", count: 5, open: true });
});

test("coerces a numeric enum back to a number on submit (not a string)", () => {
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
    target: { value: "T" },
  });
  fireEvent.change(container.querySelector("select#level") as HTMLSelectElement, {
    target: { value: "2" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ level: 2 }));
});

test("does not force-submit an untouched optional boolean on create", () => {
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
    target: { value: "T" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  // `open` was never touched — omit it so the server's default applies (not a forced false).
  expect(onSubmit).toHaveBeenCalledWith({ title: "T" });
});

test("date/date-time fields round-trip: stored ISO displays in input form, submits back as ISO", () => {
  const onSubmit = vi.fn();
  const { container } = renderForm(
    <ResourceForm
      fields={fields}
      mode="edit"
      initial={{ title: "T", due: "2026-01-02", at: "2026-01-02T03:04:00.000Z" }}
      onSubmit={onSubmit}
      submitting={false}
      cancelTo="/"
    />
  );
  // The date input shows YYYY-MM-DD (not the raw stored string with any time part).
  const due = container.querySelector("input#due") as HTMLInputElement;
  expect(due.value).toBe("2026-01-02");
  // datetime-local shows YYYY-MM-DDTHH:mm with no trailing Z (else the control blanks).
  const at = container.querySelector("input#at") as HTMLInputElement;
  expect(at.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);

  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  const payload = onSubmit.mock.calls[0][0] as Record<string, unknown>;
  expect(payload.due).toBe("2026-01-02"); // plain date passes through
  // datetime-local is promoted back to a full ISO instant equal to what was loaded.
  expect(new Date(payload.at as string).toISOString()).toBe("2026-01-02T03:04:00.000Z");
});

test("invalid JSON in an array/object field blocks submit and shows an inline error", () => {
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
  expect(screen.getByText("invalid JSON")).toBeInTheDocument();
});

test("surfaces the form-level banner and per-field server errors", () => {
  renderForm(
    <ResourceForm
      fields={fields}
      mode="create"
      onSubmit={vi.fn()}
      submitting={false}
      formError="boom"
      fieldErrors={{ priority: "must be low or high" }}
      cancelTo="/"
    />
  );
  expect(screen.getByText(/boom/)).toBeInTheDocument();
  expect(screen.getByText("must be low or high")).toBeInTheDocument();
});
