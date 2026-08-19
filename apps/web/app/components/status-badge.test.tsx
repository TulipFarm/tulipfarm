import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { PriorityBadge, StatusBadge } from "~/components/status-badge";

test("renders status text with a non-color icon cue", () => {
  const { container } = render(<StatusBadge label="Succeeded" tone="success" />);
  expect(screen.getByText("Succeeded")).toBeInTheDocument();
  expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
});

test.each(["low", "medium", "high", "critical"] as const)(
  "renders the closed %s priority",
  (priority) => {
    render(<PriorityBadge priority={priority} />);
    expect(screen.getByText(priority)).toBeInTheDocument();
  }
);
