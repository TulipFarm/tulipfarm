import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { OperationalRun } from "~/lib/operations";
import { RunInspector } from "./run-inspector";

const run: OperationalRun = {
  id: "run-1",
  routineId: "triage",
  routineVersion: "3",
  status: "attention_required",
  version: 7,
  availableCommands: ["cancel"],
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
    expect(screen.getByText("effect-1")).toBeInTheDocument();
    expect(screen.getByText("approval")).toBeInTheDocument();
    expect(screen.getByText("gr-7")).toBeInTheDocument();
    expect(screen.getByText(/\$0\.1200/)).toBeInTheDocument();
  });

  it.each([
    ["succeeded", "Run completed", "This Run finished successfully."],
    ["failed", "Run failed", "This Run stopped with a failure."],
    [
      "cancelled",
      "Run cancelled",
      "This Run was cancelled. Earlier effects may still have occurred.",
    ],
    ["running", "Run in progress", "This Run is still working. Results may be incomplete."],
    ["waiting", "Run waiting", "This Run is waiting before it can continue."],
    [
      "attention_required",
      "Run needs attention",
      "This Run needs operator attention before it can continue.",
    ],
    [
      "needs_reconciliation",
      "Run needs reconciliation",
      "The outcome of some work is uncertain. Review the evidence before continuing.",
    ],
  ])("explains %s before the evidence", (status, heading, explanation) => {
    render(<RunInspector run={{ ...run, status }} onCommand={vi.fn()} />);
    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.getByText(explanation)).toBeInTheDocument();
  });

  it("only offers commands returned by the API to an authorized operator", () => {
    const { rerender } = render(<RunInspector run={run} onCommand={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Cancel Run" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
    rerender(<RunInspector run={{ ...run, availableCommands: undefined }} onCommand={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Cancel Run" })).not.toBeInTheDocument();
    rerender(<RunInspector run={{ ...run, availableCommands: [] }} onCommand={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Cancel Run" })).not.toBeInTheDocument();
  });

  it("reads scalar output without claiming an Artifact ID is the result text", () => {
    render(
      <RunInspector
        run={{
          ...run,
          states: [
            {
              key: "respond",
              status: "succeeded",
              attempts: 1,
              output: "Review completed",
              resultArtifactId: "artifact-1",
            },
            { key: "fail", status: "failed", attempts: 2, errorEvidenceRef: "error:dispatch" },
          ],
        }}
        onCommand={vi.fn()}
      />
    );
    expect(screen.getByText("Review completed")).toBeVisible();
    expect(screen.getByText(/Result Artifact/)).toBeInTheDocument();
    expect(screen.getByText("artifact-1")).toBeVisible();
    expect(screen.getByText("error:dispatch")).toBeVisible();
    expect(screen.getByText("1 succeeded · 1 failed")).toBeInTheDocument();
    expect(screen.getByText("Effects (1)").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("Output JSON").closest("details")).not.toHaveAttribute("open");
  });

  it("reports duration only from recorded timestamps", () => {
    render(
      <RunInspector
        run={{ ...run, status: "succeeded", finishedAt: "2026-07-26T00:01:06Z" }}
        onCommand={vi.fn()}
      />
    );
    expect(screen.getByText("1m 5s")).toBeInTheDocument();
    expect(document.querySelector('time[datetime="2026-07-26T00:01:06Z"]')).toBeInTheDocument();
  });

  it("keeps the deployment's unavailable reason next to disabled controls", () => {
    render(
      <RunInspector run={run} unavailable="No Run authority configured" onCommand={vi.fn()} />
    );
    expect(screen.getByRole("button", { name: "Cancel Run" })).toBeDisabled();
    expect(
      screen.getByText(/Run control is unavailable: No Run authority configured/)
    ).toBeInTheDocument();
  });

  it("discloses readable evidence and keeps nested JSON formatted", async () => {
    render(<RunInspector run={run} onCommand={vi.fn()} />);
    expect(screen.getByText("effect-1")).not.toBeVisible();
    await userEvent.click(screen.getByText("Effects (1)"));
    expect(screen.getByText("effect-1")).toBeVisible();
    await userEvent.click(screen.getByText("Effects evidence JSON"));
    const evidence = screen.getByText(/"target": "github.repository\/acme\/repo"/);
    expect(evidence).toBeVisible();
    expect(evidence.textContent).toContain('\n  "id": "effect-1",');
  });

  it("keeps long State output wrapped and full text available", () => {
    const output = "UnbrokenRecordedValue".repeat(100);
    render(
      <RunInspector
        run={{ ...run, states: [{ key: "result", status: "succeeded", attempts: 1, output }] }}
        onCommand={vi.fn()}
      />
    );
    const result = screen.getByText(output, { exact: true });
    expect(result).toHaveClass("[overflow-wrap:anywhere]");
    expect(result).toHaveClass("whitespace-pre-wrap");
    expect(result).not.toHaveClass("truncate");
  });

  it("does not infer completion or an elapsed duration from missing timestamps", () => {
    render(
      <RunInspector run={{ ...run, status: "succeeded", startedAt: null }} onCommand={vi.fn()} />
    );
    expect(screen.queryByText("Duration")).not.toBeInTheDocument();
    expect(screen.queryByText("Finished")).not.toBeInTheDocument();
    expect(screen.queryByText("Started")).not.toBeInTheDocument();
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
