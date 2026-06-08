import { createRemixStub } from "@remix-run/testing";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { AppSidebar } from "~/components/app-sidebar";

const Stub = createRemixStub([{ path: "/", Component: AppSidebar }]);

beforeEach(() => {
  localStorage.clear();
});

test("renders all eight V1 sidebar sections", () => {
  render(<Stub initialEntries={["/"]} />);
  for (const label of [
    "Chat",
    "Resources",
    "Agents",
    "Routines",
    "Approvals",
    "Knowledge",
    "Integrations",
    "Settings",
  ]) {
    expect(screen.getByText(label)).toBeInTheDocument();
  }
});

test("does not render an Apps section (AC-V1-003)", () => {
  render(<Stub initialEntries={["/"]} />);
  expect(screen.queryByText("Apps")).not.toBeInTheDocument();
});

test("shows the mocked Approvals badge count on the Approvals row", () => {
  render(<Stub initialEntries={["/"]} />);
  const approvalsLink = screen.getByRole("link", { name: /approvals/i });
  expect(within(approvalsLink).getByText("3")).toBeInTheDocument();
});

test("groups nav into Workspace/System and shows a footer theme toggle", () => {
  render(<Stub initialEntries={["/"]} />);
  expect(screen.getByText("Workspace")).toBeInTheDocument();
  expect(screen.getByText("System")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /toggle dark mode/i })).toBeInTheDocument();
});

test("collapsing the sidebar hides labels and persists the choice", async () => {
  const user = userEvent.setup();
  render(<Stub initialEntries={["/"]} />);
  expect(screen.getByText("Resources")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /collapse sidebar/i }));

  expect(screen.queryByText("Resources")).not.toBeInTheDocument();
  expect(localStorage.getItem("sidebar-collapsed")).toBe("true");
});
