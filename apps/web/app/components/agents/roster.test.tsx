import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import type { AgentSummary, BuiltInAgentSummary } from "~/lib/agents";
import { AgentRoster } from "./roster";

const customAgent = (over: Partial<AgentSummary> = {}): AgentSummary => ({
  name: "sync-agent",
  label: "Sync Agent",
  domain: "github",
  description: "Keeps stargazer records in sync.",
  autonomy: "supervised",
  ...over,
});

const builtInAgent = (over: Partial<BuiltInAgentSummary> = {}): BuiltInAgentSummary => ({
  id: "tool_result_distiller",
  purpose: "Summarizes long tool output for the transcript.",
  rung: "fast",
  ...over,
});

function renderRoster(node: ReactElement) {
  const Stub = createRemixStub([{ path: "/", Component: () => node }]);
  render(<Stub />);
}

describe("AgentRoster", () => {
  it("lists custom and built-in agents together in one roster", () => {
    renderRoster(<AgentRoster agents={[customAgent()]} builtIn={[builtInAgent()]} />);

    expect(screen.getByRole("link", { name: "Sync Agent" })).toBeInTheDocument();
    expect(screen.getByText("Tool Result Distiller")).toBeInTheDocument();
    // One list, not a separate "Built-in" section heading.
    expect(screen.queryByRole("heading", { name: "Built-in" })).not.toBeInTheDocument();
  });

  it("marks each row with a colored type badge", () => {
    renderRoster(<AgentRoster agents={[customAgent()]} builtIn={[builtInAgent()]} />);

    expect(screen.getByText("Custom")).toBeInTheDocument();
    expect(screen.getByText("Built-in")).toBeInTheDocument();
  });

  it("renders agent avatars without initials or raw identifiers", () => {
    renderRoster(
      <AgentRoster
        agents={[customAgent({ name: "context_compactor_helper" })]}
        builtIn={[builtInAgent({ id: "context_compactor" })]}
      />
    );

    // The snake_case id no longer appears anywhere in the row.
    expect(screen.queryByText("context_compactor")).not.toBeInTheDocument();
    expect(screen.queryByText("context_compactor_helper")).not.toBeInTheDocument();
    // No initials text rendered as avatar content (avatars are empty, decorative discs).
    expect(screen.queryByText("CC")).not.toBeInTheDocument();
    expect(screen.queryByText("SA")).not.toBeInTheDocument();
  });

  it("filters the whole unified roster by search, custom and built-in alike", async () => {
    const user = userEvent.setup();
    renderRoster(
      <AgentRoster
        agents={[customAgent({ name: "sync-agent", label: "Sync Agent" })]}
        builtIn={[builtInAgent({ id: "chat_titler", purpose: "Writes a short chat title." })]}
      />
    );

    await user.type(screen.getByLabelText("Search agents"), "chat title");

    expect(screen.queryByRole("link", { name: "Sync Agent" })).not.toBeInTheDocument();
    expect(screen.getByText("Chat Titler")).toBeInTheDocument();
  });

  it("shows the empty state when no agent of either kind matches", async () => {
    const user = userEvent.setup();
    renderRoster(<AgentRoster agents={[customAgent()]} builtIn={[builtInAgent()]} />);

    await user.type(screen.getByLabelText("Search agents"), "nothing-matches-this-at-all");

    expect(screen.getByText(/No agent matches those filters/)).toBeInTheDocument();
  });
});
