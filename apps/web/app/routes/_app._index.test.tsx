import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
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
vi.mock("~/lib/onboarding", () => ({ listOnboardingSuggestions: vi.fn() }));

import { getAgent } from "~/lib/agents";
import { listOnboardingSuggestions } from "~/lib/onboarding";

// jsdom has no layout engine; the transcript's auto-scroll calls scrollIntoView.
Element.prototype.scrollIntoView = vi.fn();

const Stub = createRemixStub([{ path: "/", Component: ChatRoute }]);

test("default view is the live chat empty state with adaptive suggestions (AC-V1-001/002)", () => {
  vi.mocked(remix.useLoaderData).mockReturnValue({
    agentId: undefined,
    defaultModel: "standard",
    suggestions: [
      {
        id: "tickets",
        label: "Set up ticket management?",
        prompt: "Help me set up ticket management.",
      },
    ],
  });
  render(<Stub initialEntries={["/"]} />);

  // Signature welcome (blinking wordmark + ready status + active agent).
  expect(screen.getByRole("heading", { name: /tulipfarm/i })).toBeInTheDocument();
  expect(screen.getByText("ready")).toBeInTheDocument();
  expect(screen.getByText("GeneralAssistant")).toBeInTheDocument();

  // Adaptive soul-derived suggestion chip (replaces the former hardcoded set).
  expect(screen.getByRole("button", { name: "Set up ticket management?" })).toBeInTheDocument();
  expect(screen.getByLabelText("Message")).toBeInTheDocument();

  // No file-attachment affordance in V1.
  expect(document.querySelector('input[type="file"]')).toBeNull();
});

test("clientLoader never blocks chat: a failed suggestions fetch yields [] (AC-V1-001)", async () => {
  vi.mocked(getAgent).mockRejectedValue(new Error("api down"));
  vi.mocked(listOnboardingSuggestions).mockRejectedValue(new Error("api down"));

  const data = await clientLoader({
    request: new Request("http://localhost/"),
    params: {},
  } as Parameters<typeof clientLoader>[0]);

  expect(data.suggestions).toEqual([]);
  expect(data.defaultModel).toBe("standard");
});
