import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { routine } from "@tulipfarm/schema";
import { afterEach, expect, test, vi } from "vitest";
import { RoutineRunCanvas } from "~/components/routines/routine-run-canvas";
import { projectRoutineGraph } from "~/lib/routines/graph";
import { reduceRunOverlay } from "~/lib/routines/run-overlay";
import RoutineDetail from "./_app.routines.$slug";

vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return { ...actual, useLoaderData: vi.fn() };
});

const definition: routine.RoutineDefinition = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "Routine",
  metadata: {
    id: "22222222-2222-4222-8222-222222222222",
    slug: "expense-report",
    displayName: "Expense report",
    schemaVersion: 1,
    authoredVersion: 1,
    lifecycle: "active",
  },
  spec: {
    owner: "user:owner",
    start: "Done",
    states: [
      { type: "agent", name: "Done", agentRef: { name: "assistant", version: "1" }, end: true },
    ],
  },
};

const triggers = [{ slug: "expense-report-manual", type: "manual", summary: "manual" }];

function renderRoute(Component: React.ComponentType, data: unknown) {
  vi.mocked(remix.useLoaderData).mockReturnValue(data);
  const Stub = createRemixStub([{ path: "/", Component }]);
  render(<Stub initialEntries={["/"]} />);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("published Routine makes its canvas primary while retaining Trigger and Run history", () => {
  renderRoute(RoutineDetail, {
    routine: {
      id: definition.metadata.id,
      slug: "expense-report",
      displayName: "Expense report",
      authoredVersion: 1,
      triggers,
      definition,
      hash: "sha256:abc",
    },
    runs: [
      {
        id: "run-12345678",
        routineSlug: "expense-report",
        status: "succeeded",
        createdAt: "2026-07-19T00:00:00Z",
        startedAt: "2026-07-19T00:00:00Z",
        finishedAt: "2026-07-19T00:00:01Z",
      },
    ],
  });
  expect(screen.getByRole("region", { name: /Routine canvas/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /run now/i })).toBeInTheDocument();
  expect(screen.getByText(/run history/i)).toBeInTheDocument();
});

test("a Routine with no Trigger is still startable by hand", () => {
  renderRoute(RoutineDetail, {
    routine: {
      id: definition.metadata.id,
      slug: "expense-report",
      displayName: "Expense report",
      authoredVersion: 1,
      triggers: [],
      definition,
      hash: "sha256:abc",
    },
    runs: [],
  });
  expect(screen.getByRole("button", { name: /run now/i })).toBeInTheDocument();
  expect(screen.getByText(/only runs when started by hand/i)).toBeInTheDocument();
});

test("Run canvas dedupes SSE into one journal entry", async () => {
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
  const graph = projectRoutineGraph(definition, triggers);
  const events = [
    { seq: 1, type: "state.transitioned", payload: { source: "Done", end: true } },
    { seq: 1, type: "state.transitioned", payload: { source: "Done", end: true } },
  ];
  const deduped = [...new Map(events.map((event) => [event.seq, event])).values()];
  render(
    <RoutineRunCanvas graph={graph} overlay={reduceRunOverlay(graph, deduped)} events={deduped} />
  );

  expect(screen.getByRole("region", { name: /Run canvas/ })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /journal/i }));
  expect(screen.getAllByText("state.transitioned")).toHaveLength(1);
});

test("a cancellation event overrides a sleeping overlay", () => {
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
  const graph = projectRoutineGraph(definition, triggers);
  const events = [
    { seq: 1, type: "state.entered", payload: { state: "Done" } },
    { seq: 2, type: "run.sleeping", payload: { state: "Done" } },
    { seq: 3, type: "run.cancelled", payload: { state: "Done" } },
  ];
  render(
    <RoutineRunCanvas graph={graph} overlay={reduceRunOverlay(graph, events)} events={events} />
  );

  expect(screen.getByRole("button", { name: /State Done, agent, cancelled/ })).toBeInTheDocument();
});
