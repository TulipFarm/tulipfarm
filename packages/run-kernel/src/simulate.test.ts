import type { routine as routineSchema } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { compileRoutine, type IdentityCeiling } from "./routine/compiler";
import {
  SimulationError,
  type SimulationFixture,
  simulateRoutine,
  simulationPorts,
} from "./simulate";

const identityCeiling: IdentityCeiling = {
  principalKind: "service",
  principalId: "triage-bot",
  grants: ["github:issues:write"],
  maxRiskClass: "low",
};

function compile(states: readonly routineSchema.RoutineState[], start: string) {
  return compileRoutine(
    {
      apiVersion: "tulipfarm.ai/v1",
      kind: "Routine",
      metadata: {
        id: "01J0000000000000000000ROUT",
        slug: "issue-triage",
        schemaVersion: 1,
        authoredVersion: 4,
        lifecycle: "published",
      },
      spec: { owner: "platform", start, states: [...states] },
    } as routineSchema.RoutineDefinition,
    { identityCeiling }
  );
}

const classify: routineSchema.RoutineState = {
  type: "agent",
  name: "Classify",
  agentRef: { name: "triage", version: "1.0.0" },
  input: { issue: `\${ input.issueId }` },
  transition: "Label",
};

const label: routineSchema.RoutineState = {
  type: "tool",
  name: "Label",
  toolRef: { name: "github", version: "2.0.0" },
  action: "issues.addLabels",
  credentialRef: "github-app",
  input: {
    issue: `\${ input.issueId }`,
    label: `\${ states.Classify.output.label }`,
  },
  end: true,
};

/** The same Tool State, but with no reference to an upstream State's output. */
const standaloneLabel: routineSchema.RoutineState = {
  ...label,
  input: { issue: `\${ input.issueId }`, label: "bug" },
};

const routine = compile([classify, label], "Classify");

function fixture(overrides: Partial<SimulationFixture> = {}): SimulationFixture {
  return {
    startedAtMs: Date.UTC(2026, 6, 25, 10, 0, 0),
    tickMs: 1_000,
    input: { issueId: 42 },
    model: { Classify: { label: "bug" } },
    tools: { Label: { applied: true } },
    events: {},
    ...overrides,
  };
}

describe("simulateRoutine", () => {
  it("walks the graph on fixture model and Tool results without dispatching an effect", () => {
    const result = simulateRoutine(routine, fixture());

    expect(result.mode).toBe("simulation");
    expect(result.status).toBe("completed");
    expect(result.steps.map((step) => step.stateName)).toEqual(["Classify", "Label"]);
    expect(result.steps[0]?.source).toBe("model");
    expect(result.steps[1]?.source).toBe("tool");
    expect(result.effects).toHaveLength(1);
    expect(result.effects[0]).toMatchObject({
      stateName: "Label",
      toolRef: "github@2.0.0",
      action: "issues.addLabels",
      credentialRef: "github-app",
      dispatched: false,
      secretLeased: false,
    });
  });

  it("previews the effect input the Routine actually resolved", () => {
    const [effect] = simulateRoutine(routine, fixture()).effects;

    expect(effect?.input).toEqual({ issue: 42, label: "bug" });
    expect(effect?.identity).toEqual({ principalKind: "service", principalId: "triage-bot" });
  });

  it("produces an identical result hash for the same fixture", () => {
    expect(simulateRoutine(routine, fixture()).resultHash).toBe(
      simulateRoutine(routine, fixture()).resultHash
    );
  });

  it("produces a different result hash when the fixture changes", () => {
    const other = fixture({ model: { Classify: { label: "feature" } } });

    expect(simulateRoutine(routine, other).resultHash).not.toBe(
      simulateRoutine(routine, fixture()).resultHash
    );
  });

  it("advances only the fixture clock", () => {
    const result = simulateRoutine(routine, fixture());

    expect(result.steps.map((step) => step.atMs)).toEqual([
      Date.UTC(2026, 6, 25, 10, 0, 0),
      Date.UTC(2026, 6, 25, 10, 0, 1),
    ]);
    expect(result.endedAtMs).toBe(Date.UTC(2026, 6, 25, 10, 0, 2));
  });

  it("resolves a branch from the simulated State outputs", () => {
    const graph = compile(
      [
        { ...classify, transition: "Decide" },
        {
          type: "branch",
          name: "Decide",
          conditions: [{ condition: 'states.Classify.output.label == "bug"', transition: "Label" }],
          default: { end: true },
        },
        label,
      ],
      "Classify"
    );

    const result = simulateRoutine(graph, fixture());

    expect(result.steps.map((step) => step.stateName)).toEqual(["Classify", "Decide", "Label"]);
    expect(result.steps[1]?.source).toBe("evaluated");
  });

  it("consumes a fixture event instead of waiting for a live one", () => {
    const graph = compile(
      [
        {
          type: "approval",
          name: "Approve",
          approverRoles: ["owner"],
          transition: "Label",
        },
        standaloneLabel,
      ],
      "Approve"
    );

    const result = simulateRoutine(
      graph,
      fixture({ events: { Approve: { decision: "approved" } } })
    );

    expect(result.steps[0]).toMatchObject({ stateName: "Approve", source: "event" });
    expect(result.outputs.Approve).toEqual({ decision: "approved" });
  });

  it("fails closed when the fixture does not cover a State", () => {
    expect(() => simulateRoutine(routine, fixture({ tools: {} }))).toThrow(
      new SimulationError("fixture_missing", "Label")
    );
  });

  it("refuses to simulate a State type it cannot execute deterministically", () => {
    const graph = compile(
      [
        {
          type: "parallel",
          name: "Fan",
          branches: ["Label"],
          maxConcurrency: 1,
          transition: "Label",
        },
        standaloneLabel,
      ],
      "Fan"
    );

    expect(() => simulateRoutine(graph, fixture())).toThrow(
      new SimulationError("state_not_simulable", "Fan")
    );
  });

  it("stops at the step budget instead of running unbounded", () => {
    expect(() => simulateRoutine(routine, fixture(), { maxSteps: 1 })).toThrow(
      new SimulationError("step_budget_exceeded", "Label")
    );
  });

  it("denies every live capability a simulated Run might reach for", () => {
    const ports = simulationPorts();

    expect(() => ports.leaseSecret("github-app")).toThrow(
      new SimulationError("secret_lease_denied", "github-app")
    );
    expect(() => ports.dispatchEffect("github@2.0.0")).toThrow(
      new SimulationError("effect_dispatch_denied", "github@2.0.0")
    );
  });

  it("keeps the effect preview idempotency key stable across identical simulations", () => {
    const first = simulateRoutine(routine, fixture()).effects[0]?.idempotencyKey;
    const second = simulateRoutine(routine, fixture()).effects[0]?.idempotencyKey;

    expect(first).toBe(second);
    expect(first).toEqual(expect.any(String));
  });
});
