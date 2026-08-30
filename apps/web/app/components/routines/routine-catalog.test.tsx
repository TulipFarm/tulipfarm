import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import type { RoutineSummary } from "~/lib/routines";
import { type LatestRuns, RoutineCatalog } from "./routine-catalog";

const summary = (over: Partial<RoutineSummary["summary"]> = {}): RoutineSummary["summary"] => ({
  owner: "user:finance",
  stateCount: 3,
  stateTypes: ["compute"],
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
    slug: "expense-report",
    displayName: "Expense report",
    authoredVersion: 1,
    triggers: [{ slug: "nightly", type: "cron", summary: "0 9 * * 1" }],
    summary: summary({ effects: ["tool"], maxRiskClass: "high" }),
  },
  {
    id: "r2",
    slug: "issue-triage",
    displayName: "Issue triage",
    authoredVersion: 4,
    triggers: [{ slug: "hook", type: "webhook", summary: "POST /triage" }],
    summary: summary({ owner: "user:eng" }),
  },
  {
    id: "r3",
    slug: "manual-cleanup",
    displayName: "Manual cleanup",
    authoredVersion: 1,
    triggers: [],
    summary: summary({ owner: "user:ops" }),
  },
];

const LATEST: LatestRuns = {
  r1: { id: "run-1", status: "failed", createdAt: "2026-08-01T00:00:00Z" },
  r2: { id: "run-2", status: "succeeded", createdAt: "2026-08-02T00:00:00Z" },
};

function renderCatalog(routines: RoutineSummary[] = ROUTINES, latest: LatestRuns = LATEST) {
  const Stub = createRemixStub([
    { path: "/", Component: () => <RoutineCatalog routines={routines} latest={latest} /> },
  ]);
  render(<Stub initialEntries={["/"]} />);
}

test("groups routines by how they start, so the list reads as an inventory", () => {
  renderCatalog();
  expect(screen.getByRole("region", { name: /on a schedule/i })).toBeInTheDocument();
  expect(screen.getByRole("region", { name: /when called/i })).toBeInTheDocument();
  expect(screen.getByRole("region", { name: /not triggered automatically/i })).toBeInTheDocument();
});

test("search narrows the list and says how much of it is left", async () => {
  renderCatalog();
  await userEvent.type(screen.getByRole("searchbox"), "triage");
  expect(screen.getByRole("status")).toHaveTextContent(/1 of 3/i);
  expect(screen.queryByText("Expense report")).not.toBeInTheDocument();
});

test("filtering by health finds the failing routine", async () => {
  renderCatalog();
  await userEvent.selectOptions(screen.getByLabelText(/health/i), "failing");
  expect(screen.getByText("Expense report")).toBeInTheDocument();
  expect(screen.queryByText("Issue triage")).not.toBeInTheDocument();
});

/*
 * A filter that hides everything must say so. An empty page under an active filter is otherwise
 * indistinguishable from an instance that has no routines at all, and the two need opposite
 * responses from the reader.
 */
test("a filter that matches nothing explains itself rather than blanking", async () => {
  renderCatalog();
  await userEvent.type(screen.getByRole("searchbox"), "zzzz-no-such-routine");
  expect(screen.getByRole("status")).toHaveTextContent(/0 of 3/i);
  expect(screen.getByText(/no routine matches/i)).toBeInTheDocument();
});

test("a routine that has never run says so instead of reading as healthy", () => {
  renderCatalog();
  const row = screen.getByText("Manual cleanup").closest("li");
  expect(row).toHaveTextContent(/never run/i);
});
