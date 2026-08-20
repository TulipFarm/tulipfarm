import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { DiffChip, DiffChipGroup, DiffCount, type DiffLine } from "./tool-chip";

const LINES: DiffLine[] = [
  { text: "fields:", tone: "context" },
  { text: "  priority: [low, high]", tone: "remove" },
  { text: "  priority: [low, normal, high]", tone: "add" },
];

test("says the counts in words as well as in signs", () => {
  render(<DiffCount added={13} removed={2} />);

  expect(screen.getByText("+13")).toBeInTheDocument();
  expect(screen.getByText("−2")).toBeInTheDocument();
  // The sign carries the meaning visually; the screen reader gets it without doing arithmetic.
  expect(screen.getByText("13 added, 2 removed")).toBeInTheDocument();
});

test("renders nothing when a file changed by nothing", () => {
  const { container } = render(<DiffCount added={0} removed={0} />);

  expect(container).toBeEmptyDOMElement();
});

test("stays a plain chip when there is no change to show", () => {
  render(<DiffChip file="routines/daily-digest.yaml" added={8} removed={0} />);

  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(screen.getByText("routines/daily-digest.yaml")).toBeInTheDocument();
});

test("previews the change on keyboard focus, not on hover alone", async () => {
  const user = userEvent.setup();
  render(<DiffChip file="resources/ticket.yaml" added={13} removed={2} lines={LINES} />);

  const chip = screen.getByRole("button", { name: "Show the change to resources/ticket.yaml" });
  expect(chip).toHaveAttribute("aria-expanded", "false");

  await user.tab();
  expect(chip).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText(/priority: \[low, normal, high\]/)).toBeInTheDocument();
});

test("reveals the rest of the files instead of only counting them", async () => {
  const user = userEvent.setup();
  render(
    <DiffChipGroup
      max={2}
      files={[
        { file: "a.yaml", added: 1, removed: 0 },
        { file: "b.yaml", added: 2, removed: 0 },
        { file: "c.yaml", added: 3, removed: 0 },
      ]}
    />
  );

  expect(screen.queryByText("c.yaml")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "+1 more" }));
  expect(screen.getByText("c.yaml")).toBeInTheDocument();
});
