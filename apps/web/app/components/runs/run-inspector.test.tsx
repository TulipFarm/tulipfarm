import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RunInspector } from "./run-inspector";

const run = {
  id: "run-1",
  routineId: "triage",
  routineVersion: "3",
  status: "attention_required",
  version: 7,
  createdAt: "2026-07-26T00:00:00Z",
  startedAt: "2026-07-26T00:00:01Z",
  finishedAt: null,
  states: [{ key: "classify", status: "succeeded", attempts: 1, output: { label: "bug" } }],
  effects: [{ id: "effect-1", status: "ambiguous", target: "github.repository/acme/repo" }],
  waits: [{ kind: "approval", status: "open" }],
  guardrailDecisions: [{ decision: "allow", revision: "gr-7" }],
  lineage: [{ relation: "replay", sourceRunId: "run-0" }],
  costs: { amountUsd: 0.12, modelTokens: 900 },
};

describe("RunInspector", () => {
  it("renders the authorized Run evidence model", () => {
    render(<RunInspector run={run} onCommand={vi.fn()} />);
    expect(screen.getByText("classify")).toBeInTheDocument();
    expect(screen.getByText(/effect-1/)).toBeInTheDocument();
    expect(screen.getByText(/approval/)).toBeInTheDocument();
    expect(screen.getByText(/gr-7/)).toBeInTheDocument();
    expect(screen.getByText(/\$0\.1200/)).toBeInTheDocument();
  });

  it("previews destructive commands before delegating them", async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn();
    render(<RunInspector run={run} onCommand={onCommand} />);
    await user.click(screen.getByRole("button", { name: "Cancel Run" }));
    expect(screen.getAllByText("run-1")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Confirm Cancel Run" }));
    expect(onCommand).toHaveBeenCalledWith("cancel");
  });
});
