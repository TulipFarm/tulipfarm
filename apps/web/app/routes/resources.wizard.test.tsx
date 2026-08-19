import { createRemixStub } from "@remix-run/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const addField = () => fireEvent.click(screen.getByRole("button", { name: "+ add field" }));
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

  fireEvent.change(screen.getByLabelText("type name * (singular, kebab-case)"), {
    target: { value: "ticket" },
  });
  fireEvent.change(screen.getByLabelText("field 1 name"), { target: { value: "subject" } });
  fireEvent.click(requiredBox(1));

  addField();
  fireEvent.change(screen.getByLabelText("field 2 name"), { target: { value: "description" } });

  addField();
  fireEvent.change(screen.getByLabelText("field 3 name"), { target: { value: "status" } });
  fireEvent.change(screen.getByLabelText("field 3 type"), { target: { value: "enum" } });
  fireEvent.change(screen.getByLabelText("field 3 choices"), { target: { value: "open, closed" } });
  fireEvent.click(requiredBox(3));

  fireEvent.click(screen.getByRole("button", { name: "Create type" }));

  await waitFor(() => expect(createResourceType).toHaveBeenCalled());
  const [, schemaJson] = vi.mocked(createResourceType).mock.calls[0];
  expect(JSON.parse(schemaJson)).toMatchObject({ required: ["subject", "status"] });
});
