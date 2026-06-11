import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { expect, test, vi } from "vitest";
import { ApiError } from "~/lib/api";
import AgentsIndex, { ErrorBoundary as IndexErrorBoundary } from "./_app.agents._index";
import AgentDetail, { ErrorBoundary as DetailErrorBoundary } from "./_app.agents.$name";

/*
 * Agents route smoke tests. Same approach as resources.routes.test.tsx: mock the loader/error hooks
 * and render Component / ErrorBoundary directly (Link + useNavigate need router context, supplied by
 * createRemixStub).
 */

vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return {
    ...actual,
    useLoaderData: vi.fn(),
    useRouteError: vi.fn(),
    useParams: vi.fn(() => ({})),
  };
});

const agent = {
  name: "sprint-planner",
  label: "Sprint Planner",
  domain: "engineering",
  description: "Breaks PRDs into sprints.",
  model: "auto",
  autonomy: "supervised" as const,
  placeholder: ["Plan next sprint..."],
  suggestions: ["Plan next sprint"],
  body: "# Role\nYou plan sprints.",
};

function renderWithData(node: ReactElement, data: unknown) {
  vi.mocked(remix.useLoaderData).mockReturnValue(data);
  const Stub = createRemixStub([{ path: "/", Component: () => node }]);
  render(<Stub initialEntries={["/"]} />);
}

function renderError(node: ReactElement, error: unknown) {
  vi.mocked(remix.useRouteError).mockReturnValue(error);
  render(node);
}

test("index lists agents with label, domain, and autonomy", () => {
  renderWithData(<AgentsIndex />, { agents: [agent] });
  expect(screen.getByText("1 agent")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Sprint Planner/ })).toHaveAttribute(
    "href",
    "/agents/sprint-planner"
  );
  expect(screen.getByText("engineering")).toBeInTheDocument();
  expect(screen.getByText("supervised")).toBeInTheDocument();
});

test("index with no agents shows the empty state", () => {
  renderWithData(<AgentsIndex />, { agents: [] });
  expect(screen.getByText("0 results")).toBeInTheDocument();
});

test("index ErrorBoundary surfaces 401 as authentication required", () => {
  renderError(<IndexErrorBoundary />, new ApiError(401, "unauthorized"));
  expect(screen.getByText(/authentication required/i)).toBeInTheDocument();
});

test("detail renders the AGENT.md body, meta, and a Chat-with shortcut", () => {
  renderWithData(<AgentDetail />, { agent });
  expect(screen.getByText("You plan sprints.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Chat with Sprint Planner/ })).toBeInTheDocument();
  expect(screen.getByText("auto")).toBeInTheDocument();
});

test("detail ErrorBoundary renders 404 not found for a missing agent", () => {
  renderError(<DetailErrorBoundary />, new ApiError(404, "not found"));
  expect(screen.getByText(/404 not found/i)).toBeInTheDocument();
});
