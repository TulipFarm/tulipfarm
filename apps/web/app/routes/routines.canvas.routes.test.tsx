import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { routine } from "@tulipfarm/schema";
import { afterEach, expect, test, vi } from "vitest";
import { RoutineRunCanvas } from "~/components/routines/routine-run-canvas";
import { triggerRun } from "~/lib/routines";
import { type DryRunResult, dryRunRoutine } from "~/lib/routines/dry-run";
import { projectRoutineGraph } from "~/lib/routines/graph";
import { reduceRunOverlay } from "~/lib/routines/run-overlay";
import RoutineDetail from "./_app.routines.$slug";

vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return { ...actual, useLoaderData: vi.fn() };
});

vi.mock("~/lib/routines", async () => ({
  ...(await vi.importActual<typeof import("~/lib/routines")>("~/lib/routines")),
  triggerRun: vi.fn(),
}));
vi.mock("~/lib/routines/dry-run", async () => ({
  ...(await vi.importActual<typeof import("~/lib/routines/dry-run")>("~/lib/routines/dry-run")),
  dryRunRoutine: vi.fn(),
}));

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
  vi.clearAllMocks();
});

const rehearsal: DryRunResult = {
  risk: "medium",
  steps: [{ stateName: "Delegate", type: "child_routine", next: { kind: "end" } }],
  effects: [],
  stubbedStates: [],
  resultHash: "parent-rehearsal",
  durationMs: 1,
};

async function renderLinkedRoutines() {
  const actual = await vi.importActual<typeof remix>("@remix-run/react");
  vi.mocked(remix.useLoaderData).mockImplementation(actual.useLoaderData);
  const Stub = createRemixStub([
    {
      path: "/routines/:slug",
      Component: RoutineDetail,
      loader: ({ params }) => {
        const parent = params.slug === "parent";
        const slug = parent ? "parent" : "child";
        const id = parent ? "11111111-1111-4111-8111-111111111111" : definition.metadata.id;
        const displayName = parent ? "Parent" : "Child";
        const linkedDefinition: routine.RoutineDefinition = parent
          ? {
              ...definition,
              spec: {
                ...definition.spec,
                input: { type: "object", properties: { invoiceId: { type: "string" } } },
                start: "Delegate",
                states: [
                  {
                    type: "child_routine",
                    name: "Delegate",
                    routineRef: { name: "child", version: "1" },
                    mode: "detach",
                    end: true,
                  },
                ],
              },
            }
          : definition;
        return {
          routine: {
            id,
            slug,
            displayName,
            authoredVersion: 1,
            triggers: [],
            definition: {
              ...linkedDefinition,
              metadata: { ...linkedDefinition.metadata, id, slug, displayName },
            },
            hash: slug,
          },
          runs: [],
        };
      },
    },
    { path: "/runs/:id", Component: () => <p>Run details</p> },
  ]);
  render(<Stub initialEntries={["/routines/parent"]} />);
  await screen.findByRole("heading", { name: "Parent", level: 1 });
}

test("child routine navigation clears parent inputs and its completed dry run", async () => {
  vi.mocked(dryRunRoutine).mockResolvedValue(rehearsal);
  vi.mocked(triggerRun).mockResolvedValue({ runId: "child-run" });
  await renderLinkedRoutines();
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox", { name: "invoiceId" }), "invoice-from-parent");
  await user.click(screen.getByRole("button", { name: "Dry run" }));
  await screen.findByText("Dry run result");
  await user.click(screen.getByRole("link", { name: "child" }));
  await screen.findByRole("heading", { name: "Child", level: 1 });
  expect(screen.getByText("This routine takes no inputs.")).toBeInTheDocument();
  expect(screen.queryByText("Dry run result")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Run now" }));
  await waitFor(() => expect(triggerRun).toHaveBeenCalledWith("child", {}));
});

test("a late parent dry run does not populate the child routine", async () => {
  let finish = (_result: DryRunResult) => {};
  vi.mocked(dryRunRoutine).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  await renderLinkedRoutines();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Dry run" }));
  await user.click(screen.getByRole("link", { name: "child" }));
  await screen.findByRole("heading", { name: "Child", level: 1 });
  await act(async () => finish(rehearsal));
  expect(screen.queryByText("Dry run result")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Run now" })).toBeEnabled();
});

test("a late parent run does not navigate away from the child routine", async () => {
  let finish = (_result: { runId: string }) => {};
  vi.mocked(triggerRun).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  await renderLinkedRoutines();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Run now" }));
  await user.click(screen.getByRole("link", { name: "child" }));
  await screen.findByRole("heading", { name: "Child", level: 1 });
  await act(async () => finish({ runId: "parent-run" }));
  expect(screen.getByRole("heading", { name: "Child", level: 1 })).toBeInTheDocument();
  expect(screen.queryByText("Run details")).not.toBeInTheDocument();
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
  expect(screen.getByRole("link", { name: "assistant" })).toHaveAttribute(
    "href",
    "/agents/assistant"
  );
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
