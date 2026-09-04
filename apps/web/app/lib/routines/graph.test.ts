import type { routine } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { layoutRoutineGraph, projectRoutineGraph, type RoutineGraphTrigger } from "./graph";

const definition: routine.RoutineDefinition = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "Routine",
  metadata: {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "route-fixture",
    displayName: "Route fixture",
    schemaVersion: 1,
    authoredVersion: 1,
    lifecycle: "active",
  },
  spec: {
    owner: "user:owner",
    start: "Branch",
    states: [
      {
        type: "branch",
        name: "Branch",
        conditions: [
          { condition: "context.a", transition: "Worker" },
          { condition: "context.b", transition: "Worker" },
        ],
        default: { end: true },
      },
      {
        type: "tool",
        name: "Worker",
        toolRef: { name: "records", version: "1" },
        action: "record_create",
        destination: "quote",
        onError: [
          { errorRef: "timeout", transition: "Done" },
          { errorRef: "*", end: true },
        ],
        transition: "Done",
      },
      {
        type: "agent",
        name: "Done",
        agentRef: { name: "assistant", version: "1" },
        end: true,
      },
    ],
  },
};

const triggers: RoutineGraphTrigger[] = [
  { slug: "route-fixture-manual", type: "manual" },
  { slug: "route-fixture-schedule", type: "schedule" },
];

describe("projectRoutineGraph", () => {
  it("projects every typed route with stable IDs and one synthetic End", () => {
    const graph = projectRoutineGraph(definition, triggers);

    expect(graph.nodes.map(({ id, kind, label }) => ({ id, kind, label }))).toEqual([
      { id: "trigger:route-fixture-manual", kind: "trigger", label: "Manual Trigger" },
      { id: "trigger:route-fixture-schedule", kind: "trigger", label: "Schedule Trigger" },
      { id: "state:Branch", kind: "state", label: "Branch" },
      { id: "state:Worker", kind: "state", label: "Worker" },
      { id: "state:Done", kind: "state", label: "Done" },
      { id: "end", kind: "end", label: "End" },
    ]);
    expect(
      graph.edges.map(({ id, source, target, kind }) => ({ id, source, target, kind }))
    ).toEqual([
      {
        id: "start:route-fixture-manual",
        source: "trigger:route-fixture-manual",
        target: "state:Branch",
        kind: "start",
      },
      {
        id: "start:route-fixture-schedule",
        source: "trigger:route-fixture-schedule",
        target: "state:Branch",
        kind: "start",
      },
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
      { name: "record_create", function: "records.record_create", arguments: ["quote"] },
    ]);
  });

  it("names a compute State by the fields it assigns, since it has no ref to show", () => {
    const graph = projectRoutineGraph({
      ...definition,
      spec: {
        ...definition.spec,
        start: "Derive",
        states: [
          {
            type: "compute",
            name: "Derive",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: routine placeholders are data here.
            input: { label: "need-triage", issue: "${ input.issueId }" },
            end: true,
          },
        ] as unknown as routine.RoutineDefinition["spec"]["states"],
      },
    });

    expect(graph.nodes.find((node) => node.id === "state:Derive")).toMatchObject({
      stateType: "compute",
      actions: [{ name: "compute", function: "compute", arguments: ["issue", "label"] }],
    });
    expect(graph.edges).toContainEqual({
      id: "end:Derive",
      source: "state:Derive",
      target: "end",
      kind: "end",
      label: "End",
    });
  });

  it("reaches a contained body State that no transition names", () => {
    const graph = projectRoutineGraph(
      {
        ...definition,
        spec: {
          ...definition.spec,
          start: "Loop",
          states: [
            {
              type: "foreach",
              name: "Loop",
              items: "context.items",
              body: "Done",
              maxItems: 10,
              maxConcurrency: 1,
              end: true,
            },
            {
              type: "agent",
              name: "Done",
              agentRef: { name: "assistant", version: "1" },
              end: true,
            },
          ],
        },
      },
      triggers
    );

    expect(graph.edges.map((edge) => edge.id)).toContain("body:Loop");
  });

  it("lays out deterministically without mutating its projection", () => {
    const graph = projectRoutineGraph(definition, triggers);
    const before = structuredClone(graph);
    const first = layoutRoutineGraph(graph);
    const second = layoutRoutineGraph(graph);

    expect(first).toEqual(second);
    expect(graph).toEqual(before);
    expect(first.nodes.every((node) => Number.isFinite(node.position.x))).toBe(true);
    expect(first.nodes.every((node) => Number.isFinite(node.position.y))).toBe(true);
  });
});
