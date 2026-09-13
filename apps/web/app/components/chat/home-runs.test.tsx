import { createRemixStub } from "@remix-run/testing";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import type { SessionUser } from "~/lib/api";
import { listOperationalRuns, type OperationalRun } from "~/lib/operations";
import { ChatHomeRuns } from "./home-runs";

let user: SessionUser | undefined;
vi.mock("~/lib/use-session-user", () => ({ useSessionUser: () => user }));
vi.mock("~/lib/operations", () => ({ listOperationalRuns: vi.fn() }));

function run(id: string, status: string): OperationalRun {
  return {
    id,
    routineId: "weekly-report",
    routineVersion: "1",
    version: 1,
    status,
    createdAt: "2026-09-13T05:00:00Z",
    startedAt: null,
    finishedAt: null,
    states: [],
    effects: [],
    waits: [],
    guardrailDecisions: [],
    lineage: [],
    costs: { amountUsd: 0, modelTokens: 0 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  user = {
    id: "user-1",
    name: "Muskan Vijayvargiya",
    email: "muskan@example.com",
    role: "member",
    status: "active",
    navigation: { visiblePaths: ["/runs"] },
  };
  vi.mocked(listOperationalRuns).mockResolvedValue({ items: [], nextCursor: null });
});

function renderRuns() {
  let refreshSession = () => {};
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => {
        const [, update] = useReducer((value) => value + 1, 0);
        refreshSession = update;
        return <ChatHomeRuns />;
      },
    },
  ]);
  return { ...render(<Stub />), refreshSession: () => act(() => refreshSession()) };
}

test("does not fetch operational data without the server's navigation grant", () => {
  if (!user) throw new Error("Missing session fixture");
  user = { ...user, isAdmin: true, navigation: { visiblePaths: [] } };
  renderRuns();
  expect(listOperationalRuns).not.toHaveBeenCalled();
  expect(screen.queryByRole("region", { name: "Recent runs" })).not.toBeInTheDocument();
});

test("keeps missing session data closed", () => {
  user = undefined;
  renderRuns();
  expect(listOperationalRuns).not.toHaveBeenCalled();
});

test("shows actual Run states and links for granted users without admin role checks", async () => {
  vi.mocked(listOperationalRuns).mockResolvedValue({
    items: [run("run-1", "running"), run("run-2", "succeeded"), run("run-3", "attention_required")],
    nextCursor: "older",
  });
  renderRuns();
  expect(await screen.findByText("running")).toBeInTheDocument();
  expect(screen.getByText("succeeded")).toBeInTheDocument();
  expect(screen.getByText("attention required")).toBeInTheDocument();
  expect(listOperationalRuns).toHaveBeenCalledWith(undefined, 3);
  expect(screen.getByRole("link", { name: /weekly-report.*running/ })).toHaveAttribute(
    "href",
    "/runs/run-1"
  );
  expect(screen.getByRole("link", { name: "All runs" })).toHaveAttribute(
    "href",
    "/business/activities?source=run"
  );
  expect(screen.queryByText(/all caught up|hours saved/i)).not.toBeInTheDocument();
});

test("distinguishes loading and an empty result", async () => {
  let resolve: (value: { items: OperationalRun[]; nextCursor: null }) => void = () => {};
  vi.mocked(listOperationalRuns).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    })
  );
  renderRuns();
  expect(screen.getByRole("status")).toHaveTextContent("Loading recent runs");
  expect(screen.queryByText("No runs yet.")).not.toBeInTheDocument();
  await act(async () => resolve({ items: [], nextCursor: null }));
  expect(screen.getByText("No runs yet.")).toBeInTheDocument();
});

test("failed reads offer retry instead of claiming that no work exists", async () => {
  vi.mocked(listOperationalRuns).mockRejectedValueOnce(new Error("offline"));
  renderRuns();
  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load recent runs.");
  expect(screen.queryByText("No runs yet.")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Refresh runs" }));
  expect(await screen.findByText("No runs yet.")).toBeInTheDocument();
  expect(listOperationalRuns).toHaveBeenCalledTimes(2);
});

test("refresh replaces old statuses with the latest response", async () => {
  vi.mocked(listOperationalRuns)
    .mockResolvedValueOnce({ items: [run("run-1", "running")], nextCursor: null })
    .mockResolvedValueOnce({ items: [run("run-1", "succeeded")], nextCursor: null });
  renderRuns();
  await screen.findByText("running");
  await userEvent.click(screen.getByRole("button", { name: "Refresh runs" }));
  expect(await screen.findByText("succeeded")).toBeInTheDocument();
  expect(screen.queryByText("running")).not.toBeInTheDocument();
  await waitFor(() => expect(listOperationalRuns).toHaveBeenCalledTimes(2));
});

test("revoking access removes the list and ignores an in-flight response", async () => {
  let resolve: (value: { items: OperationalRun[]; nextCursor: null }) => void = () => {};
  vi.mocked(listOperationalRuns).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    })
  );
  const view = renderRuns();
  user = undefined;
  view.refreshSession();
  await act(async () => resolve({ items: [run("private-run", "running")], nextCursor: null }));
  expect(screen.queryByRole("region", { name: "Recent runs" })).not.toBeInTheDocument();
  expect(screen.queryByText("weekly-report")).not.toBeInTheDocument();
});
