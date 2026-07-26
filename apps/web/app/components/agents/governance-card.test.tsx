import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentGovernanceCard } from "./governance-card";

const governance = {
  version: "3",
  roles: ["support-reader"],
  skills: ["triage"],
  tools: ["github.issue.read"],
  modelProfile: "balanced",
  limits: { turns: 20, toolCalls: 8 },
  evaluation: { status: "passed" as const, suite: "support-v2", passedAt: "2026-07-26" },
  publication: {
    candidateVersion: "4",
    status: "validated" as const,
    canPublish: true,
  },
};

describe("AgentGovernanceCard", () => {
  it("shows exact candidate and governed publication evidence", async () => {
    const onPublish = vi.fn();
    const user = userEvent.setup();
    render(<AgentGovernanceCard governance={governance} onPublish={onPublish} />);

    expect(screen.getByText("candidate 4")).toBeInTheDocument();
    expect(screen.getByText(/support-v2/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Propose version 4" }));
    expect(onPublish).toHaveBeenCalledTimes(1);
  });

  it("blocks stale or failed candidates as presentation", () => {
    render(
      <AgentGovernanceCard
        governance={{
          ...governance,
          evaluation: { ...governance.evaluation, status: "stale" },
          publication: {
            candidateVersion: "4",
            status: "blocked",
            canPublish: false,
            reason: "Evaluation is stale",
          },
        }}
        onPublish={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: "Propose version 4" })).toBeDisabled();
    expect(screen.getByText("Evaluation is stale")).toBeInTheDocument();
  });
});
