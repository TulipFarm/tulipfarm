import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { expect, test, vi } from "vitest";
import type { AgentSummary } from "~/lib/agents";
import { ApiError } from "~/lib/api";
import AgentsIndex, { ErrorBoundary as IndexErrorBoundary } from "./_app.agents._index";
import AgentDetail, { ErrorBoundary as DetailErrorBoundary } from "./_app.agents.$name";

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
  capabilityRestrictions: {
    tools: { allowMutating: false },
    records: { actions: { allow: ["read"] as const, deny: ["delete"] as const } },
  },
};

const stargazer: AgentSummary = {
  name: "github-stargazer-sync",
  label: "GitHub Stargazer Sync",
  domain: "github",
  description: "Stores star records.",
  autonomy: "full",
  capabilityRestrictions: {
    records: { actions: { allow: ["create"] }, resourceTypes: ["github-star"] },
  },
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

function cardFor(label: string): HTMLElement {
  const card = screen.getByRole("link", { name: label }).closest("article");
  if (!card) throw new Error(`no card for ${label}`);
  return card;
}

test("index lists agents with label, domain, and autonomy", () => {
  renderWithData(<AgentsIndex />, { agents: [agent] });
  expect(screen.getByRole("link", { name: "Sprint Planner" })).toHaveAttribute(
    "href",
    "/agents/sprint-planner"
  );
  const card = cardFor("Sprint Planner");
  expect(within(card).getByText("engineering")).toBeInTheDocument();
  expect(within(card).getByText("Supervised")).toBeInTheDocument();
});

test("index gives every agent a chat shortcut that preselects it", () => {
  renderWithData(<AgentsIndex />, { agents: [agent] });
  expect(screen.getByRole("link", { name: "Start a chat with Sprint Planner" })).toHaveAttribute(
    "href",
    "/?agent=sprint-planner"
  );
});

test("index states whether each agent can change anything", () => {
  renderWithData(<AgentsIndex />, { agents: [agent, stargazer] });
  expect(within(cardFor("Sprint Planner")).getByText("Reads only")).toBeInTheDocument();
  expect(within(cardFor("GitHub Stargazer Sync")).getByText("Changes data")).toBeInTheDocument();
});

test("index search narrows the roster by the record type an agent is pointed at", async () => {
  const user = userEvent.setup();
  renderWithData(<AgentsIndex />, { agents: [agent, stargazer] });

  await user.type(screen.getByLabelText("Search agents"), "github-star");

  expect(screen.getByRole("link", { name: "GitHub Stargazer Sync" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Sprint Planner" })).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("1 of 2 agents match");
});

test("index reach filter keeps only agents that cannot change anything", async () => {
  const user = userEvent.setup();
  renderWithData(<AgentsIndex />, { agents: [agent, stargazer] });

  await user.selectOptions(screen.getByLabelText("Reach"), "read-only");

  expect(screen.getByRole("link", { name: "Sprint Planner" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "GitHub Stargazer Sync" })).not.toBeInTheDocument();
});

test("index says so rather than going blank when no agent matches", async () => {
  const user = userEvent.setup();
  renderWithData(<AgentsIndex />, { agents: [agent] });

  await user.type(screen.getByLabelText("Search agents"), "invoices");

  expect(screen.getByText(/No agent matches those filters/)).toBeInTheDocument();
});

test("index groups by domain only once a domain holds more than one agent", async () => {
  renderWithData(<AgentsIndex />, { agents: [agent, stargazer] });
  expect(screen.queryByRole("heading", { name: "engineering" })).not.toBeInTheDocument();

  const second = { ...stargazer, name: "issue-triage", label: "Issue Triage" };
  renderWithData(<AgentsIndex />, { agents: [stargazer, second] });
  expect(await screen.findByRole("heading", { name: "github" })).toBeInTheDocument();
});

test("index with no agents explains what an agent is and points at Skills", () => {
  renderWithData(<AgentsIndex />, { agents: [] });
  expect(screen.getByText(/An agent is who does the work/)).toBeInTheDocument();
  expect(screen.getByText(/add a skill instead/)).toBeInTheDocument();
});

test("index distinguishes an agent from a Skill and links to Skills", () => {
  renderWithData(<AgentsIndex />, { agents: [agent] });
  expect(screen.getByRole("link", { name: "Skills" })).toHaveAttribute("href", "/skills");
});

test("index ErrorBoundary surfaces 401 as authentication required", () => {
  renderError(<IndexErrorBoundary />, new ApiError(401, "unauthorized"));
  expect(screen.getByText(/authentication required/i)).toBeInTheDocument();
});

test("detail renders the AGENT.md body, meta, and a Chat-with shortcut", () => {
  renderWithData(<AgentDetail />, { agent });
  expect(screen.getByText("You plan sprints.")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Start a chat with Sprint Planner" })).toHaveAttribute(
    "href",
    "/?agent=sprint-planner"
  );
  expect(screen.getByText("auto")).toBeInTheDocument();
});

test("detail does not repeat the label it already shows as the heading", () => {
  renderWithData(<AgentDetail />, { agent });
  expect(screen.getAllByText("Sprint Planner")).toHaveLength(1);
});

test("detail turns each authored suggestion into a drafted chat link", () => {
  renderWithData(<AgentDetail />, { agent });
  expect(screen.getByRole("link", { name: "Plan next sprint" })).toHaveAttribute(
    "href",
    "/?agent=sprint-planner&draft=Plan+next+sprint"
  );
});

test("detail falls back to the placeholder prompts when no suggestions are authored", () => {
  renderWithData(<AgentDetail />, { agent: { ...agent, suggestions: undefined } });
  expect(screen.getByRole("link", { name: "Plan next sprint..." })).toBeInTheDocument();
});

test("detail hides the how-to-use panel when the agent ships no prompts", () => {
  renderWithData(<AgentDetail />, {
    agent: { ...agent, suggestions: undefined, placeholder: undefined },
  });
  expect(screen.queryByText("How to use it")).not.toBeInTheDocument();
});

test("detail states the permissions the runtime enforces, allowed and denied", () => {
  renderWithData(<AgentDetail />, { agent });
  const panel = screen.getByText("What it is allowed to do").closest("section");
  if (!panel) throw new Error("capability panel missing");
  expect(within(panel).getByText("Reads only")).toBeInTheDocument();
  expect(within(panel).getByText("read")).toBeInTheDocument();
  expect(within(panel).getByText("delete")).toBeInTheDocument();
  expect(within(panel).getByText("blocked:")).toBeInTheDocument();
});

test("detail links each record type it can reach to that type's records", () => {
  renderWithData(<AgentDetail />, { agent: { ...agent, ...stargazer, body: "x" } });
  expect(screen.getByRole("link", { name: "github-star" })).toHaveAttribute(
    "href",
    "/resources/github-star"
  );
});

test("detail warns when an agent declares no limits at all", () => {
  renderWithData(<AgentDetail />, { agent: { ...agent, capabilityRestrictions: undefined } });
  expect(screen.getByText("Unrestricted")).toBeInTheDocument();
  expect(screen.getByText(/No limits declared/)).toBeInTheDocument();
});

test("detail points at the page that decides who the agent works for", () => {
  renderWithData(<AgentDetail />, { agent });
  expect(screen.getByRole("link", { name: "Manage teams for Sprint Planner" })).toHaveAttribute(
    "href",
    "/business/access/agents"
  );
});

test("detail ErrorBoundary renders 404 not found for a missing agent", () => {
  renderError(<DetailErrorBoundary />, new ApiError(404, "not found"));
  expect(screen.getByText(/404 not found/i)).toBeInTheDocument();
});
