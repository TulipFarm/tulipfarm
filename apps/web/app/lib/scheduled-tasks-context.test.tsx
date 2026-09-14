import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import * as operations from "~/lib/operations";
import * as routines from "~/lib/routines";
import { ScheduledTasksProvider, useScheduledTasks } from "~/lib/scheduled-tasks-context";

vi.mock("~/lib/routines", () => ({ listRoutines: vi.fn() }));
vi.mock("~/lib/operations", () => ({ listOperationalRuns: vi.fn() }));
const mockRoutines = vi.mocked(routines.listRoutines);
const mockRuns = vi.mocked(operations.listOperationalRuns);

afterEach(() => {
  vi.useRealTimers();
  mockRoutines.mockReset();
  mockRuns.mockReset();
});

const scheduledRoutine = (id: string, slug: string) => ({
  id,
  slug,
  displayName: slug,
  authoredVersion: 1,
  triggers: [{ slug: "nightly", type: "cron", summary: "0 9 * * 1" }],
  summary: {
    owner: null,
    stateCount: 1,
    stateTypes: [],
    effects: [],
    toolAbilities: [],
    agentRefs: [],
    maxRiskClass: null,
    requiresApproval: false,
    concurrencyPolicy: null,
    compensationPolicy: null,
  },
});

function Probe() {
  const { tasks, loading, error, refresh } = useScheduledTasks();
  return (
    <div>
      <span data-testid="count">{tasks.length}</span>
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
    <ScheduledTasksProvider>
      <Probe />
    </ScheduledTasksProvider>
  );

test("loads scheduled Routines on mount", async () => {
  mockRoutines.mockResolvedValue([scheduledRoutine("a", "alpha")]);
  mockRuns.mockResolvedValue({ items: [], nextCursor: null });
  renderProbe();
  await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));
  expect(screen.getByTestId("loading")).toHaveTextContent("false");
});

test("useScheduledTasks returns an inert fallback when no provider is mounted", () => {
  render(<Probe />);
  expect(screen.getByTestId("count")).toHaveTextContent("0");
  expect(mockRoutines).not.toHaveBeenCalled();
});

test("renders with no scheduled Routines when the Run feed fails", async () => {
  mockRoutines.mockResolvedValue([scheduledRoutine("a", "alpha")]);
  mockRuns.mockRejectedValue(new Error("boom"));
  renderProbe();
  await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));
  expect(screen.getByTestId("error")).toHaveTextContent("");
});

test("refresh() re-fetches the task list", async () => {
  mockRoutines.mockResolvedValue([]);
  mockRuns.mockResolvedValue({ items: [], nextCursor: null });
  renderProbe();
  await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("0"));

  mockRoutines.mockResolvedValue([scheduledRoutine("a", "alpha")]);
  fireEvent.click(screen.getByRole("button", { name: "refresh" }));
  await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));
});

test("surfaces an error and keeps the last-known list", async () => {
  mockRoutines.mockResolvedValue([scheduledRoutine("a", "alpha")]);
  mockRuns.mockResolvedValue({ items: [], nextCursor: null });
  renderProbe();
  await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));

  mockRoutines.mockRejectedValueOnce(new Error("boom"));
  fireEvent.click(screen.getByRole("button", { name: "refresh" }));
  await waitFor(() => expect(screen.getByTestId("error")).toHaveTextContent("boom"));
  expect(screen.getByTestId("count")).toHaveTextContent("1");
});

test("re-polls on the 30s interval", async () => {
  vi.useFakeTimers();
  mockRoutines.mockResolvedValue([]);
  mockRuns.mockResolvedValue({ items: [], nextCursor: null });
  renderProbe();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByTestId("count")).toHaveTextContent("0");

  mockRoutines.mockResolvedValue([scheduledRoutine("a", "alpha")]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(screen.getByTestId("count")).toHaveTextContent("1");
});
