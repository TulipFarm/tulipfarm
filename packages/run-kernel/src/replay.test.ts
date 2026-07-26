import type { routine as routineSchema } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import {
  diffSimulation,
  LIVE_REPLAY_GRANT,
  MAX_EFFECT_IDENTITY_AGE_MS,
  planReplay,
  type RecordedRun,
  type ReplayAuthorization,
  ReplayError,
} from "./replay";
import { compileRoutine, type IdentityCeiling } from "./routine/compiler";
import { type SimulationFixture, simulateRoutine } from "./simulate";

const identityCeiling: IdentityCeiling = {
  principalKind: "service",
  principalId: "triage-bot",
  grants: ["github:issues:write"],
  maxRiskClass: "low",
};

const states: routineSchema.RoutineState[] = [
  {
    type: "agent",
    name: "Classify",
    agentRef: { name: "triage", version: "1.0.0" },
    input: { issue: `\${ input.issueId }` },
    transition: "Label",
  },
  {
    type: "tool",
    name: "Label",
    toolRef: { name: "github", version: "2.0.0" },
    action: "issues.addLabels",
    credentialRef: "github-app",
    input: { label: `\${ states.Classify.output.label }` },
    end: true,
  },
];

const routine = compileRoutine(
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
    spec: { owner: "platform", start: "Classify", states },
  } as routineSchema.RoutineDefinition,
  { identityCeiling }
);

const NOW = Date.UTC(2026, 6, 25, 12, 0, 0);

const fixture: SimulationFixture = {
  startedAtMs: Date.UTC(2026, 6, 25, 10, 0, 0),
  tickMs: 1_000,
  input: { issueId: 42 },
  model: { Classify: { label: "bug" } },
  tools: { Label: { applied: true } },
  events: {},
};

function recorded(overrides: Partial<RecordedRun> = {}): RecordedRun {
  const baseline = simulateRoutine(routine, fixture);
  return {
    runId: "run-1",
    status: "succeeded",
    routine: {
      slug: routine.slug,
      authoredVersion: routine.authoredVersion,
      digest: routine.digest,
    },
    fixture,
    steps: baseline.steps.map((step) => ({
      stateName: step.stateName,
      outputHash: step.outputHash,
    })),
    ...overrides,
  };
}

function authorization(overrides: Partial<ReplayAuthorization> = {}): ReplayAuthorization {
  return {
    grants: [LIVE_REPLAY_GRANT],
    approvedByPrincipalId: "owner-1",
    effectIdentity: {
      principalKind: "service",
      principalId: "triage-bot",
      issuedAtMs: NOW - 60_000,
    },
    ...overrides,
  };
}

describe("planReplay", () => {
  it("replays into a new simulation Run by default", () => {
    const plan = planReplay(recorded(), routine, {}, NOW);

    expect(plan.mode).toBe("simulation");
    expect(plan.dispatch).toBe(false);
    if (plan.mode !== "simulation") throw new Error("expected a simulation plan");
    expect(plan.result.effects.every((effect) => effect.dispatched === false)).toBe(true);
    expect(plan.diff.identical).toBe(true);
  });

  it("reports the states whose simulated output no longer matches the recorded Run", () => {
    const drifted = recorded({
      fixture: { ...fixture, model: { Classify: { label: "feature" } } },
    });

    const plan = planReplay(drifted, routine, {}, NOW);
    if (plan.mode !== "simulation") throw new Error("expected a simulation plan");

    expect(plan.diff.identical).toBe(false);
    expect(plan.diff.states).toEqual([{ stateName: "Classify", change: "output_changed" }]);
  });

  it("refuses a live replay that carries no authorization", () => {
    expect(() => planReplay(recorded(), routine, { mode: "live" }, NOW)).toThrow(
      new ReplayError("live_replay_not_authorized", "run-1")
    );
  });

  it("refuses a live replay whose caller lacks the live-replay grant", () => {
    const request = { mode: "live" as const, authorization: authorization({ grants: [] }) };

    expect(() => planReplay(recorded(), routine, request, NOW)).toThrow(
      new ReplayError("live_replay_not_authorized", "run-1")
    );
  });

  it("refuses a live replay that reuses a stale effect identity", () => {
    const stale = authorization({
      effectIdentity: {
        principalKind: "service",
        principalId: "triage-bot",
        issuedAtMs: NOW - MAX_EFFECT_IDENTITY_AGE_MS - 1,
      },
    });

    expect(() =>
      planReplay(recorded(), routine, { mode: "live", authorization: stale }, NOW)
    ).toThrow(new ReplayError("stale_effect_identity", "run-1"));
  });

  it("authorizes a live replay under a fresh effect identity", () => {
    const plan = planReplay(
      recorded(),
      routine,
      { mode: "live", authorization: authorization() },
      NOW
    );

    expect(plan.mode).toBe("live");
    expect(plan.dispatch).toBe(true);
    if (plan.mode !== "live") throw new Error("expected a live plan");
    expect(plan.effectIdentity).toEqual({
      principalKind: "service",
      principalId: "triage-bot",
      issuedAtMs: NOW - 60_000,
    });
    expect(plan.input).toEqual({ issueId: 42 });
  });

  it("refuses to replay a Run that has not finished", () => {
    expect(() => planReplay(recorded({ status: "running" }), routine, {}, NOW)).toThrow(
      new ReplayError("replay_not_eligible", "run-1")
    );
  });

  it("flags a replay compiled against a different Routine version", () => {
    const older = recorded({
      routine: { slug: routine.slug, authoredVersion: 3, digest: "sha256:stale" },
    });

    const plan = planReplay(older, routine, {}, NOW);

    expect(plan.routineChanged).toBe(true);
  });
});

describe("diffSimulation", () => {
  it("reports added and removed states, not just changed outputs", () => {
    const result = simulateRoutine(routine, fixture);
    const baseline = [
      { stateName: "Classify", outputHash: result.steps[0]?.outputHash ?? "" },
      { stateName: "Notify", outputHash: "sha256:gone" },
    ];

    expect(diffSimulation(baseline, result)).toEqual({
      identical: false,
      states: [
        { stateName: "Notify", change: "removed" },
        { stateName: "Label", change: "added" },
      ],
    });
  });
});
