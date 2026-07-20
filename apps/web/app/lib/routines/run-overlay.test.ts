import { describe, expect, it } from "vitest";
import type { RoutineGraph } from "./graph";
import { reduceRunOverlay } from "./run-overlay";

const graph: RoutineGraph = {
  nodes: [
    { id: "trigger:0", kind: "trigger", label: "Manual Trigger" },
    { id: "state:A", kind: "state", label: "A", stateType: "operation", actions: [] },
    { id: "state:B", kind: "state", label: "B", stateType: "inject", actions: [] },
    { id: "end", kind: "end", label: "End" },
  ],
  edges: [
    { id: "start:0", source: "trigger:0", target: "state:A", kind: "start", label: "Starts" },
    { id: "condition:A:0", source: "state:A", target: "state:B", kind: "condition", label: "1" },
    { id: "condition:A:1", source: "state:A", target: "state:B", kind: "condition", label: "2" },
    { id: "error:A:0", source: "state:A", target: "state:B", kind: "error", label: "timeout" },
    { id: "end:B", source: "state:B", target: "end", kind: "end", label: "End" },
  ],
};

const event = (seq: number, type: string, payload: Record<string, unknown>, second = seq) => ({
  seq,
  type,
  payload,
  createdAt: `2026-07-19T00:00:${String(second).padStart(2, "0")}.000Z`,
});

describe("reduceRunOverlay", () => {
  it("folds explicit identity, State data, duration, retry, sleep, Approval, and failure", () => {
    const events = [
      event(1, "run.started", { triggerIndex: 0 }),
      event(2, "state.entered", { state: "A", input: { amount: 4 }, attempt: 1 }),
      event(3, "state.retrying", { state: "A", attempt: 1, error: { name: "timeout" } }),
      event(4, "state.completed", { state: "A", output: { amount: 8 } }, 7),
      event(5, "state.transitioned", {
        source: "A",
        target: "B",
        route: { kind: "condition", index: 1 },
      }),
      event(6, "run.sleeping", { state: "B", wakeAt: "2026-07-20T00:00:00Z" }),
      event(7, "run.waiting_approval", { state: "B", approvalId: "approval-1" }),
      event(8, "error", { state: "B", error: { name: "denied", message: "No" } }),
      event(8, "error", { state: "B", error: { name: "duplicate" } }),
    ];
    const overlay = reduceRunOverlay(graph, events);

    expect(overlay.lastSeq).toBe(8);
    expect(overlay.nodes["trigger:0"]).toMatchObject({ status: "completed", exact: true });
    expect(overlay.nodes["state:A"]).toMatchObject({
      status: "completed",
      input: { amount: 4 },
      output: { amount: 8 },
      attempts: 1,
      durationMs: 5000,
    });
    expect(overlay.nodes["state:B"]).toMatchObject({ status: "failed", error: { name: "denied" } });
    expect(overlay.edges["start:0"]).toMatchObject({ status: "taken", exact: true });
    expect(overlay.edges["condition:A:1"]).toMatchObject({ status: "taken", exact: true });
    expect(overlay.edges["condition:A:0"]).toBeUndefined();
  });

  it.each([
    ["state.retrying", "retrying"],
    ["run.sleeping", "sleeping"],
    ["run.waiting_approval", "waiting_approval"],
  ])("represents intermediate %s status", (type, status) => {
    const overlay = reduceRunOverlay(graph, [event(1, type, { state: "A" })]);
    expect(overlay.nodes["state:A"]).toMatchObject({ status });
  });

  it("selects handled-error and explicit terminal routes", () => {
    const overlay = reduceRunOverlay(graph, [
      event(1, "state.transitioned", {
        source: "A",
        target: "B",
        route: { kind: "error", index: 0, error: { name: "timeout" } },
      }),
      event(2, "state.transitioned", { source: "B", end: true, route: { kind: "end" } }),
    ]);
    expect(overlay.edges["error:A:0"]).toMatchObject({ exact: true });
    expect(overlay.edges["end:B"]).toMatchObject({ exact: true });
  });

  it("restores a sleeping source to completed when its target State enters", () => {
    const overlay = reduceRunOverlay(graph, [
      event(1, "state.entered", { state: "A", input: {} }),
      event(2, "state.completed", { state: "A", output: {} }),
      event(3, "state.transitioned", {
        source: "A",
        target: "B",
        route: { kind: "condition", index: 0 },
      }),
      event(4, "run.sleeping", { state: "A" }),
      event(5, "finish", { reason: "suspended" }),
      event(6, "state.entered", { state: "B", input: {} }),
    ]);
    expect(overlay.nodes["state:A"]).toMatchObject({ status: "completed" });
    expect(overlay.nodes["state:B"]).toMatchObject({ status: "running" });
  });

  it("restores Sleep End on terminal completion without weakening exact End identity", () => {
    const overlay = reduceRunOverlay(graph, [
      event(1, "state.entered", { state: "B", input: {} }),
      event(2, "state.completed", { state: "B", output: {} }),
      event(3, "state.transitioned", { source: "B", end: true, route: { kind: "end" } }),
      event(4, "run.sleeping", { state: "B" }),
      event(5, "finish", { reason: "suspended" }),
      event(6, "finish", { reason: "completed" }),
    ]);
    expect(overlay.nodes["state:B"]).toMatchObject({ status: "completed" });
    expect(overlay.nodes.end).toMatchObject({ status: "completed", exact: true });
  });

  it("ignores contradictory explicit route evidence without inferring another edge", () => {
    const overlay = reduceRunOverlay(graph, [
      event(1, "state.entered", { state: "A", input: {} }),
      event(2, "state.transitioned", {
        source: "A",
        target: "B",
        route: { kind: "condition", index: 99 },
      }),
      event(3, "state.entered", { state: "B", input: {} }),
    ]);
    expect(overlay.edges).toEqual({});
  });

  it("marks one or every legacy candidate as inferred without inventing missing evidence", () => {
    const one = reduceRunOverlay(graph, [
      event(1, "run.started", { trigger: { type: "manual" } }),
      event(3, "state.entered", { state: "A", input: {} }),
      event(4, "state.entered", { state: "B", input: {} }),
      event(5, "state.completed", { state: "B", output: {} }),
      event(6, "finish", { reason: "completed" }),
    ]);

    expect(one.nodes["trigger:0"]).toMatchObject({
      inferred: true,
      label: "Inferred from legacy Run",
    });
    expect(one.edges["condition:A:0"]).toMatchObject({ inferred: true });
    expect(one.edges["condition:A:1"]).toMatchObject({ inferred: true });
    expect(one.edges["end:B"]).toMatchObject({ inferred: true });
    const ambiguousGraph = structuredClone(graph);
    ambiguousGraph.nodes.push({ ...graph.nodes[0], id: "trigger:1" });
    ambiguousGraph.edges.push({ ...graph.edges[0], id: "start:1", source: "trigger:1" });
    const ambiguous = reduceRunOverlay(ambiguousGraph, [
      event(1, "run.started", { trigger: { type: "manual" } }),
    ]);
    expect(ambiguous.nodes["trigger:0"]).toMatchObject({ inferred: true });
    expect(ambiguous.nodes["trigger:1"]).toMatchObject({ inferred: true });
    expect(reduceRunOverlay(graph, [event(2, "unknown", {})]).edges).toEqual({});
  });
});
