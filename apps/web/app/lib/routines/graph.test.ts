import type { RoutineDefinition } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { layoutRoutineGraph, projectRoutineGraph } from "./graph";

const definition: RoutineDefinition = {
  id: "route-fixture",
  version: "1",
  start: "Branch",
  "x-triggers": [{ type: "manual" }, { type: "manual" }],
  functions: [{ name: "send", operation: "tool:record_create" }],
  states: [
    {
      name: "Branch",
      type: "switch",
      dataConditions: [
        { condition: "context.a", transition: "Worker" },
        { condition: "context.b", transition: "Worker" },
      ],
      defaultCondition: { end: true },
    },
    {
      name: "Worker",
      type: "operation",
      actions: [{ name: "Send", functionRef: { refName: "send", arguments: { count: 1 } } }],
      onErrors: [
        { errorRef: "timeout", transition: "Done" },
        { errorRef: "*", end: true },
      ],
      transition: "Done",
    },
    { name: "Done", type: "inject", data: { ok: true }, end: true },
  ],
};

describe("projectRoutineGraph", () => {
  it("projects every typed route with stable IDs and one synthetic End", () => {
    const graph = projectRoutineGraph(definition);

    expect(graph.nodes.map(({ id, kind, label }) => ({ id, kind, label }))).toEqual([
      { id: "trigger:0", kind: "trigger", label: "Manual Trigger" },
      { id: "trigger:1", kind: "trigger", label: "Manual Trigger" },
      { id: "state:Branch", kind: "state", label: "Branch" },
      { id: "state:Worker", kind: "state", label: "Worker" },
      { id: "state:Done", kind: "state", label: "Done" },
      { id: "end", kind: "end", label: "End" },
    ]);
    expect(
      graph.edges.map(({ id, source, target, kind }) => ({ id, source, target, kind }))
    ).toEqual([
      { id: "start:0", source: "trigger:0", target: "state:Branch", kind: "start" },
      { id: "start:1", source: "trigger:1", target: "state:Branch", kind: "start" },
      {
        id: "condition:Branch:0",
        source: "state:Branch",
        target: "state:Worker",
        kind: "condition",
      },
      {
        id: "condition:Branch:1",
        source: "state:Branch",
        target: "state:Worker",
        kind: "condition",
      },
      { id: "default:Branch", source: "state:Branch", target: "end", kind: "default" },
      { id: "transition:Worker", source: "state:Worker", target: "state:Done", kind: "transition" },
      { id: "error:Worker:0", source: "state:Worker", target: "state:Done", kind: "error" },
      { id: "error:Worker:1", source: "state:Worker", target: "end", kind: "error" },
      { id: "end:Done", source: "state:Done", target: "end", kind: "end" },
    ]);
    expect(graph.edges.map((edge) => edge.label).join(" | ")).toBe(
      "Starts | Starts | context.a | context.b | Default | Next | timeout | * | End"
    );
    expect(graph.nodes.find((node) => node.id === "state:Worker")?.actions).toEqual([
      { name: "Send", function: "send", arguments: ["count"] },
    ]);
  });

  it("lays out deterministically without mutating its projection", () => {
    const graph = projectRoutineGraph(definition);
    const before = structuredClone(graph);
    const first = layoutRoutineGraph(graph);
    const second = layoutRoutineGraph(graph);

    expect(first).toEqual(second);
    expect(graph).toEqual(before);
    expect(first.nodes.every((node) => Number.isFinite(node.position.x))).toBe(true);
    expect(first.nodes.every((node) => Number.isFinite(node.position.y))).toBe(true);
  });
});
