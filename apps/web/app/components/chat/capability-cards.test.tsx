import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { CapabilityCards } from "~/components/chat/capability-cards";

test("renders the Create, Find, and Research groups", () => {
  render(<CapabilityCards onPick={vi.fn()} />);

  for (const group of ["Create", "Find", "Research"]) {
    expect(screen.getByText(group)).toBeTruthy();
  }
  for (const card of [
    "Tasks",
    "Routines",
    "Resources",
    "Docs",
    "Answers",
    "Records",
    "Files",
    "Web",
    "Integrations",
    "Knowledge",
  ]) {
    expect(screen.getByRole("button", { name: card })).toBeTruthy();
  }
});

test("clicking a card hands the caller a template prompt for that capability", async () => {
  const user = userEvent.setup();
  const onPick = vi.fn();
  render(<CapabilityCards onPick={onPick} />);

  await user.click(screen.getByRole("button", { name: "Routines" }));

  expect(onPick).toHaveBeenCalledWith("Set up a routine that ");
});
