import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { Combobox } from "./combobox";

const LEVELS = ["View", "Use", "Edit"];

function Harness({
  initial = "",
  options = LEVELS,
  onCommit,
}: {
  initial?: string;
  options?: readonly string[];
  onCommit?: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <Combobox
      aria-label="They can"
      value={value}
      options={options}
      onValueChange={setValue}
      onCommit={onCommit}
    />
  );
}

it("offers every option again when reopened on a committed value", async () => {
  const user = userEvent.setup();
  render(<Harness initial="View" />);

  await user.click(screen.getByRole("combobox"));

  // Filtering the list by the value already in the field strands the reader on their own answer:
  // there is no way to reach Use or Edit without first deleting text.
  expect(screen.getAllByRole("option")).toHaveLength(3);
});

it("selects the committed text so typing replaces it rather than appending", async () => {
  const user = userEvent.setup();
  render(<Harness initial="View" />);

  const input = screen.getByRole("combobox") as HTMLInputElement;
  await user.click(input);

  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(4);
});

it("still narrows the list once the reader types", async () => {
  const user = userEvent.setup();
  render(<Harness initial="View" />);

  await user.click(screen.getByRole("combobox"));
  await user.keyboard("Ed");

  expect(screen.getAllByRole("option").map((node) => node.textContent)).toEqual(["Edit"]);
});

it("commits the option that was clicked", async () => {
  const user = userEvent.setup();
  const onCommit = vi.fn();
  render(<Harness initial="View" onCommit={onCommit} />);

  await user.click(screen.getByRole("combobox"));
  await user.click(screen.getByRole("option", { name: "Edit" }));

  expect(onCommit).toHaveBeenCalledWith("Edit");
  expect(screen.getByRole("combobox")).toHaveValue("Edit");
});

it("counts the full list, not a self-filtered one, in its footer", async () => {
  const user = userEvent.setup();
  const many = Array.from({ length: 60 }, (_, i) => `option-${i}`);
  render(<Harness initial="option-1" options={many} />);

  await user.click(screen.getByRole("combobox"));

  expect(screen.getByText("Showing 50 of 60. Type to narrow.")).toBeInTheDocument();
});
