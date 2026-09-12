import { createRemixStub } from "@remix-run/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { createResourceType } from "~/lib/api";
import ResourceTypeNew from "./_app.resources.new";

vi.mock("~/lib/api", async () => {
  const actual = await vi.importActual<typeof import("~/lib/api")>("~/lib/api");
  return { ...actual, createResourceType: vi.fn() };
});

afterEach(() => vi.clearAllMocks());

function renderWizard() {
  vi.mocked(createResourceType).mockResolvedValue({ name: "ticket", schema: "", hasHooks: false });
  const Stub = createRemixStub([
    { path: "/", Component: () => <ResourceTypeNew /> },
    { path: "/resources/:type", Component: () => null },
  ]);
  render(<Stub initialEntries={["/"]} />);
}

const addField = () => fireEvent.click(screen.getByRole("button", { name: "Add field" }));
const requiredBox = (row: number) =>
  screen.getByLabelText(`field ${row} required`) as HTMLInputElement;

test("wizard: '+ add field' keeps required checked on the rows already added", () => {
  renderWizard();

  fireEvent.change(screen.getByLabelText("field 1 name"), { target: { value: "subject" } });
  fireEvent.click(requiredBox(1));
  expect(requiredBox(1).checked).toBe(true);

  addField();
  expect(requiredBox(1).checked).toBe(true);
  expect(requiredBox(2).checked).toBe(false);

  fireEvent.change(screen.getByLabelText("field 2 name"), { target: { value: "status" } });
  fireEvent.click(requiredBox(2));
  addField();
  expect(requiredBox(1).checked).toBe(true);
  expect(requiredBox(2).checked).toBe(true);
  expect(requiredBox(3).checked).toBe(false);
});

test("wizard: removing a row keeps required on the rows that stay", () => {
  renderWizard();

  fireEvent.change(screen.getByLabelText("field 1 name"), { target: { value: "subject" } });
  addField();
  fireEvent.change(screen.getByLabelText("field 2 name"), { target: { value: "status" } });
  fireEvent.click(requiredBox(2));

  fireEvent.click(screen.getByLabelText("remove field 1"));
  expect((screen.getByLabelText("field 1 name") as HTMLInputElement).value).toBe("status");
  expect(requiredBox(1).checked).toBe(true);
});

test("wizard: every checked field lands in the submitted schema's required array", async () => {
  renderWizard();

  fireEvent.change(screen.getByLabelText("Resource type name"), {
    target: { value: "ticket" },
  });
  fireEvent.change(screen.getByLabelText("field 1 name"), { target: { value: "subject" } });
  fireEvent.click(requiredBox(1));

  addField();
  fireEvent.change(screen.getByLabelText("field 2 name"), { target: { value: "description" } });

  addField();
  fireEvent.change(screen.getByLabelText("field 3 name"), { target: { value: "status" } });
  await userEvent.click(screen.getByLabelText("field 3 type"));
  await userEvent.click(screen.getByRole("option", { name: "Choice list" }));
  fireEvent.change(screen.getByLabelText("field 3 choices"), { target: { value: "open, closed" } });
  fireEvent.click(requiredBox(3));

  fireEvent.click(screen.getByRole("button", { name: "Create type" }));

  await waitFor(() => expect(createResourceType).toHaveBeenCalled());
  const [, schemaJson] = vi.mocked(createResourceType).mock.calls[0];
  expect(JSON.parse(schemaJson)).toMatchObject({ required: ["subject", "status"] });
});

test("wizard explains field types without exposing schema jargon", async () => {
  renderWizard();
  expect(screen.getByLabelText("Resource type name")).toHaveAccessibleDescription(
    /lowercase letters.*support-ticket/i
  );
  expect(screen.queryByText(/kebab-case|createdAt|updatedAt/)).not.toBeInTheDocument();
  await userEvent.click(screen.getByLabelText("field 1 type"));
  for (const label of [
    "Text",
    "Number",
    "Whole number",
    "Yes or no",
    "Date",
    "Date and time",
    "Choice list",
  ]) {
    expect(screen.getByRole("option", { name: label })).toBeInTheDocument();
  }
});

test("wizard announces invalid names and returns focus to the named input", async () => {
  renderWizard();
  fireEvent.change(screen.getByLabelText("Resource type name"), {
    target: { value: "Bad Name" },
  });
  await userEvent.click(screen.getByRole("button", { name: "Create type" }));
  expect(screen.getByRole("alert")).toHaveTextContent(/lowercase letters/);
  expect(screen.getByLabelText("Resource type name")).toHaveFocus();
  expect(screen.getByLabelText("Resource type name")).toHaveAttribute("aria-invalid", "true");
  expect(createResourceType).not.toHaveBeenCalled();
  await userEvent.clear(screen.getByLabelText("Resource type name"));
  await userEvent.type(screen.getByLabelText("Resource type name"), "ticket");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test.each([
  ["Text", "Number", "string"],
  ["Number", "Yes or no", "number"],
])("Escape restores %s before implicit form submission", async (committed, typed, type) => {
  renderWizard();
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Resource type name"), "ticket");
  await user.type(screen.getByLabelText("field 1 name"), "detail");
  const picker = screen.getByLabelText("field 1 type");
  await user.click(picker);
  await user.click(screen.getByRole("option", { name: committed }));
  await user.clear(picker);
  await user.type(picker, typed);
  await user.keyboard("{Escape}");
  expect(picker).toHaveValue(committed);
  await user.keyboard("{Enter}");
  await waitFor(() => expect(createResourceType).toHaveBeenCalledOnce());
  expect(JSON.parse(vi.mocked(createResourceType).mock.calls[0][1]).properties.detail).toEqual({
    type,
  });
});

test("an unmatched field type cannot implicitly submit the form", async () => {
  renderWizard();
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Resource type name"), "ticket");
  await user.type(screen.getByLabelText("field 1 name"), "detail");
  const picker = screen.getByLabelText("field 1 type");
  await user.clear(picker);
  await user.type(picker, "Not a field type");
  await user.keyboard("{Enter}");
  expect(createResourceType).not.toHaveBeenCalled();
  expect(screen.getByText("Choose one of the field types.")).toBeInTheDocument();
});

test("wizard restores its declared field type when a choice is cleared or unmatched", async () => {
  renderWizard();
  const picker = screen.getByLabelText("field 1 type");
  await userEvent.clear(picker);
  await userEvent.tab();
  expect(picker).toHaveValue("Text");
  await userEvent.clear(picker);
  await userEvent.type(picker, "Unknown choice");
  await userEvent.tab();
  expect(picker).toHaveValue("Text");
});

test.each([
  ["Number", { type: "number" }],
  ["Whole number", { type: "integer" }],
  ["Yes or no", { type: "boolean" }],
  ["Date", { type: "string", format: "date" }],
  ["Date and time", { type: "string", format: "date-time" }],
])("wizard maps %s to the unchanged schema field type", async (label, property) => {
  renderWizard();
  fireEvent.change(screen.getByLabelText("Resource type name"), { target: { value: "ticket" } });
  fireEvent.change(screen.getByLabelText("field 1 name"), { target: { value: "detail" } });
  await userEvent.click(screen.getByLabelText("field 1 type"));
  await userEvent.click(screen.getByRole("option", { name: label }));
  await userEvent.click(screen.getByRole("button", { name: "Create type" }));
  await waitFor(() => expect(createResourceType).toHaveBeenCalledOnce());
  expect(JSON.parse(vi.mocked(createResourceType).mock.calls[0][1]).properties.detail).toEqual(
    property
  );
});
