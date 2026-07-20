import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import RoutineDetail from "./_app.routines.$slug";
import RunDetail from "./_app.routines.$slug.runs.$runId";

vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return { ...actual, useLoaderData: vi.fn() };
});

const definition = {
  id: "expense-report",
  version: "1",
  start: "Done",
  "x-triggers": [{ type: "manual" as const }],
  states: [{ name: "Done", type: "inject" as const, data: {}, end: true }],
};

const streamListeners = new Map<string, EventListener>();
class EventSourceStub {
  addEventListener = (type: string, listener: EventListener) => streamListeners.set(type, listener);
  close = vi.fn();
  onerror: (() => void) | null = null;
}

function renderRoute(Component: React.ComponentType, data: unknown) {
  vi.mocked(remix.useLoaderData).mockReturnValue(data);
  const Stub = createRemixStub([{ path: "/", Component }]);
  render(<Stub initialEntries={["/"]} />);
}

afterEach(() => {
  streamListeners.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("valid Routine makes its canvas primary while retaining Trigger and Run history", () => {
  renderRoute(RoutineDetail, {
    routine: {
      slug: "expense-report",
      valid: true,
      name: "Expense report",
      definition,
      triggers: definition["x-triggers"],
    },
    runs: [
      {
        id: "run-12345678",
        routineSlug: "expense-report",
        status: "succeeded",
        trigger: { type: "manual" },
        createdAt: "2026-07-19T00:00:00Z",
        updatedAt: "2026-07-19T00:00:01Z",
      },
    ],
  });
  expect(screen.getByRole("region", { name: /Routine canvas/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /run now/i })).toBeInTheDocument();
  expect(screen.getByText(/run history/i)).toBeInTheDocument();
});

test("invalid Routine renders its diagnostic without a canvas", () => {
  renderRoute(RoutineDetail, {
    routine: { slug: "broken", valid: false, loadError: "missing start State" },
    runs: [],
  });
  expect(screen.getByText("missing start State")).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: /Routine canvas/ })).toBeNull();
});

test("Run uses pinned definition, dedupes SSE, and retains its controls", async () => {
  vi.stubGlobal("EventSource", EventSourceStub);
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  renderRoute(RunDetail, {
    slug: "expense-report",
    runId: "run-12345678",
    detail: {
      run: {
        id: "run-12345678",
        routineSlug: "expense-report",
        status: "running",
        definitionSnapshot: definition,
        trigger: { type: "manual", triggerIndex: 0 },
        createdAt: "2026-07-19T00:00:00Z",
        updatedAt: "2026-07-19T00:00:01Z",
      },
      events: [],
    },
  });
  expect(screen.getByRole("region", { name: /Run canvas/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /State Done, inject/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /End from Done to End/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /cancel run/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /refresh/i })).toBeInTheDocument();
  const journal = screen.getByRole("button", { name: /journal/i });
  const handler = streamListeners.get("state.transitioned");
  expect(handler).toBeDefined();
  const message = new MessageEvent("state.transitioned", {
    data: JSON.stringify({ source: "Done", route: { kind: "end" }, end: true }),
    lastEventId: "1",
  });
  act(() => {
    handler?.(message);
    handler?.(message);
  });
  expect(document.querySelector("[data-animated='true']")).toBeInTheDocument();
  await userEvent.click(journal);
  expect(screen.getAllByText("state.transitioned")).toHaveLength(1);
  expect(screen.getByText(/"source": "Done"/)).toBeInTheDocument();
});

test("persisted cancellation overrides a sleeping journal overlay", () => {
  renderRoute(RunDetail, {
    slug: "expense-report",
    runId: "run-cancelled",
    detail: {
      run: {
        id: "run-cancelled",
        routineSlug: "expense-report",
        status: "cancelled",
        currentState: "Done",
        definitionSnapshot: definition,
        trigger: { type: "manual", triggerIndex: 0 },
        createdAt: "2026-07-19T00:00:00Z",
        updatedAt: "2026-07-19T00:00:01Z",
      },
      events: [
        { seq: 1, type: "state.entered", payload: { state: "Done" } },
        { seq: 2, type: "run.sleeping", payload: { state: "Done" } },
      ],
    },
  });
  expect(screen.getByRole("button", { name: /State Done, inject, cancelled/ })).toBeInTheDocument();
});
