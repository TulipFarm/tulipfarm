import { fireEvent, render, screen } from "@testing-library/react";
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
  expect(await screen.findByRole("button", { name: /Acme/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Globex/ })).toBeInTheDocument();
  expect(listRecords).toHaveBeenCalledWith("customer");
});

test("filters options client-side as the user types", async () => {
  vi.mocked(listRecords).mockResolvedValue({ items: customers, nextCursor: null });
  render(<LinkCombobox target="customer" value="" onChange={vi.fn()} />);
  const input = screen.getByRole("combobox");
  fireEvent.focus(input);
  await screen.findByRole("button", { name: /Acme/ });

  fireEvent.change(input, { target: { value: "glob" } });
  expect(screen.queryByRole("button", { name: /Acme/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Globex/ })).toBeInTheDocument();
});

test("selecting an option emits the target record id, not its label", async () => {
  vi.mocked(listRecords).mockResolvedValue({ items: customers, nextCursor: null });
  const onChange = vi.fn();
  render(<LinkCombobox target="customer" value="" onChange={onChange} />);
  fireEvent.focus(screen.getByRole("combobox"));
  const option = await screen.findByRole("button", { name: /Globex/ });

  fireEvent.mouseDown(option);
  expect(onChange).toHaveBeenCalledWith("CUST-2");
});

test("shows the selected record's label for the current value", async () => {
  vi.mocked(listRecords).mockResolvedValue({ items: customers, nextCursor: null });
  render(<LinkCombobox target="customer" value="CUST-1" onChange={vi.fn()} />);
  // wait for options to load so the label resolves
  await screen.findByDisplayValue("Acme");
});
