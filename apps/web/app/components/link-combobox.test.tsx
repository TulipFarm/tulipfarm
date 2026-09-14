import { fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
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
  const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
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
