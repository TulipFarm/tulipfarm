import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { RoutineSummary } from "~/lib/routines";
import { listRoutines } from "~/lib/routines";
import ScheduledTasks, { clientLoader } from "./_app.routines.scheduled";

vi.mock("@remix-run/react", async () => ({
  ...(await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react")),
  useLoaderData: vi.fn(),
}));

vi.mock("~/lib/routines", async () => ({
  ...(await vi.importActual<typeof import("~/lib/routines")>("~/lib/routines")),
  listRoutines: vi.fn(),
}));

vi.mock("~/lib/operations", async () => ({
  ...(await vi.importActual<typeof import("~/lib/operations")>("~/lib/operations")),
  listOperationalRuns: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
}));

const summary = (over: Partial<RoutineSummary["summary"]> = {}): RoutineSummary["summary"] => ({
  owner: null,
  stateCount: 1,
  stateTypes: [],
  agentRefs: [],
  effects: [],
  toolAbilities: [],
  maxRiskClass: null,
  requiresApproval: false,
  concurrencyPolicy: null,
  compensationPolicy: null,
  ...over,
});

const ROUTINES: RoutineSummary[] = [
  {
    id: "r1",
    slug: "nightly-report",
    displayName: "Nightly report",
    authoredVersion: 1,
    triggers: [{ slug: "nightly", type: "cron", summary: "cron 0 9 * * 1-5" }],
    summary: summary(),
  },
  {
    id: "r2",
    slug: "poll-inbox",
    displayName: "Poll inbox",
    authoredVersion: 1,
    triggers: [{ slug: "poll", type: "interval", summary: "every 5 minutes" }],
    summary: summary(),
  },
  {
    id: "r3",
    slug: "kickoff-reminder",
    displayName: "Kickoff reminder",
    authoredVersion: 1,
    triggers: [{ slug: "once", type: "datetime", summary: "at 2026-01-01T09:00:00Z" }],
    summary: summary(),
  },
  {
    id: "r4",
    slug: "issue-triage",
    displayName: "Issue triage",
    authoredVersion: 1,
    triggers: [{ slug: "hook", type: "webhook", summary: "POST /triage" }],
    summary: summary(),
  },
  {
    id: "r5",
    slug: "manual-cleanup",
    displayName: "Manual cleanup",
    authoredVersion: 1,
    triggers: [],
    summary: summary(),
  },
];

test("the loader keeps only cron, interval and datetime routines", async () => {
  vi.mocked(listRoutines).mockResolvedValue(ROUTINES);

  const data = await clientLoader();

  expect(data.routines.map((routine) => routine.slug)).toEqual([
    "nightly-report",
    "poll-inbox",
    "kickoff-reminder",
  ]);
});

test("renders each scheduled routine with its humanized schedule", () => {
  vi.mocked(remix.useLoaderData).mockReturnValue({
    routines: ROUTINES.filter((routine) => routine.id !== "r4" && routine.id !== "r5"),
    latest: {},
  });
  const Stub = createRemixStub([{ path: "/", Component: ScheduledTasks }]);
  render(<Stub initialEntries={["/"]} />);

  expect(screen.getByText("Nightly report")).toBeInTheDocument();
  expect(screen.getByText(/every weekday at 9:00 am/i)).toBeInTheDocument();
  expect(screen.getByText("Poll inbox")).toBeInTheDocument();
  expect(screen.getByText(/runs every 5 minutes/i)).toBeInTheDocument();
  expect(screen.getByText("Kickoff reminder")).toBeInTheDocument();
  expect(screen.queryByText("Issue triage")).not.toBeInTheDocument();
  expect(screen.queryByText("Manual cleanup")).not.toBeInTheDocument();
});

test("an empty schedule explains itself instead of looking broken", () => {
  vi.mocked(remix.useLoaderData).mockReturnValue({ routines: [], latest: {} });
  const Stub = createRemixStub([{ path: "/", Component: ScheduledTasks }]);
  render(<Stub initialEntries={["/"]} />);

  expect(screen.getByText(/no routines run on a schedule yet/i)).toBeInTheDocument();
});
