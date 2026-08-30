import type { routine as routineSchema } from "@tulipfarm/schema";
import { describe, expect, test, vi } from "vitest";
import { type DryRunStep, dryRunOverlay, dryRunRoutine } from "./dry-run";
import { projectRoutineGraph } from "./graph";

const definition: routineSchema.RoutineDefinition = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "Routine",
  metadata: {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "triage",
    displayName: "Triage",
    schemaVersion: 1,
    authoredVersion: 1,
    lifecycle: "active",
  },
  spec: {
    owner: "user:owner",
    start: "Check",
    states: [
      {
        type: "branch",
        name: "Check",
        conditions: [{ condition: "true", transition: "Notify" }],
        default: { transition: "Skip" },
      },
      {
        type: "tool",
        name: "Notify",
        toolRef: { name: "slack", version: "1" },
        action: "post",
        end: true,
      },
      { type: "compute", name: "Skip", input: {}, end: true },
    ],
  },
};

const graph = projectRoutineGraph(definition, [{ slug: "triage-manual", type: "manual" }]);

const steps: DryRunStep[] = [
  { stateName: "Check", type: "branch", next: { kind: "transition", target: "Notify" } },
  { stateName: "Notify", type: "tool", next: { kind: "end" } },
];

describe("dryRunOverlay", () => {
  test("marks only the states the simulation actually walked", () => {
    const overlay = dryRunOverlay(graph, steps);
    expect(overlay.nodes["state:Check"]?.status).toBe("completed");
    expect(overlay.nodes["state:Notify"]?.status).toBe("completed");
    expect(overlay.nodes["state:Skip"]).toBeUndefined();
  });

  test("lights the branch arm that was taken and leaves the other dark", () => {
    const overlay = dryRunOverlay(graph, steps);
    const taken = graph.edges.find(
      (edge) => edge.source === "state:Check" && edge.target === "state:Notify"
    );
    const skipped = graph.edges.find(
      (edge) => edge.source === "state:Check" && edge.target === "state:Skip"
    );
    expect(taken && overlay.edges[taken.id]).toBeTruthy();
    expect(skipped && overlay.edges[skipped.id]).toBeFalsy();
  });

  test("a step naming a state the graph does not have is ignored, not thrown", () => {
    expect(() =>
      dryRunOverlay(graph, [{ stateName: "Ghost", type: "compute", next: { kind: "end" } }])
    ).not.toThrow();
  });

  test("an empty simulation paints nothing", () => {
    const overlay = dryRunOverlay(graph, []);
    expect(Object.keys(overlay.nodes)).toHaveLength(0);
  });
});

describe("dryRunRoutine", () => {
  const response = {
    risk: "high" as const,
    resultHash: "sha256:result",
    stubbedStates: ["Notify"],
    steps,
    effects: [
      {
        stateName: "Notify",
        toolRef: "slack",
        action: "post",
        dispatched: false as const,
        secretLeased: false as const,
      },
    ],
  };

  test("posts the caller's inputs to the routine's own dry-run route", async () => {
    const post = vi.fn(async () => response);
    await dryRunRoutine("triage", { issueId: "7" }, { post, now: () => 0 });
    expect(post).toHaveBeenCalledWith("/api/v1/routines/triage/dry-run", {
      inputs: { issueId: "7" },
    });
  });

  /*
   * A body carrying an empty `inputs` is not the same request as one carrying none: the routine's
   * own `spec.input` schema may reject `{}` where it accepts absence.
   */
  test("omits inputs entirely when the caller supplied none", async () => {
    const post = vi.fn(async () => response);
    await dryRunRoutine("triage", {}, { post, now: () => 0 });
    expect(post).toHaveBeenCalledWith("/api/v1/routines/triage/dry-run", {});
  });

  test("carries the kernel's own not-dispatched flags through untouched", async () => {
    const result = await dryRunRoutine("triage", {}, { post: async () => response, now: () => 0 });
    expect(result.effects[0]).toMatchObject({ dispatched: false, secretLeased: false });
    expect(result.resultHash).toBe("sha256:result");
  });

  test("a refusal reaches the caller rather than becoming an empty result", async () => {
    await expect(
      dryRunRoutine(
        "triage",
        {},
        {
          post: async () => {
            throw new Error("forbidden");
          },
        }
      )
    ).rejects.toThrow(/forbidden/);
  });
});
