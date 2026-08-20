import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LOADER_LABELS, LOADER_VARIANTS, LoadingState } from "./loading-state";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function tick(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

test("announces one stable line and keeps the ticking parts out of the live region", () => {
  render(<LoadingState label="Sprouting" variant="drive" />);

  expect(screen.getByRole("status")).toHaveTextContent("Loading");
  // The drawn word is decoration on top of that announcement, never the announcement itself.
  expect(screen.getByText("Sprouting")).toHaveAttribute("aria-hidden", "true");
  expect(screen.getByText("0.0s")).toHaveAttribute("aria-hidden", "true");
});

test("counts elapsed time in tenths and rolls over into minutes", () => {
  render(<LoadingState label="Sprouting" variant="drive" />);

  expect(screen.getByText("0.0s")).toBeInTheDocument();
  tick(1_500);
  expect(screen.getByText("1.5s")).toBeInTheDocument();
  tick(60_000);
  expect(screen.getByText("1m 1.5s")).toBeInTheDocument();
});

test("hides the timer when the surface already reports duration", () => {
  render(<LoadingState label="Saving" showElapsed={false} />);

  expect(screen.queryByText("0.0s")).not.toBeInTheDocument();
});

test("holds the drawn word for the life of the wait", () => {
  const { container, rerender } = render(<LoadingState />);
  const word = container.querySelector(".tf-loader-label")?.textContent;

  tick(5_000);
  rerender(<LoadingState />);

  expect(container.querySelector(".tf-loader-label")?.textContent).toBe(word);
  expect(screen.getByText("5.0s")).toBeInTheDocument();
});

test("renders a nine-cell grid for every variant", () => {
  for (const variant of LOADER_VARIANTS) {
    const { container, unmount } = render(<LoadingState variant={variant} label="Sprouting" />);
    expect(container.querySelectorAll(".tf-loader-pixel")).toHaveLength(9);
    unmount();
  }
});

test("keeps every drawn word short, growing, and clear of the Farm's own vocabulary", () => {
  for (const label of LOADER_LABELS) {
    expect(label.split(" ").length).toBeLessThanOrEqual(2);
  }
  // A wait should read as something coming up, never as an apology for how long it is taking.
  const apologetic = /still|slow|wait|hang|hold|long|patien/i;
  // app/lib/farm.ts spends these on real artifact state; a loader borrowing one would look like
  // it was reporting one.
  const farmNouns = /bloom|plant|harvest|season/i;
  for (const label of LOADER_LABELS) {
    expect(apologetic.test(label)).toBe(false);
    expect(farmNouns.test(label)).toBe(false);
  }
});
