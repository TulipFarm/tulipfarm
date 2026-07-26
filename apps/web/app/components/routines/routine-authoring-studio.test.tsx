import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { routine as routineSchema } from "@tulipfarm/schema";
import { describe, expect, it, vi } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { RoutineAuthoringStudio } from "./routine-authoring-studio";

const published: routineSchema.RoutineDefinition = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "Routine",
  metadata: {
    id: "00000000-0000-4000-8000-000000000001",
    slug: "daily-wait",
    displayName: "Daily wait",
    schemaVersion: 1,
    authoredVersion: 2,
    lifecycle: "published",
  },
  spec: {
    owner: "operations",
    start: "Wait",
    states: [
      {
        type: "wait",
        name: "Wait",
        waitFor: { kind: "timer", durationMs: 100 },
        end: true,
      },
    ],
  },
};

describe("RoutineAuthoringStudio", () => {
  it("keeps simple, graph, and YAML modes on the same canonical draft", async () => {
    render(<RoutineAuthoringStudio definition={published} baseCommit="base-commit" />);

    const displayName = screen.getByLabelText("Display name");
    await userEvent.clear(displayName);
    await userEvent.type(displayName, "Daily pause");
    await userEvent.click(screen.getByRole("tab", { name: "YAML" }));
    expect((screen.getByLabelText("Routine YAML") as HTMLTextAreaElement).value).toContain(
      "displayName: Daily pause"
    );
    expect((screen.getByLabelText("Routine YAML") as HTMLTextAreaElement).value).toContain(
      "authoredVersion: 3"
    );

    await userEvent.click(screen.getByRole("tab", { name: "Graph" }));
    const graph = screen.getByLabelText("Routine states");
    fireEvent.change(graph, {
      target: {
        value: JSON.stringify([
          {
            type: "wait",
            name: "Pause",
            waitFor: { kind: "timer", durationMs: 200 },
            end: true,
          },
        ]),
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "Apply graph" }));
    await userEvent.click(screen.getByRole("tab", { name: "YAML" }));
    expect((screen.getByLabelText("Routine YAML") as HTMLTextAreaElement).value).toContain(
      "name: Pause"
    );
  });

  it("shows validation, simulation, risk, Approval, and proposal state", async () => {
    const analyze = vi.fn(async () => ({
      yaml: stringifyYaml(published),
      validationState: "valid" as const,
      risk: "medium" as const,
      approval: "required" as const,
      publicationState: "draft" as const,
      simulation: {
        status: "completed" as const,
        resultHash: "a".repeat(64),
        steps: [{ stateName: "Wait" }],
        effects: [],
      },
    }));
    const propose = vi.fn(async () => ({
      changesetId: "changeset-1",
      status: "awaiting_approval" as const,
    }));
    render(
      <RoutineAuthoringStudio
        definition={published}
        baseCommit="base-commit"
        analyze={analyze}
        propose={propose}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Validate and simulate" }));
    expect(await screen.findByText("Validation: valid")).toBeInTheDocument();
    expect(screen.getByText("Risk: medium")).toBeInTheDocument();
    expect(screen.getByText("Approval: required")).toBeInTheDocument();
    expect(screen.getByText("Simulation: completed · 1 step · 0 effects")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Propose changeset" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Changeset changeset-1 is awaiting approval"
    );
    expect(propose).toHaveBeenCalledWith(
      "daily-wait",
      expect.objectContaining({
        baseCommit: "base-commit",
      })
    );
  });

  it("supports arrow-key tab navigation without motion-dependent behavior", async () => {
    render(<RoutineAuthoringStudio definition={published} baseCommit="base-commit" />);
    const simple = screen.getByRole("tab", { name: "Simple" });
    simple.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Graph" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Graph" })).toHaveAttribute("aria-selected", "true");
  });
});
