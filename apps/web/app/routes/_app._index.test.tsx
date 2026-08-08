import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
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
  getOnboardingChecklist: vi.fn(),
  dismissOnboardingChecklist: vi.fn(),
}));

import { getAgent } from "~/lib/agents";
import {
  dismissOnboardingChecklist,
  getOnboardingChecklist,
  listOnboardingSuggestions,
} from "~/lib/onboarding";

// jsdom has no layout engine; the transcript's auto-scroll calls scrollIntoView.
Element.prototype.scrollIntoView = vi.fn();

const Stub = createRemixStub([{ path: "/", Component: ChatRoute }]);

test("default view is the live chat empty state with adaptive suggestions", () => {
  vi.mocked(remix.useLoaderData).mockReturnValue({
    agentId: undefined,
    defaultModel: "auto",
    suggestions: [
      {
        id: "tickets",
        label: "Set up ticket management?",
        prompt: "Help me set up ticket management.",
      },
    ],
    checklist: null,
  });
  render(<Stub initialEntries={["/"]} />);

  // Normal Chat is the default harness, not a user-created Agent.
  expect(screen.getByRole("heading", { name: "What can I help with?" })).toBeInTheDocument();
  expect(screen.queryByText("ready")).not.toBeInTheDocument();
  expect(screen.queryByText("TulipFarm")).not.toBeInTheDocument();

  // Adaptive soul-derived suggestion chip (replaces the former hardcoded set).
  expect(screen.getByRole("button", { name: "Set up ticket management?" })).toBeInTheDocument();
  expect(screen.getByLabelText("Message")).toBeInTheDocument();

  // No file-attachment affordance in V1.
  expect(document.querySelector('input[type="file"]')).toBeNull();
});

test("clientLoader never blocks chat: a failed suggestions fetch yields []", async () => {
  vi.mocked(getAgent).mockRejectedValue(new Error("api down"));
  vi.mocked(listOnboardingSuggestions).mockRejectedValue(new Error("api down"));
  vi.mocked(getOnboardingChecklist).mockRejectedValue(new Error("api down"));

  const data = await clientLoader({
    request: new Request("http://localhost/"),
    params: {},
  } as Parameters<typeof clientLoader>[0]);

  expect(data.suggestions).toEqual([]);
  expect(data.checklist).toBeNull();
  expect(data.defaultModel).toBe("auto");
});

test("the Getting-started card renders and route-level dismissal hides it (persists API call)", () => {
  vi.mocked(remix.useLoaderData).mockReturnValue({
    agentId: undefined,
    defaultModel: "auto",
    suggestions: [],
    checklist: {
      dismissed: false,
      businessName: "Acme Tulips",
      steps: [
        { id: "resource", label: "Create a resource type", status: "todo", prompt: "Help me." },
      ],
      recommendations: [],
    },
  });
  vi.mocked(dismissOnboardingChecklist).mockResolvedValue();
  render(<Stub initialEntries={["/"]} />);

  // Card visible (dismissal state lives in the route, above the newChatNonce-keyed ChatPanel).
  expect(screen.getByText(/Getting started/)).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "What can I help Acme Tulips with?" })
  ).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("Dismiss getting started"));

  // Optimistically hidden + the persistence call fired.
  expect(screen.queryByText(/Getting started/)).toBeNull();
  expect(dismissOnboardingChecklist).toHaveBeenCalledOnce();
});
