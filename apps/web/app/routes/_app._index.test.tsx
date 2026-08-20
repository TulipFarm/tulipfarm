import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { CompanionProvider } from "~/lib/companion-context";
import ChatRoute, { clientLoader } from "~/routes/_app._index";

// Mock the loader hook and render the Component directly (the convention used by the other route
// tests) — avoids the async clientLoader boundary while still supplying router context for the
// composer's links/nav.
vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return { ...actual, useLoaderData: vi.fn() };
});

// clientLoader-direct test (catch path) mocks the data clients it calls.
vi.mock("~/lib/agents", () => ({
  getAgent: vi.fn(),
  listAgents: vi.fn(() => Promise.resolve([])),
}));
vi.mock("~/lib/onboarding", () => ({
  listOnboardingSuggestions: vi.fn(),
}));
vi.mock("~/lib/tasks", () => ({
  listTasks: vi.fn(),
}));

import { getAgent } from "~/lib/agents";
import { listOnboardingSuggestions } from "~/lib/onboarding";
import { listTasks } from "~/lib/tasks";

// jsdom has no layout engine; the transcript's auto-scroll calls scrollIntoView.
Element.prototype.scrollIntoView = vi.fn();

function ChatRouteWithCompanion() {
  return (
    <CompanionProvider>
      <ChatRoute />
    </CompanionProvider>
  );
}

const Stub = createRemixStub([{ path: "/", Component: ChatRouteWithCompanion }]);

const SUGGESTION = {
  id: "tickets",
  label: "Set up ticket management?",
  prompt: "Help me set up ticket management.",
};

// Onboarding is fetched by the component after mount (never in the loader — that would block the
// first paint), so every render test needs these resolved and must await the result.
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listOnboardingSuggestions).mockResolvedValue([]);
  vi.mocked(listTasks).mockResolvedValue([]);
  vi.mocked(remix.useLoaderData).mockReturnValue({ agentId: undefined, defaultModel: "auto" });
});

test("default view is the live chat empty state with adaptive suggestions", async () => {
  vi.mocked(listOnboardingSuggestions).mockResolvedValue([SUGGESTION]);
  render(<Stub initialEntries={["/"]} />);

  // Normal Chat is the default harness, not a user-created Agent.
  expect(screen.getByRole("heading", { name: "What can I help with?" })).toBeInTheDocument();
  expect(screen.queryByText("ready")).not.toBeInTheDocument();
  expect(screen.queryByText("TulipFarm")).not.toBeInTheDocument();

  // Chat is usable immediately — the composer does not wait on onboarding.
  expect(screen.getByLabelText("Message")).toBeInTheDocument();

  // Adaptive soul-derived suggestion chip (replaces the former hardcoded set), filled in async.
  expect(
    await screen.findByRole("button", { name: "Set up ticket management?" })
  ).toBeInTheDocument();

  // The empty state composes a full message, attachments included.
  expect(document.querySelector('input[type="file"]')).not.toBeNull();
});

test("clientLoader does no fetching, so nothing can delay the first paint", async () => {
  const data = await clientLoader({
    request: new Request("http://localhost/?agent=support"),
    params: {},
  } as Parameters<typeof clientLoader>[0]);

  expect(data).toEqual({ agentId: "support", defaultModel: "auto" });
  expect(listOnboardingSuggestions).not.toHaveBeenCalled();
});

test("a failed onboarding fetch leaves chat usable", async () => {
  vi.mocked(getAgent).mockRejectedValue(new Error("api down"));
  vi.mocked(listOnboardingSuggestions).mockRejectedValue(new Error("api down"));
  vi.mocked(listTasks).mockRejectedValue(new Error("api down"));

  render(<Stub initialEntries={["/"]} />);

  expect(screen.getByRole("heading", { name: "What can I help with?" })).toBeInTheDocument();
  expect(await screen.findByLabelText("Message")).toBeInTheDocument();
});

test("open Tasks render in the My Tasks preview card", async () => {
  vi.mocked(listTasks).mockResolvedValue([
    {
      id: "t1",
      title: "Add your business description",
      action: { kind: "chat", prompt: "Help me describe my business." },
      blocking: false,
      status: "open",
      createdAt: "2026-01-01T00:00:00Z",
    },
  ]);
  render(<Stub initialEntries={["/"]} />);

  expect(await screen.findByText("Add your business description")).toBeInTheDocument();
});
