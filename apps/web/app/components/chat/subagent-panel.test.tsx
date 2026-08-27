import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TimelinePart } from "~/lib/chat/types";
import { SubagentPanel, traceOf } from "./subagent-panel";

type ToolPart = Extract<TimelinePart, { kind: "tool" }>;

function part(overrides: Partial<ToolPart> = {}): ToolPart {
  return {
    kind: "tool",
    toolCallId: "call-1",
    toolName: "spawn_subagent",
    status: "done",
    args: {
      name: "Summarizer",
      instructions: "Answer in one sentence.",
      task: "Summarize the incident.",
    },
    result: { success: true, data: { status: "succeeded", answer: "All clear." } },
    ...overrides,
  } as ToolPart;
}

describe("traceOf", () => {
  it("reads nothing from a step that spawned no helper", () => {
    expect(traceOf(part({ toolName: "record_list" }))).toBeUndefined();
  });

  it("prefers the redacted preview over the raw arguments beside it", () => {
    const trace = traceOf(
      part({
        args: { name: "Summarizer", task: "Check card 4111111111111111." },
        argsPreview: { json: JSON.stringify({ name: "Summarizer", task: "Check card ***." }) },
      } as Partial<ToolPart>)
    );

    // Reading the raw value would undo whatever the guard took out of the preview.
    expect(trace?.task).toBe("Check card ***.");
  });

  it("reads the answer out of the tool result envelope", () => {
    expect(traceOf(part())?.answer).toBe("All clear.");
  });

  it("survives an unparseable preview by falling back to the value", () => {
    const trace = traceOf(part({ argsPreview: { json: "{not json" } } as Partial<ToolPart>));

    expect(trace?.name).toBe("Summarizer");
  });
});

describe("SubagentPanel", () => {
  it("shows what the helper was told and what it answered", () => {
    render(<SubagentPanel part={part()} />);

    expect(screen.getByText("Summarizer")).toBeTruthy();
    expect(screen.getByText("Answer in one sentence.")).toBeTruthy();
    expect(screen.getByText("Summarize the incident.")).toBeTruthy();
    expect(screen.getByText("All clear.")).toBeTruthy();
  });

  it("says the instructions were written by an agent, not a person", () => {
    render(<SubagentPanel part={part()} />);

    // For a Soul-defined helper a person wrote these and can be asked about them; here nobody did,
    // and that is the fact a reader is least likely to assume.
    expect(screen.getByText("agent-written helper")).toBeTruthy();
  });

  it("says a helper held no tools rather than staying silent about it", () => {
    render(<SubagentPanel part={part()} />);

    expect(screen.getByText("No tools: reasoning only")).toBeTruthy();
  });

  it("names the tools a helper was given", () => {
    const p = part({
      args: {
        name: "Summarizer",
        instructions: "i",
        task: "t",
        toolNames: ["record_list", "record_search"],
      },
    } as Partial<ToolPart>);

    render(<SubagentPanel part={p} />);

    expect(screen.getByText("record_list, record_search")).toBeTruthy();
  });

  it("reports a helper that did not finish instead of showing an empty answer", () => {
    const p = part({ result: { success: true, data: { status: "failed", answer: null } } });

    render(<SubagentPanel part={p} />);

    expect(screen.getByText("Did not finish")).toBeTruthy();
  });

  it("renders nothing for a step that spawned no helper", () => {
    const { container } = render(<SubagentPanel part={part({ toolName: "record_list" })} />);

    expect(container.firstChild).toBeNull();
  });

  it("still shows the persona while the helper is running and has not answered", () => {
    const p = part({ status: "running", result: undefined });

    render(<SubagentPanel part={p} />);

    expect(screen.getByText("Summarizer")).toBeTruthy();
    expect(screen.queryByText("Did not finish")).toBeNull();
  });
});
