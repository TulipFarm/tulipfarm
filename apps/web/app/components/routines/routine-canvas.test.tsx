import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RoutineGraph } from "~/lib/routines/graph";
import type { RunOverlay } from "~/lib/routines/run-overlay";
import { RoutineCanvas } from "./routine-canvas";
import { RoutineRunCanvas } from "./routine-run-canvas";

const graph: RoutineGraph = {
  nodes: [
    { id: "trigger:0", kind: "trigger", label: "Manual Trigger" },
    {
      id: "state:Start",
      kind: "state",
      label: "Start",
      stateType: "operation",
      actions: [{ name: "Send", function: "send", arguments: ["count"] }],
    },
    { id: "end", kind: "end", label: "End" },
  ],
  edges: [
    { id: "start:0", source: "trigger:0", target: "state:Start", kind: "start", label: "Starts" },
    {
      id: "condition:Start:0",
      source: "state:Start",
      target: "end",
      kind: "condition",
      label: "Condition 1",
    },
  ],
};

const overlay: RunOverlay = {
  lastSeq: 4,
  nodes: {
    "trigger:0": { status: "completed", exact: true },
    "state:Start": {
      status: "failed",
      input: { amount: 4 },
      output: { amount: 8 },
      error: { name: "bad_input", message: "No" },
      attempts: 2,
      startedAt: "2026-07-19T00:00:01.000Z",
      completedAt: "2026-07-19T00:00:03.000Z",
    },
  },
  edges: {
    "start:0": { status: "taken", exact: true },
    "condition:Start:0": { status: "taken", inferred: true, label: "Inferred from legacy Run" },
  },
};

describe("RoutineCanvas", () => {
  it.each(["{Enter}", " "])("exposes graph names and selects with %s", async (key) => {
    const user = userEvent.setup();
    render(<RoutineCanvas graph={graph} mode="read" />);

    expect(screen.getByRole("button", { name: /State Start/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Trigger 0, Manual/ })).toBeInTheDocument();
    expect(screen.getByLabelText(/Condition 1 from Start to End/)).toBeInTheDocument();
    expect(screen.getByText("send(count)")).toBeInTheDocument();
    // The canvas toolbar precedes the graph, so keyboard focus meets it first.
    await user.tab();
    expect(screen.getByRole("button", { name: /expand canvas/i })).toHaveFocus();
    await user.tab();
    await user.keyboard(key);
    expect(screen.getByRole("complementary", { name: /details/i })).toBeInTheDocument();
  });

  it("names each kind of path in a key rather than by colour alone", () => {
    render(<RoutineCanvas graph={graph} mode="read" />);
    expect(screen.getByText("A trigger starts the routine here")).toBeInTheDocument();
    expect(screen.getByText("Taken when a test passes")).toBeInTheDocument();
  });

  it("expands and shrinks the canvas", async () => {
    const user = userEvent.setup();
    render(<RoutineCanvas graph={graph} mode="read" />);
    const toggle = screen.getByRole("button", { name: /expand canvas/i });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle);
    expect(screen.getByRole("button", { name: /shrink canvas/i })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("shows Run data and exposes inferred identity with text, not color alone", async () => {
    render(<RoutineRunCanvas graph={graph} overlay={overlay} events={[]} />);

    const user = userEvent.setup();
    const state = screen.getByRole("button", { name: /Start.*failed/i });
    await user.click(state);
    expect(screen.getByText(/"amount": 4/)).toBeInTheDocument();
    expect(screen.getByText(/"amount": 8/)).toBeInTheDocument();
    expect(screen.getByText(/bad_input.*No/)).toBeInTheDocument();
    expect(screen.getByText(/2 attempts/)).toBeInTheDocument();
    expect(screen.getByText(/00:00:01.*00:00:03/)).toBeInTheDocument();
    const inferredEdge = screen.getByLabelText(/Inferred from legacy Run/);
    expect(inferredEdge).toBeInTheDocument();
    expect(inferredEdge).toHaveAttribute("title", "Inferred from legacy Run");
  });

  it.each([
    [false, true],
    [true, false],
  ])("maps reduced motion %s to animation %s", (reduced, animated) => {
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: reduced && query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    render(<RoutineRunCanvas graph={graph} overlay={overlay} events={[]} />);
    expect(Boolean(document.querySelector("[data-animated='true']"))).toBe(animated);
  });
});
