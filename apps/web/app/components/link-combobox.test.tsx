import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type FormEvent, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { LinkCombobox } from "~/components/link-combobox";
import { listRecords } from "~/lib/api";

// Only listRecords is needed; mock the whole module so no real fetch fires.
vi.mock("~/lib/api", () => ({ listRecords: vi.fn() }));

const customers = [
  { id: "CUST-1", name: "Acme", version: 1, createdAt: "", updatedAt: "" },
  { id: "CUST-2", name: "Globex", version: 1, createdAt: "", updatedAt: "" },
];

afterEach(() => vi.clearAllMocks());

test("loads the target's records and renders them as options on focus", async () => {
  vi.mocked(listRecords).mockResolvedValue({ items: customers, nextCursor: null });
  render(<LinkCombobox target="customer" value="" onChange={vi.fn()} />);

  fireEvent.focus(screen.getByRole("combobox"));
  expect(await screen.findByRole("option", { name: /Acme/ })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: /Globex/ })).toBeInTheDocument();
  expect(listRecords).toHaveBeenCalledWith("customer");
});

test("filters options client-side as the user types", async () => {
  vi.mocked(listRecords).mockResolvedValue({ items: customers, nextCursor: null });
  render(<LinkCombobox target="customer" value="" onChange={vi.fn()} />);
  const input = screen.getByRole("combobox");
  fireEvent.focus(input);
  await screen.findByRole("option", { name: /Acme/ });

  fireEvent.change(input, { target: { value: "glob" } });
  expect(screen.queryByRole("option", { name: /Acme/ })).not.toBeInTheDocument();
  expect(screen.getByRole("option", { name: /Globex/ })).toBeInTheDocument();
});

test("selecting an option emits the target record id, not its label", async () => {
  vi.mocked(listRecords).mockResolvedValue({ items: customers, nextCursor: null });
  const onChange = vi.fn();
  render(<LinkCombobox target="customer" value="" onChange={onChange} />);
  fireEvent.focus(screen.getByRole("combobox"));
  const option = await screen.findByRole("option", { name: /Globex/ });

  fireEvent.pointerDown(option);
  expect(onChange).toHaveBeenCalledWith("CUST-2");
});

test("shows the selected record's label for the current value", async () => {
  vi.mocked(listRecords).mockResolvedValue({ items: customers, nextCursor: null });
  render(<LinkCombobox target="customer" value="CUST-1" onChange={vi.fn()} />);
  // wait for options to load so the label resolves
  await screen.findByDisplayValue("Acme");
});

test("arrow keys move the active option and Enter selects it without submitting the form", async () => {
  vi.mocked(listRecords).mockResolvedValue({ items: customers, nextCursor: null });
  const onChange = vi.fn();
  const onSubmit = vi.fn((e: FormEvent) => e.preventDefault());
  render(
    <form onSubmit={onSubmit}>
      <LinkCombobox target="customer" value="" onChange={onChange} />
    </form>
  );
  const input = screen.getByRole("combobox");
  fireEvent.focus(input);
  await screen.findByRole("option", { name: /Acme/ });

  fireEvent.keyDown(input, { key: "ArrowDown" });
  const globex = screen.getByRole("option", { name: /Globex/ });
  expect(globex).toHaveAttribute("aria-selected", "false");
  expect(input).toHaveAttribute("aria-activedescendant", globex.id);

  fireEvent.keyDown(input, { key: "Enter" });
  expect(onChange).toHaveBeenCalledWith("CUST-2");
  expect(onSubmit).not.toHaveBeenCalled();
});

test("Escape dismisses the open list without changing the selection", async () => {
  vi.mocked(listRecords).mockResolvedValue({ items: customers, nextCursor: null });
  const onChange = vi.fn();
  render(<LinkCombobox target="customer" value="" onChange={onChange} />);
  const input = screen.getByRole("combobox");
  fireEvent.focus(input);
  await screen.findByRole("option", { name: /Acme/ });

  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(onChange).not.toHaveBeenCalled();
});

test("Tab out of the field does not leave focus stranded on the body", async () => {
  vi.mocked(listRecords).mockResolvedValue({ items: customers, nextCursor: null });
  render(
    <div>
      <LinkCombobox target="customer" value="" onChange={vi.fn()} />
      <button type="button">next field</button>
    </div>
  );
  const input = screen.getByRole("combobox");
  fireEvent.focus(input);
  await screen.findByRole("option", { name: /Acme/ });

  const nextField = screen.getByRole("button", { name: "next field" });
  fireEvent.blur(input, { relatedTarget: nextField });
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});

test("clearing the search query does not clear the selected Record", async () => {
  vi.mocked(listRecords).mockResolvedValue({ items: customers, nextCursor: null });
  const onChange = vi.fn();
  render(
    <div>
      <LinkCombobox target="customer" value="CUST-1" onChange={onChange} clearable />
      <button type="button">next field</button>
    </div>
  );
  const input = await screen.findByDisplayValue("Acme");

  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "x" } });
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.blur(input, { relatedTarget: screen.getByRole("button", { name: "next field" }) });

  expect(onChange).not.toHaveBeenCalled();
  expect(input).toHaveValue("Acme");
});

test("an optional selected relationship has an explicit Clear action", async () => {
  vi.mocked(listRecords).mockResolvedValue({ items: customers, nextCursor: null });
  const user = userEvent.setup();

  function Harness() {
    const [value, setValue] = useState("CUST-1");
    return <LinkCombobox target="customer" value={value} onChange={setValue} clearable />;
  }

  render(<Harness />);
  await screen.findByDisplayValue("Acme");

  screen.getByRole("button", { name: "Clear customer selection" }).focus();
  await user.keyboard("{Enter}");

  expect(screen.getByRole("combobox")).toHaveValue("");
  expect(
    screen.queryByRole("button", { name: "Clear customer selection" })
  ).not.toBeInTheDocument();
});

test("a required relationship does not expose the Clear action", async () => {
  vi.mocked(listRecords).mockResolvedValue({ items: customers, nextCursor: null });
  render(<LinkCombobox target="customer" value="CUST-1" onChange={vi.fn()} />);

  await screen.findByDisplayValue("Acme");
  expect(
    screen.queryByRole("button", { name: /clear customer selection/i })
  ).not.toBeInTheDocument();
});

test("a cleared relationship can be replaced with another target", async () => {
  vi.mocked(listRecords).mockResolvedValue({ items: customers, nextCursor: null });

  function Harness() {
    const [value, setValue] = useState("CUST-1");
    return <LinkCombobox target="customer" value={value} onChange={setValue} clearable />;
  }

  render(<Harness />);
  await screen.findByDisplayValue("Acme");
  fireEvent.click(screen.getByRole("button", { name: "Clear customer selection" }));
  fireEvent.focus(screen.getByRole("combobox"));
  fireEvent.pointerDown(await screen.findByRole("option", { name: /Globex/ }));

  expect(screen.getByRole("combobox")).toHaveValue("Globex");
});
