import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import ChatRoute from "~/routes/_app._index";

// Mock the loader hook and render the Component directly (the convention used by the other route
// tests) — avoids the async clientLoader boundary while still supplying router context for the
// composer's links/nav.
vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return { ...actual, useLoaderData: vi.fn() };
});

// jsdom has no layout engine; the transcript's auto-scroll calls scrollIntoView.
Element.prototype.scrollIntoView = vi.fn();

const Stub = createRemixStub([{ path: "/", Component: ChatRoute }]);

test("default view is the live chat empty state with a composer (AC-V1-001)", () => {
  vi.mocked(remix.useLoaderData).mockReturnValue({ agentId: undefined, defaultModel: "standard" });
  render(<Stub initialEntries={["/"]} />);

  // Signature welcome (blinking wordmark + ready status + active agent).
  expect(screen.getByRole("heading", { name: /tulipfarm/i })).toBeInTheDocument();
  expect(screen.getByText("ready")).toBeInTheDocument();
  expect(screen.getByText("GeneralAssistant")).toBeInTheDocument();

  // Suggestion chips seed the composer; the composer itself is interactive (no longer a placeholder).
  expect(screen.getByRole("button", { name: /what can you do/i })).toBeInTheDocument();
  expect(screen.getByLabelText("Message")).toBeInTheDocument();

  // No file-attachment affordance in V1.
  expect(document.querySelector('input[type="file"]')).toBeNull();
});
