import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import * as approvals from "~/lib/approvals";
import { ApprovalsProvider, useApprovals } from "~/lib/approvals-context";

vi.mock("~/lib/approvals", () => ({ listPendingApprovals: vi.fn() }));
const mockList = vi.mocked(approvals.listPendingApprovals);

afterEach(() => {
  vi.useRealTimers();
  mockList.mockReset();
});

const row = (approvalId: string): approvals.PendingApproval => ({
  approvalId,
  toolCallId: "c",
  toolName: "t",
  args: {},
  expiresAt: "",
  createdAt: "",
});

function Probe() {
  const { count, loading, error, refresh } = useApprovals();
  return (
    <div>
      <span data-testid="count">{count}</span>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="error">{error ?? ""}</span>
      <button type="button" onClick={() => void refresh()}>
        refresh
      </button>
    </div>
  );
}

const renderProbe = () =>
  render(
    <ApprovalsProvider>
      <Probe />
    </ApprovalsProvider>
  );

test("polls on mount and exposes the live count", async () => {
  mockList.mockResolvedValue([row("a"), row("b")]);
  renderProbe();
  await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("2"));
  expect(screen.getByTestId("loading")).toHaveTextContent("false");
});

test("useApprovals returns an inert fallback when no provider is mounted", () => {
  render(<Probe />);
  expect(screen.getByTestId("count")).toHaveTextContent("0");
  expect(screen.getByTestId("loading")).toHaveTextContent("false");
  expect(mockList).not.toHaveBeenCalled();
});

test("refresh() re-fetches and updates the count", async () => {
  mockList.mockResolvedValue([]);
  renderProbe();
  await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("0"));

  mockList.mockResolvedValue([row("a")]);
  fireEvent.click(screen.getByRole("button", { name: "refresh" }));
  await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));
});

test("surfaces an error and keeps the last-known list", async () => {
  mockList.mockResolvedValue([row("a")]);
  renderProbe();
  await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));

  mockList.mockRejectedValueOnce(new Error("boom"));
  fireEvent.click(screen.getByRole("button", { name: "refresh" }));
  await waitFor(() => expect(screen.getByTestId("error")).toHaveTextContent("boom"));
  expect(screen.getByTestId("count")).toHaveTextContent("1"); // list preserved across the error
});

test("re-polls on the ~4s interval", async () => {
  vi.useFakeTimers();
  mockList.mockResolvedValue([]);
  renderProbe();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0); // flush the mount fetch
  });
  expect(screen.getByTestId("count")).toHaveTextContent("0");

  mockList.mockResolvedValue([row("a")]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000);
  });
  expect(screen.getByTestId("count")).toHaveTextContent("1");
});

test("drops overlapping ticks while a poll is in flight", async () => {
  vi.useFakeTimers();
  mockList.mockReturnValue(new Promise(() => {})); // never resolves → stays in flight
  renderProbe();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8000); // two ticks, both must be dropped by the guard
  });
  expect(mockList).toHaveBeenCalledTimes(1);
});

test("clears the interval on unmount", async () => {
  vi.useFakeTimers();
  mockList.mockResolvedValue([]);
  const { unmount } = renderProbe();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  unmount();
  mockList.mockClear();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(12000);
  });
  expect(mockList).not.toHaveBeenCalled();
});
