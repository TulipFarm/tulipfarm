import { createRemixStub } from "@remix-run/testing";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Link } from "~/components/ui/link";
import { ApiError } from "~/lib/api";
import {
  commandRun,
  getOperationalRun,
  getRunBudgets,
  type OperationalRun,
} from "~/lib/operations";
import OperationalRunRoute, { clientLoader, ErrorBoundary } from "./_app.runs.$id";

vi.mock("~/lib/operations", () => ({
  commandRun: vi.fn(),
  getOperationalRun: vi.fn(),
  getRunBudgets: vi.fn(),
}));

const run: OperationalRun = {
  id: "run-1",
  routineId: "triage",
  routineVersion: "1",
  status: "running",
  version: 1,
  availableCommands: ["cancel"],
  createdAt: "2026-09-12T10:00:00Z",
  startedAt: "2026-09-12T10:00:01Z",
  finishedAt: null,
  states: [],
  effects: [],
  waits: [],
  guardrailDecisions: [],
  lineage: [],
  costs: { amountUsd: 0, modelTokens: 0 },
};
const connections: Array<{ onerror: (() => void) | null; close: () => void }> = [];

function renderRoute() {
  const Stub = createRemixStub([
    {
      path: "/runs/:id",
      loader: ({ params, request }) =>
        clientLoader({ params, request, serverLoader: vi.fn(), context: undefined }),
      Component: () => (
        <>
          <Link to="/runs/run-2">Next Run</Link>
          <OperationalRunRoute />
        </>
      ),
      ErrorBoundary,
    },
  ]);
  return render(<Stub initialEntries={["/runs/run-1"]} />);
}

async function cancelRun() {
  await userEvent.click(screen.getByRole("button", { name: "Cancel Run" }));
  await userEvent.click(screen.getByRole("button", { name: "Confirm Cancel Run" }));
}

beforeEach(() => {
  connections.length = 0;
  vi.mocked(getOperationalRun)
    .mockReset()
    .mockImplementation(async (id) => ({ ...run, id }));
  vi.mocked(getRunBudgets).mockReset().mockResolvedValue({ runId: "run-1", budgets: [] });
  vi.mocked(commandRun)
    .mockReset()
    .mockResolvedValue({ commandId: "cmd-1", runId: "run-1", status: "accepted" });
  vi.stubGlobal(
    "EventSource",
    class {
      onerror: (() => void) | null = null;
      constructor() {
        connections.push(this);
      }
      addEventListener() {}
      close = vi.fn();
    }
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("Run results route", () => {
  it("closes the previous stream and resets its reconnect warning on navigation", async () => {
    renderRoute();
    await screen.findByText("Run in progress");
    await waitFor(() => expect(connections[0]).toBeDefined());
    const previous = connections[0];
    act(() => previous?.onerror?.());
    expect(screen.getByText("Reconnecting")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "Next Run" }));
    await waitFor(() => {
      expect(screen.queryByText("Reconnecting")).not.toBeInTheDocument();
      expect(previous?.close).toHaveBeenCalled();
    });
  });
  it("uses one page title and retains the budget ledger", async () => {
    renderRoute();
    expect(
      await screen.findByRole("heading", { level: 1, name: "Run results" })
    ).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(
      await screen.findByText("No budget ceilings recorded. This Run is unbounded.")
    ).toBeInTheDocument();
  });

  it("renders exactly one page heading for an unknown Run", async () => {
    vi.mocked(getOperationalRun).mockRejectedValue(new ApiError(404, "Run not found."));
    renderRoute();
    expect(await screen.findByText("error: 404 Run not found.")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(
      screen.queryByRole("heading", { level: 1, name: "Run results" })
    ).not.toBeInTheDocument();
  });

  it.each([403, 409, 500])(
    "surfaces command errors (%s) without an unhandled rejection",
    async (status) => {
      vi.mocked(commandRun).mockRejectedValue(new ApiError(status, "The Run could not be changed"));
      renderRoute();
      await screen.findByText("Run in progress");
      await cancelRun();
      expect(await screen.findByRole("alert")).toHaveTextContent("The Run could not be changed");
      expect(screen.getByRole("button", { name: "Cancel Run" })).toBeEnabled();
    }
  );

  it("keeps 501 controls disabled with the server reason, then resets on navigation", async () => {
    vi.mocked(commandRun).mockRejectedValue(new ApiError(501, "No command authority"));
    renderRoute();
    await screen.findByText("Run in progress");
    await cancelRun();
    expect(
      await screen.findByText("Run control is unavailable: No command authority")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel Run" })).toBeDisabled();
    await userEvent.click(screen.getByRole("link", { name: "Next Run" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel Run" })).toBeEnabled());
    expect(screen.queryByText(/Run control is unavailable/)).not.toBeInTheDocument();
  });

  it("clears the cancel preview and command error when the Run changes", async () => {
    vi.mocked(commandRun).mockRejectedValue(new ApiError(500, "Command failed"));
    renderRoute();
    await screen.findByText("Run in progress");
    await cancelRun();
    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: "Cancel Run" }));
    await userEvent.click(screen.getByRole("link", { name: "Next Run" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Confirm Cancel Run" })).not.toBeInTheDocument();
  });

  it("ignores late budget and command responses from the previous Run", async () => {
    let finishBudget: (value: Awaited<ReturnType<typeof getRunBudgets>>) => void = () => {};
    let rejectCommand: (error: Error) => void = () => {};
    vi.mocked(getRunBudgets).mockImplementation((id) =>
      id === "run-1"
        ? new Promise((resolve) => {
            finishBudget = resolve;
          })
        : Promise.resolve({ runId: id, budgets: [] })
    );
    vi.mocked(commandRun).mockReturnValue(
      new Promise((_, reject) => {
        rejectCommand = reject;
      })
    );
    renderRoute();
    await screen.findByText("Run in progress");
    await cancelRun();
    await userEvent.click(screen.getByRole("link", { name: "Next Run" }));
    await screen.findByText("No budget ceilings recorded. This Run is unbounded.");
    await act(async () => {
      finishBudget({
        runId: "run-1",
        budgets: [{ key: "old-budget", limit: 10, consumed: 2, exhaustionPolicy: "failure_path" }],
      });
      rejectCommand(new ApiError(501, "Old authority error"));
    });
    expect(screen.queryByText("old-budget")).not.toBeInTheDocument();
    expect(screen.queryByText(/Old authority error/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel Run" })).toBeEnabled();
  });
});
