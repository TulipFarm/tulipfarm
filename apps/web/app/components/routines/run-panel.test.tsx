import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { RunPanel } from "./run-panel";

const noop = async () => {};

function renderPanel(over: Partial<Parameters<typeof RunPanel>[0]> = {}) {
  const props = {
    slug: "expense-report",
    inputs: null,
    onRun: noop,
    onDryRun: noop,
    hasEffects: true,
    ...over,
  };
  render(<RunPanel {...props} />);
  return props;
}

test("offers the rehearsal beside the real thing, not somewhere else", () => {
  renderPanel();
  expect(screen.getByRole("button", { name: /run now/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /dry run/i })).toBeInTheDocument();
});

/*
 * The promise the panel makes has to match what the kernel actually does. A routine that reaches
 * nothing must not be described as if pressing Run were consequential, and one that does must not
 * read as harmless.
 */
test("says whether a real run reaches outside the instance", () => {
  const { unmount } = render(
    <RunPanel slug="s" inputs={null} onRun={noop} onDryRun={noop} hasEffects />
  );
  expect(screen.getByText(/reaches outside this instance/i)).toBeInTheDocument();
  unmount();
  render(<RunPanel slug="s" inputs={null} onRun={noop} onDryRun={noop} hasEffects={false} />);
  expect(screen.getByText(/only computes/i)).toBeInTheDocument();
});

test("both buttons receive the same inputs the person typed", async () => {
  const onRun = vi.fn(async () => {});
  const onDryRun = vi.fn(async () => {});
  renderPanel({
    inputs: { properties: { issueId: { type: "string" } }, required: ["issueId"] },
    onRun,
    onDryRun,
  });

  await userEvent.type(screen.getByLabelText(/issueId/i), "42");
  await userEvent.click(screen.getByRole("button", { name: /dry run/i }));
  expect(onDryRun).toHaveBeenCalledWith({ issueId: "42" });

  await userEvent.click(screen.getByRole("button", { name: /run now/i }));
  expect(onRun).toHaveBeenCalledWith({ issueId: "42" });
});

test("a declared enum becomes a choice rather than free text", () => {
  renderPanel({ inputs: { properties: { tier: { type: "string", enum: ["gold", "silver"] } } } });
  expect(screen.getByRole("combobox", { name: /tier/i })).toBeInTheDocument();
});

test("neither button can be pressed twice while one is running", () => {
  renderPanel({ busy: "dry-run" });
  expect(screen.getByRole("button", { name: /run now/i })).toBeDisabled();
  expect(screen.getByRole("button", { name: /simulating/i })).toBeDisabled();
});

test("a refusal is announced, not left for the reader to notice", () => {
  renderPanel({ error: "You do not have permission to simulate this routine." });
  expect(screen.getByRole("alert")).toHaveTextContent(/do not have permission/i);
});

test("a routine with no inputs says so instead of showing an empty form", () => {
  renderPanel({ inputs: {} });
  expect(screen.getByText(/takes no inputs/i)).toBeInTheDocument();
});

/*
 * Both buttons resolve away from themselves — a Run into the history table, a dry run into a panel
 * further down. Without this a screen-reader user presses Dry run and is told nothing at all.
 */
test("announces an outcome that lands somewhere other than beside the button", () => {
  renderPanel();
  // Mounted empty first: inserting the region together with its text does not reliably announce.
  expect(screen.getByRole("status")).toHaveTextContent("");

  cleanup();
  renderPanel({ status: "Dry run finished. 1 call would have been made, none dispatched." });
  expect(screen.getByRole("status")).toHaveTextContent(/1 call would have been made/);
});
