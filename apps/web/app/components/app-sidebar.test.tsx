import { createRemixStub } from "@remix-run/testing";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { AppSidebar } from "~/components/app-sidebar";
import * as approvalsContext from "~/lib/approvals-context";

// The badge count now comes from the live ApprovalsProvider context (inert fallback is covered in
// approvals-context.test.tsx); mock the hook here for deterministic counts.
vi.mock("~/lib/approvals-context", () => ({ useApprovals: vi.fn() }));
const useApprovals = vi.mocked(approvalsContext.useApprovals);

const Stub = createRemixStub([{ path: "/", Component: AppSidebar }]);

beforeEach(() => {
  localStorage.clear();
  useApprovals.mockReturnValue({
    approvals: [],
    count: 0,
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
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

test("renders no Approvals badge when there are no pending approvals", () => {
  render(<Stub initialEntries={["/"]} />);
  const approvalsLink = screen.getByRole("link", { name: /approvals/i });
  expect(within(approvalsLink).queryByText(/^\d+$/)).toBeNull();
});

test("renders the live Approvals badge count from context", () => {
  useApprovals.mockReturnValue({
    approvals: [],
    count: 2,
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
  render(<Stub initialEntries={["/"]} />);
  const approvalsLink = screen.getByRole("link", { name: /approvals/i });
  expect(within(approvalsLink).getByText("2")).toBeInTheDocument();
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
