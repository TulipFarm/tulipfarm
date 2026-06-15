import { createRemixStub } from "@remix-run/testing";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import * as approvalsLib from "~/lib/approvals";
import * as approvalsContext from "~/lib/approvals-context";
import ApprovalsPage from "./_app.approvals";

/*
 * Approvals page smoke tests. The page reads the shared ApprovalsProvider context (not a loader),
 * so we mock useApprovals + the decide call and render through createRemixStub (ResourcePanel /
 * EmptyState use Link). ApprovalCard renders for real (its countdown is asserted loosely).
 */

vi.mock("~/lib/approvals-context", () => ({ useApprovals: vi.fn() }));
vi.mock("~/lib/approvals", () => ({ sendApprovalDecision: vi.fn() }));

const useApprovals = vi.mocked(approvalsContext.useApprovals);
const sendApprovalDecision = vi.mocked(approvalsLib.sendApprovalDecision);

afterEach(() => {
  vi.clearAllMocks();
});

const row = (over: Partial<approvalsLib.PendingApproval> = {}): approvalsLib.PendingApproval => ({
  approvalId: "ap1",
  toolCallId: "call_1",
  toolName: "write_thing",
  args: { value: "x" },
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  createdAt: new Date().toISOString(),
  ...over,
});

type ApprovalsState = ReturnType<typeof approvalsContext.useApprovals>;
const state = (over: Partial<ApprovalsState> = {}): ApprovalsState => ({
  approvals: [],
  count: 0,
  loading: false,
  error: null,
  refresh: vi.fn().mockResolvedValue(undefined),
  ...over,
});

function renderPage() {
  const Stub = createRemixStub([{ path: "/", Component: () => <ApprovalsPage /> }]);
  render(<Stub initialEntries={["/"]} />);
}

test("shows a loading line on the first load", () => {
  useApprovals.mockReturnValue(state({ loading: true }));
  renderPage();
  expect(screen.getByText("loading…")).toBeInTheDocument();
});

test("shows the empty state when there are no pending approvals", () => {
  useApprovals.mockReturnValue(state({ loading: false, approvals: [] }));
  renderPage();
  expect(screen.getByText(/No pending approvals/)).toBeInTheDocument();
});

test("shows the error state (with the message) when the poll failed and nothing is cached", () => {
  useApprovals.mockReturnValue(state({ error: "boom", approvals: [] }));
  renderPage();
  expect(screen.getByText(/error: boom/)).toBeInTheDocument();
});

test("renders a row per pending approval with tool name + args preview", () => {
  useApprovals.mockReturnValue(state({ approvals: [row()], count: 1 }));
  renderPage();
  expect(screen.getByText("1 pending")).toBeInTheDocument();
  expect(screen.getByText("[approval required]")).toBeInTheDocument();
  expect(screen.getByText("write_thing")).toBeInTheDocument();
  expect(screen.getByText('{"value":"x"}')).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "approve" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "deny" })).toBeInTheDocument();
});

test("approve decides then refreshes the shared context", async () => {
  const user = userEvent.setup();
  const refresh = vi.fn().mockResolvedValue(undefined);
  sendApprovalDecision.mockResolvedValue({ status: "approve" });
  useApprovals.mockReturnValue(state({ approvals: [row()], count: 1, refresh }));
  renderPage();

  await user.click(screen.getByRole("button", { name: "approve" }));
  expect(sendApprovalDecision).toHaveBeenCalledWith("ap1", "approve");
  await waitFor(() => expect(refresh).toHaveBeenCalled());
});

test("deny decides('deny') then refreshes", async () => {
  const user = userEvent.setup();
  const refresh = vi.fn().mockResolvedValue(undefined);
  sendApprovalDecision.mockResolvedValue({ status: "deny" });
  useApprovals.mockReturnValue(state({ approvals: [row()], count: 1, refresh }));
  renderPage();

  await user.click(screen.getByRole("button", { name: "deny" }));
  expect(sendApprovalDecision).toHaveBeenCalledWith("ap1", "deny");
  await waitFor(() => expect(refresh).toHaveBeenCalled());
});

test("renders (no args) for a null-args approval", () => {
  useApprovals.mockReturnValue(state({ approvals: [row({ args: null })], count: 1 }));
  renderPage();
  expect(screen.getByText("(no args)")).toBeInTheDocument();
});

test("ignores a second decide for the same approval while one is in flight", async () => {
  const user = userEvent.setup();
  let resolveDecide: (v: { status: string }) => void = () => {};
  sendApprovalDecision.mockReturnValue(
    new Promise((resolve) => {
      resolveDecide = resolve;
    })
  );
  const refresh = vi.fn().mockResolvedValue(undefined);
  useApprovals.mockReturnValue(state({ approvals: [row()], count: 1, refresh }));
  renderPage();

  const approve = screen.getByRole("button", { name: "approve" });
  await user.click(approve);
  await user.click(approve); // second click while the first decide is still pending
  expect(sendApprovalDecision).toHaveBeenCalledTimes(1);

  resolveDecide({ status: "approve" });
  await waitFor(() => expect(refresh).toHaveBeenCalled());
});
