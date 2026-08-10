import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import type { LogEvent } from "~/lib/logs";
import { LogsPanel } from "./logs-panel";

vi.mock("~/lib/logs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/logs")>()),
  getLogs: vi.fn(),
}));

import { getLogs } from "~/lib/logs";

function log(overrides: Partial<LogEvent> & { id: string; message: string }): LogEvent {
  return {
    ts: "2025-01-01T09:30:00.000Z",
    level: "error",
    service: "api",
    stack: null,
    requestId: null,
    runId: null,
    conversationId: null,
    attributes: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(getLogs).mockReset();
});

test("renders the records it was given without fetching", () => {
  render(
    <LogsPanel
      initial={{
        items: [log({ id: "1", message: "database timeout" })],
        nextCursor: null,
      }}
    />
  );

  expect(screen.getByText("database timeout")).toBeInTheDocument();
  expect(getLogs).not.toHaveBeenCalled();
});

test("says nothing is failing rather than looking broken when empty", () => {
  render(<LogsPanel initial={{ items: [], nextCursor: null }} />);
  expect(screen.getByText(/no errors recorded/i)).toBeInTheDocument();
});

test("reveals the stack and correlation ids only on demand", async () => {
  const user = userEvent.setup();
  render(
    <LogsPanel
      initial={{
        items: [
          log({
            id: "1",
            message: "run crashed",
            stack: "Error: run crashed\n  at dispatch",
            runId: "run_42",
            attributes: { route: "/api/v1/runs" },
          }),
        ],
        nextCursor: null,
      }}
    />
  );

  expect(screen.queryByText(/at dispatch/)).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { expanded: false }));

  expect(screen.getByText(/at dispatch/)).toBeInTheDocument();
  expect(screen.getByText("run_42")).toBeInTheDocument();
  expect(screen.getByText("/api/v1/runs")).toBeInTheDocument();
});

test("a record with nothing more to show is not expandable", () => {
  render(<LogsPanel initial={{ items: [log({ id: "1", message: "bare" })], nextCursor: null }} />);
  expect(screen.queryByRole("button", { expanded: false })).not.toBeInTheDocument();
});

test("filtering by level refetches and replaces the list", async () => {
  const user = userEvent.setup();
  vi.mocked(getLogs).mockResolvedValue({
    items: [log({ id: "2", message: "worker died", level: "fatal" })],
    nextCursor: null,
  });

  render(
    <LogsPanel
      initial={{ items: [log({ id: "1", message: "database timeout" })], nextCursor: null }}
    />
  );

  await user.click(screen.getByRole("button", { name: "fatal" }));

  expect(getLogs).toHaveBeenCalledWith(expect.objectContaining({ level: "fatal" }));
  expect(await screen.findByText("worker died")).toBeInTheDocument();
  expect(screen.queryByText("database timeout")).not.toBeInTheDocument();
});

test("load older appends the next page instead of replacing it", async () => {
  const user = userEvent.setup();
  vi.mocked(getLogs).mockResolvedValue({
    items: [log({ id: "2", message: "older failure" })],
    nextCursor: null,
  });

  render(
    <LogsPanel
      initial={{ items: [log({ id: "1", message: "newer failure" })], nextCursor: "cur_1" }}
    />
  );

  await user.click(screen.getByRole("button", { name: /load older/i }));

  expect(getLogs).toHaveBeenCalledWith(expect.objectContaining({ cursor: "cur_1" }));
  expect(await screen.findByText("older failure")).toBeInTheDocument();
  expect(screen.getByText("newer failure")).toBeInTheDocument();
  // Exhausted cursor retires the control rather than paging forever.
  expect(screen.queryByRole("button", { name: /load older/i })).not.toBeInTheDocument();
});

test("surfaces a failed query instead of silently showing stale records", async () => {
  const user = userEvent.setup();
  vi.mocked(getLogs).mockRejectedValue(new Error("network down"));

  render(
    <LogsPanel
      initial={{ items: [log({ id: "1", message: "database timeout" })], nextCursor: null }}
    />
  );

  await user.click(screen.getByRole("button", { name: "fatal" }));

  expect(await screen.findByText(/could not load logs/i)).toBeInTheDocument();
});

test("marks a fatal record distinctly from an error", () => {
  render(
    <LogsPanel
      initial={{
        items: [log({ id: "1", message: "worker died", level: "fatal" })],
        nextCursor: null,
      }}
    />
  );

  const row = screen.getByText("worker died").closest("li");
  expect(row).not.toBeNull();
  expect(within(row as HTMLElement).getByText("fatal")).toBeInTheDocument();
});
