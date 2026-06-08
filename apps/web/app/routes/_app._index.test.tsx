import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import ChatWelcome from "~/routes/_app._index";

const Stub = createRemixStub([{ path: "/", Component: ChatWelcome }]);

test("default view shows a welcome with guided first steps (AC-V1-001)", () => {
  render(<Stub initialEntries={["/"]} />);
  expect(screen.getByRole("heading", { name: /tulipfarm/i })).toBeInTheDocument();
  expect(screen.getByText(/first steps/i)).toBeInTheDocument();
  for (const step of [
    "Connect a soul",
    "Ask the assistant",
    "Explore resources",
    "Review approvals",
  ]) {
    expect(screen.getByText(step)).toBeInTheDocument();
  }
});
